import { describe, expect, it } from "vitest";

import { mulawSeconds, wavFromLegs } from "./wav";

/**
 * Making a call playable (slice 5).
 *
 * The recordings are raw mu-law with no container, which no browser will play, and the whole
 * gap was the 44 bytes that say what the samples are. These check the header a player actually
 * reads and the interleave a reviewer actually hears — including the trap that `muLawToPcm`
 * returns a Buffer of bytes rather than an array of samples, so indexing it directly reads
 * half a sample, type-checks, and plays as noise.
 */
const MULAW_SILENCE = 0xff;

/** A mu-law byte that is not silence, so a channel carrying it is audibly not empty. */
const TONE = 0x10;

describe("a call as a WAV", () => {
  it("writes a header a player can read", () => {
    const wav = wavFromLegs(Buffer.alloc(8, TONE), Buffer.alloc(8, TONE));

    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");

    expect(wav.readUInt16LE(20)).toBe(1); // uncompressed PCM
    expect(wav.readUInt16LE(22)).toBe(2); // stereo: one leg per channel
    expect(wav.readUInt32LE(24)).toBe(8000); // the carrier's rate, unchanged
    expect(wav.readUInt16LE(34)).toBe(16); // 16-bit samples
    expect(wav.readUInt32LE(28)).toBe(8000 * 4); // byte rate = rate × block align
    expect(wav.readUInt16LE(32)).toBe(4); // block align = channels × bytes per sample
  });

  it("declares the sizes it actually wrote", () => {
    /* A header claiming more data than follows is the commonest way a hand-written WAV plays
       as a burst of noise at the end. */
    const wav = wavFromLegs(Buffer.alloc(100, TONE), Buffer.alloc(100, TONE));
    const declared = wav.readUInt32LE(40);
    expect(declared).toBe(wav.length - 44);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    // 100 mu-law bytes is 100 samples; stereo PCM16 is four bytes each.
    expect(declared).toBe(400);
  });

  it("puts the caller left and the agent right, sample for sample", () => {
    const wav = wavFromLegs(Buffer.alloc(4, TONE), Buffer.alloc(4, MULAW_SILENCE));

    const left = wav.readInt16LE(44);
    const right = wav.readInt16LE(46);
    // The caller is speaking and the agent is not, so only the left channel carries signal.
    expect(left).not.toBe(0);
    expect(Math.abs(right)).toBeLessThan(Math.abs(left));
  });

  it("still plays a recording made before the agent's leg was captured", () => {
    /* Every recording on disk today has only the caller. A silent right channel keeps one
       player and one shape for both, rather than a second mono path to maintain. */
    const wav = wavFromLegs(Buffer.alloc(4, TONE), null);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readInt16LE(44)).not.toBe(0); // caller
    expect(wav.readInt16LE(46)).toBe(0); // agent, silent
    expect(wav.readUInt32LE(40)).toBe(16); // 4 samples × 4 bytes
  });

  it("pads whichever leg ends first rather than truncating the other", () => {
    // The agent stopped talking; the caller kept going. Nothing of the caller is lost.
    const wav = wavFromLegs(Buffer.alloc(10, TONE), Buffer.alloc(2, TONE));
    expect(wav.readUInt32LE(40)).toBe(40); // 10 samples survive, not 2
    expect(wav.readInt16LE(44 + 9 * 4)).not.toBe(0); // the caller's last sample
    expect(wav.readInt16LE(44 + 9 * 4 + 2)).toBe(0); // the agent's, padded
  });

  it("makes an empty recording an empty file rather than a broken one", () => {
    const wav = wavFromLegs(Buffer.alloc(0), null);
    expect(wav.length).toBe(44);
    expect(wav.readUInt32LE(40)).toBe(0);
  });
});

describe("how long a recording runs", () => {
  it("counts one byte as one sample at 8 kHz", () => {
    expect(mulawSeconds(8000)).toBe(1);
    expect(mulawSeconds(0)).toBe(0);
    expect(mulawSeconds(120_000)).toBe(15);
  });
});
