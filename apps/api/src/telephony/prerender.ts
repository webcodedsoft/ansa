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
  render(text: string, voiceId: string): Promise<readonly AudioChunk[] | null>;
}

export interface AudioCacheDeps {
  readonly tts: TtsProvider;
  readonly format: AudioFormat;
  /** Applied before synthesis, so the cache is never the one path that skips it. */
  readonly forSpeech: (text: string) => string;
  readonly log: Logger;
}

const collect = (deps: AudioCacheDeps, text: string, voiceId: string): Promise<AudioChunk[]> =>
  new Promise((resolve, reject) => {
    const chunks: AudioChunk[] = [];
    const stream = deps.tts.synthesize({
      text: deps.forSpeech(text),
      voiceId,
      format: deps.format,
    });
    stream.onAudio((chunk) => chunks.push(chunk));
    stream.onDone(() => resolve(chunks));
    stream.onError(reject);
  });

export const createAudioCache = (deps: AudioCacheDeps): AudioCache => {
  const cache = new Map<string, readonly AudioChunk[]>();

  return {
    async render(text, voiceId) {
      const key = `${voiceId}\n${text}`;
      const existing = cache.get(key);
      if (existing !== undefined) return existing;

      try {
        const chunks = await collect(deps, text, voiceId);
        cache.set(key, chunks);
        deps.log.info("pre-rendered phrase", {
          text,
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
