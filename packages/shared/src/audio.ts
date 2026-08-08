export type AudioEncoding = "mulaw" | "linear16";

export interface AudioFormat {
  readonly encoding: AudioEncoding;
  readonly sampleRate: number;
}

/**
 * What the carrier sends and expects back. Any transcoding hop away from this is a
 * cost worth seeing rather than absorbing (R4.2.4).
 */
export const TELEPHONY_AUDIO: AudioFormat = {
  encoding: "mulaw",
  sampleRate: 8000,
};

export interface AudioChunk {
  readonly data: Buffer;
  /**
   * Milliseconds since this call's media stream opened. The orchestrator correlates
   * transcripts against turn events on this offset, never on arrival order, because
   * the two may come from different providers on different connections (R4.1.7).
   */
  readonly offsetMs: number;
}

/**
 * G.711 mu-law to 16-bit linear PCM.
 *
 * Worth stating because it catches everyone once: mu-law is logarithmic and inverted.
 * Digital silence is 0xFF — a large byte — and 0x00 is the loudest positive sample. Any
 * arithmetic on raw mu-law bytes, energy included, measures nothing.
 *
 * Lives here rather than in a provider package because it is not vendor knowledge, and
 * two callers already need it for unrelated reasons: measuring whether the caller spoke,
 * and transcoding for a model that wants PCM. A second copy of a codec is how two copies
 * silently diverge.
 */
export const muLawToLinear = (byte: number): number => {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return sign !== 0 ? -magnitude : magnitude;
};

/**
 * Decodes mu-law and resamples to `targetRate`, emitting little-endian 16-bit PCM.
 *
 * Upsampling adds no information — audio band-limited at 3.4kHz stays band-limited
 * whatever rate carries it. The point is to hand a model trained on 24kHz PCM the format
 * it documents rather than one it merely accepts. Whether that changes anything is a
 * measurement, not an argument, which is why it sits behind a config flag (R4.2.4: any
 * transcoding hop is a cost worth seeing rather than absorbing).
 *
 * Linear interpolation, not nearest-neighbour: a zero-order hold produces a stair-step
 * whose harmonics land inside the speech band as audible buzz, and a transcriber has no
 * way of knowing that buzz is our fault.
 */
export const muLawToPcm = (frame: Buffer, fromRate: number, targetRate: number): Buffer => {
  if (frame.length === 0) return Buffer.alloc(0);

  const samples = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i += 1) samples[i] = muLawToLinear(frame[i] ?? 0xff);

  const ratio = targetRate / fromRate;
  const outLength = ratio === 1 ? samples.length : Math.round(samples.length * ratio);
  const out = Buffer.alloc(outLength * 2);

  for (let i = 0; i < outLength; i += 1) {
    const source = i / ratio;
    const left = Math.floor(source);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = source - left;
    const value = (samples[left] ?? 0) * (1 - weight) + (samples[right] ?? 0) * weight;
    // Clamped: interpolation overshoot on a full-scale sample would wrap +32767 round to
    // -32768 and produce a click.
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2);
  }

  return out;
};
