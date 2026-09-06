import { muLawToPcm } from "./audio";

/**
 * A call's two legs as one playable file.
 *
 * The recordings on disk are raw mu-law at 8 kHz with no container, which is exactly what the
 * carrier sends and exactly what no browser will play. This is the whole transcoding gap:
 * `muLawToPcm` already decodes the samples, and what was missing was the 44 bytes of RIFF
 * header that say what they are.
 *
 * **Stereo, one leg per channel** — the caller on the left, the agent on the right. Mixing to
 * mono would be smaller and would throw away the thing a reviewer most needs: on a barge-in
 * both people are talking, and a mono mix of that is a noise nobody can correct a transcript
 * against. Separate channels also let a listener isolate the caller, which is what the accent
 * work in `eval/` needs.
 *
 * The two tracks are aligned when they are written — the agent's is padded with mu-law silence
 * up to the caller's byte count on every write — so they are interleaved sample for sample
 * here, and whichever ends first is padded with digital silence.
 */

const SAMPLE_RATE = 8000;
const CHANNELS = 2;
const BITS = 16;
const HEADER_BYTES = 44;

/** PCM16 silence, which is zero — unlike mu-law silence, which is 0xFF. */
const SILENT = 0;

/**
 * A canonical 44-byte RIFF/WAVE header for 16-bit PCM.
 *
 * Written by hand rather than pulled from a package: it is four fixed strings and six numbers,
 * and a dependency for that is one more thing to audit, pin and update for the rest of the
 * product's life.
 */
const header = (dataBytes: number): Buffer => {
  const buffer = Buffer.alloc(HEADER_BYTES);
  const blockAlign = (CHANNELS * BITS) / 8;

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4); // everything after this field
  buffer.write("WAVE", 8, "ascii");

  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // a PCM format chunk is 16 bytes
  buffer.writeUInt16LE(1, 20); // 1 = uncompressed PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * blockAlign, 28); // byte rate
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(BITS, 34);

  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
};

/**
 * Two mu-law tracks into one stereo WAV.
 *
 * An absent agent track is legitimate rather than an error: every recording made before both
 * legs were captured has only the caller, and those still have to play. It becomes a silent
 * right channel rather than a mono file, so one player and one shape handle both.
 */
export const wavFromLegs = (caller: Buffer, agent: Buffer | null): Buffer => {
  /* `muLawToPcm` returns a Buffer of little-endian PCM16, not an array of samples — so its
     length is bytes and every sample is two of them. Indexing it directly reads half a
     sample, which type-checks perfectly and plays as noise. */
  const left = muLawToPcm(caller, SAMPLE_RATE, SAMPLE_RATE);
  const right = agent === null ? Buffer.alloc(0) : muLawToPcm(agent, SAMPLE_RATE, SAMPLE_RATE);

  const leftSamples = Math.floor(left.length / 2);
  const rightSamples = Math.floor(right.length / 2);
  const samples = Math.max(leftSamples, rightSamples);
  const data = Buffer.alloc(samples * CHANNELS * (BITS / 8));

  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(i < leftSamples ? left.readInt16LE(i * 2) : SILENT, i * 4);
    data.writeInt16LE(i < rightSamples ? right.readInt16LE(i * 2) : SILENT, i * 4 + 2);
  }

  return Buffer.concat([header(data.length), data]);
};

/** How long a mu-law recording runs, in whole seconds. One byte is one sample at 8 kHz. */
export const mulawSeconds = (bytes: number): number => Math.round(bytes / SAMPLE_RATE);
