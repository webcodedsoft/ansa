/**
 * Only speech reaches the transcriber.
 *
 * Every provider tried so far has hallucinated fluent nonsense when fed audio containing
 * no speech, and each did it with the language pinned to English: Deepgram returned
 * Malayalam and Māori, OpenAI returned "Ay, mi nombre es Pikachu" and a sentence of
 * Japanese. Three vendors failing the same way is not three vendor bugs. It is what
 * Whisper-family models do with silence and line noise — they are trained to emit text,
 * so they emit text.
 *
 * The defence used to be at the text layer, which cannot work: "not latin script" caught
 * the Japanese and nothing at all catches "Pikachu" or "Biology is that again?". A
 * hallucination that happens to be plausible English is indistinguishable downstream.
 *
 * So the gate is here, on the audio, before the transcriber ever sees it. This also cuts
 * cost — silence is most of a call — and latency, since the model is no longer working
 * through long spans of nothing.
 */

/**
 * G.711 mu-law to linear PCM.
 *
 * Needed because mu-law is logarithmic: the byte value has no useful relationship to
 * loudness, so RMS over raw mu-law bytes measures nothing. Silence is 0xFF, which is a
 * large byte.
 */
export const muLawToLinear = (byte: number): number => {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return sign !== 0 ? -magnitude : magnitude;
};

export const frameEnergy = (frame: Buffer): number => {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const byte of frame) {
    const sample = muLawToLinear(byte);
    sum += sample * sample;
  }
  return Math.sqrt(sum / frame.length);
};

export interface SpeechGateOptions {
  /**
   * Audio kept from before speech was detected. Speech onset is always detected slightly
   * late, and without this the transcriber loses the first consonant — which on a name
   * or a policy number is the whole value.
   */
  readonly preRollMs?: number;
  /**
   * How long to keep forwarding after speech stops. Must outlast the pauses inside
   * ordinary speech, or a turn is chopped into fragments — the failure that cost a
   * caller their name.
   */
  readonly hangoverMs?: number;
  /** How far above the measured noise floor counts as speech. */
  readonly factor?: number;
  /** Floor below which nothing is speech, however quiet the line is. */
  readonly absoluteFloor?: number;
  readonly frameMs?: number;
}

export interface SpeechGate {
  /** Frames to forward. Empty while the line is quiet; a burst when speech starts. */
  push(frame: Buffer): readonly Buffer[];
  /** Whether the gate currently believes the caller is speaking. */
  readonly open: boolean;
  /** Frames dropped so far — the number that says whether this is worth its complexity. */
  readonly dropped: number;
}

export const createSpeechGate = (options: SpeechGateOptions = {}): SpeechGate => {
  const frameMs = options.frameMs ?? 20;
  const preRollFrames = Math.ceil((options.preRollMs ?? 320) / frameMs);
  const hangoverFrames = Math.ceil((options.hangoverMs ?? 700) / frameMs);
  const factor = options.factor ?? 2.5;
  const absoluteFloor = options.absoluteFloor ?? 180;

  const preRoll: Buffer[] = [];
  // Starts high so the first frames of a call cannot pin the floor to a loud value; it
  // falls fast and rises slowly, so it tracks the line rather than the speaker.
  let noiseFloor = 500;
  let quietFrames = hangoverFrames + 1;
  let dropped = 0;

  const gate: SpeechGate = {
    get open() {
      return quietFrames <= hangoverFrames;
    },
    get dropped() {
      return dropped;
    },
    push(frame) {
      const energy = frameEnergy(frame);

      // Fast down, slow up: a quiet moment re-measures the line immediately, while the
      // caller's own speech barely moves the floor.
      noiseFloor =
        energy < noiseFloor ? energy * 0.15 + noiseFloor * 0.85 : noiseFloor * 0.995 + energy * 0.005;

      const isSpeech = energy > Math.max(absoluteFloor, noiseFloor * factor);
      const wasOpen = quietFrames <= hangoverFrames;
      quietFrames = isSpeech ? 0 : quietFrames + 1;
      const isOpen = quietFrames <= hangoverFrames;

      if (!isOpen) {
        // Keep the tail of the silence: it becomes the pre-roll for the next utterance.
        preRoll.push(frame);
        while (preRoll.length > preRollFrames) preRoll.shift();
        dropped += 1;
        return [];
      }

      if (!wasOpen) {
        // Opening: flush the pre-roll so the transcriber hears the onset it missed.
        const burst = [...preRoll, frame];
        preRoll.length = 0;
        return burst;
      }

      return [frame];
    },
  };

  return gate;
};
