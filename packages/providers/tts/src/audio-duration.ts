import type { AudioFormat } from "@ansa/shared";

/** Bytes per audio sample, per encoding. */
const BYTES_PER_SAMPLE: Readonly<Record<string, number>> = {
  mulaw: 1,
  linear16: 2,
};

/**
 * How many milliseconds of audio a byte count represents. Used to stamp each synthesised
 * chunk with its offset inside the utterance, which is what lets Slice 3 work out how
 * much of a turn the caller actually heard before interrupting.
 */
export const durationMs = (byteLength: number, format: AudioFormat): number => {
  const bytesPerSample = BYTES_PER_SAMPLE[format.encoding] ?? 1;
  const samples = byteLength / bytesPerSample;
  return (samples / format.sampleRate) * 1000;
};
