import type { AudioFormat, AudioChunk, Logger } from "@ansa/shared";
import type { TtsProvider } from "@ansa/tts";

/**
 * Renders fixed phrases to audio once, at boot, instead of over the network on every
 * call.
 *
 * The greeting is a compile-time constant spoken in a fixed voice at a fixed format —
 * completely deterministic — yet it cost a measured 959ms cold and 468ms warm on live
 * calls, against R4.2.3's 300ms target, at the exact moment the caller has just been
 * connected and is listening hardest.
 *
 * Chunks are cached as the array the provider produced, not concatenated into one blob:
 * the carrier adapter emits one media frame per chunk, and chunk size affects how
 * quickly clear() can cut audio off. Replaying the original sequence keeps barge-in
 * byte-identical to synthesising live.
 */
export interface AudioCache {
  /**
   * `speakingRate` is part of what is being rendered, not a detail of how.
   *
   * Two agents can share a voice and set different paces, and this cache is one map for the
   * whole process. Keyed on the voice and the words alone, the first agent to warm a phrase
   * hands its pace to every other agent saying the same phrase in the same voice. Nothing
   * about the audio looks wrong; the only symptom is a greeting running at somebody else's
   * speed, on a line nobody is listening to with a stopwatch.
   */
  render(
    text: string,
    voiceId: string,
    speakingRate: number | undefined,
  ): Promise<readonly AudioChunk[] | null>;
}

export interface AudioCacheDeps {
  readonly tts: TtsProvider;
  readonly format: AudioFormat;
  /** Applied before synthesis, so the cache is never the one path that skips it. */
  readonly forSpeech: (text: string) => string;
  readonly log: Logger;
  /**
   * How many renders may be in flight at once.
   *
   * A vendor account limit, not a tuning knob: ElevenLabs answers 429
   * `concurrent_limit_exceeded` above the subscription's ceiling, and a warm that fires
   * everything at once burns phrases that then synthesise live on every later call. Set
   * it below the account limit so a live call's own synthesis still has a slot — warming
   * must never be the reason a caller waits.
   */
  readonly maxConcurrent: number;
}

/**
 * Everything that changes the bytes, and nothing that does not.
 *
 * Exported because the gateway keeps a second map — whole voices it has warmed — and two
 * cache keys for the same thing that drift apart is how a phrase gets rendered at one pace
 * and served under another. `own` rather than an empty string so a voice at its own pace and
 * a voice at a rate that stringifies to nothing cannot collide.
 */
export const cacheKey = (voiceId: string, speakingRate: number | undefined, text: string): string =>
  `${voiceId}\n${speakingRate ?? "own"}\n${text}`;

const collect = (
  deps: AudioCacheDeps,
  text: string,
  voiceId: string,
  speakingRate: number | undefined,
): Promise<AudioChunk[]> =>
  new Promise((resolve, reject) => {
    const chunks: AudioChunk[] = [];
    const stream = deps.tts.synthesize({
      text: deps.forSpeech(text),
      voiceId,
      speakingRate,
      format: deps.format,
    });
    stream.onAudio((chunk) => chunks.push(chunk));
    stream.onDone(() => resolve(chunks));
    stream.onError(reject);
  });

export const createAudioCache = (deps: AudioCacheDeps): AudioCache => {
  const cache = new Map<string, readonly AudioChunk[]>();
  /**
   * Renders already on the wire, so the same phrase is never fetched twice.
   *
   * The gateway warms two openings for one voice, and both walk the same list of leads and
   * fillers. Without this they both miss the cache — neither has populated it yet — and
   * every phrase is synthesised, logged and billed twice. It showed up as pairs of
   * `pre-rendered phrase` lines for the same words with different byte counts.
   */
  const inFlight = new Map<string, Promise<AudioChunk[]>>();

  /* A plain counting semaphore. `collect` is the only thing it guards, so the count and
     the queue cannot drift from what is actually open. */
  let open = 0;
  const waiting: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (open < deps.maxConcurrent) {
      open += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    open += 1;
  };
  const release = (): void => {
    open -= 1;
    waiting.shift()?.();
  };

  return {
    async render(text, voiceId, speakingRate) {
      const key = cacheKey(voiceId, speakingRate, text);
      const existing = cache.get(key);
      if (existing !== undefined) return existing;

      const running = inFlight.get(key);
      if (running !== undefined) {
        try {
          return await running;
        } catch {
          // The render that owns this key logs and reports the failure. Joining it just
          // means falling back to live synthesis too.
          return null;
        }
      }

      /* Registered before the first await, not after it. Waiting for a semaphore slot is
         itself a yield, so a version that set this after `acquire()` let a second caller
         past the check above and rendered the phrase twice anyway. */
      const attempt = (async () => {
        await acquire();
        try {
          return await collect(deps, text, voiceId, speakingRate);
        } finally {
          release();
        }
      })();
      inFlight.set(key, attempt);

      try {
        const chunks = await attempt;
        cache.set(key, chunks);
        deps.log.info("pre-rendered phrase", {
          text,
          speakingRate: speakingRate ?? null,
          chunks: chunks.length,
          bytes: chunks.reduce((n, c) => n + c.data.length, 0),
        });
        return chunks;
      } catch (error: unknown) {
        // A failed render must never mean a silent answer (R6.2): the caller falls back
        // to synthesising live, which is slower but audible.
        deps.log.error("pre-render failed, will synthesise live", {
          text,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      } finally {
        inFlight.delete(key);
      }
    },
  };
};
