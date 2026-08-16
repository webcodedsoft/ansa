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

  return {
    async render(text, voiceId, speakingRate) {
      const key = cacheKey(voiceId, speakingRate, text);
      const existing = cache.get(key);
      if (existing !== undefined) return existing;

      try {
        const chunks = await collect(deps, text, voiceId, speakingRate);
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
      }
    },
  };
};
