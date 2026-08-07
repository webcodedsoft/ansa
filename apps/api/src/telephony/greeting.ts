import type { Logger } from "@ansa/shared";
import type { CallMediaStream } from "@ansa/telephony";
import type { TtsProvider } from "@ansa/tts";

/**
 * Slice 1 speaks exactly one sentence and hangs up. This is the real greeting rather
 * than a placeholder so the phone-line test in PRD §1.0 happens on day one: does "Ansa"
 * survive 8kHz compression, and does the STT hear it when a caller says it back.
 */
export const GREETING_TEXT = "Thank you for calling Ansa.";

/**
 * The brand is "Ansa" everywhere a human reads it. TTS is handed "An-Sah" instead,
 * because the telephone channel destroys the name otherwise.
 *
 * /s/ carries most of its energy above 4kHz. The telephony passband ends near 3.4kHz and
 * μ-law discards the rest, so between a nasal and a vowel the stripped fricative is heard
 * as its voiced neighbour and callers hear "Anza". Confirmed by A/B on a real call: the
 * same sentence at pcm_24000 is a correct "Ansa", at ulaw_8000 it is not — the model is
 * right and the channel is wrong. The respelling makes the model produce a longer, harder
 * fricative, so enough survives the band-pass to be heard correctly.
 *
 * This is a normalizer rule wearing a temporary disguise. When packages/normalizer lands
 * in Slice 4 it moves there and applies to every utterance containing the name, not just
 * this greeting — CLAUDE.md: nothing reaches TTS unnormalized.
 */
const forSpeech = (text: string): string => text.replace(/\bAnsa\b/g, "An-Sah");

const GREETING_MARK = "greeting-end";

/**
 * If the carrier never returns our mark, hang up anyway. An open line playing nothing
 * reads as a dropped call, and the caller is being billed for it.
 */
const MARK_TIMEOUT_MS = 15_000;

export interface GreetingDeps {
  readonly tts: TtsProvider;
  readonly voiceId: string;
  readonly log: Logger;
  readonly markTimeoutMs?: number;
}

export const speakGreeting = (stream: CallMediaStream, deps: GreetingDeps): void => {
  const log = deps.log.child({ callId: stream.callId });
  const startedAt = Date.now();

  let finished = false;
  let firstChunk = true;

  // Declared before the timer it clears: the reference is inside a closure, so it is
  // only read once the timer exists.
  const finish = (reason: string, hangUp: boolean): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    log.info("greeting finished", { reason, ms: Date.now() - startedAt });
    if (hangUp) stream.hangUp();
  };

  const timer = setTimeout(() => {
    finish("mark never returned", true);
  }, deps.markTimeoutMs ?? MARK_TIMEOUT_MS);
  timer.unref();

  // Slice 4 inserts packages/normalizer here. Nothing reaches TTS unnormalized — this
  // greeting is only safe today because it contains no numbers, currency or dates.
  const synthesis = deps.tts.synthesize({
    text: forSpeech(GREETING_TEXT),
    voiceId: deps.voiceId,
    // Whatever the carrier opened the stream in, so there is no transcoding hop.
    format: stream.format,
  });

  synthesis.onAudio((chunk) => {
    if (firstChunk) {
      firstChunk = false;
      // Time to first byte, against the <300ms target in R4.2.3.
      log.info("tts first byte", { ms: Date.now() - startedAt });
    }
    stream.send(chunk);
  });

  synthesis.onDone(() => {
    log.info("greeting synthesised", { ms: Date.now() - startedAt });
    // Queued is not played. The mark comes back only once the caller has actually heard
    // everything before it, so hanging up on onDone would truncate the last words.
    stream.mark(GREETING_MARK);
  });

  synthesis.onError((error) => {
    log.error("greeting synthesis failed", { error: error.message });
    // Degrade into ending the call, never into an open line playing silence.
    finish("synthesis failed", true);
  });

  stream.onMark((name) => {
    if (name === GREETING_MARK) finish("caller heard the greeting", true);
  });

  stream.onClosed((reason) => {
    // The caller hung up first. Nothing left to end.
    finish(`stream closed: ${reason}`, false);
  });
};
