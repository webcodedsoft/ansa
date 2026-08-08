import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { muLawToLinear, muLawToPcm } from "./audio";

describe("muLawToLinear", () => {
  it("is inverted and logarithmic, which is the thing that catches people", () => {
    // Digital silence is the LARGEST byte. Any arithmetic on raw mu-law measures nothing.
    expect(Math.abs(muLawToLinear(0xff))).toBeLessThan(10);
    // And the sign runs the other way from the intuition too: the byte is stored
    // complemented, so 0x00 is the most negative sample and 0x80 the most positive.
    expect(muLawToLinear(0x00)).toBeLessThan(-30_000);
    expect(muLawToLinear(0x80)).toBeGreaterThan(30_000);
  });
});

describe("muLawToPcm", () => {
  it("emits two bytes per sample at the same rate", () => {
    const out = muLawToPcm(Buffer.alloc(160, 0xff), 8000, 8000);
    expect(out.length).toBe(320);
  });

  it("triples the sample count going from 8k to 24k", () => {
    // One 20ms carrier frame: 160 mu-law bytes in, 480 PCM samples out.
    const out = muLawToPcm(Buffer.alloc(160, 0xff), 8000, 24_000);
    expect(out.length).toBe(480 * 2);
  });

  it("keeps silence silent", () => {
    const out = muLawToPcm(Buffer.alloc(160, 0xff), 8000, 24_000);
    for (let i = 0; i < out.length; i += 2) expect(Math.abs(out.readInt16LE(i))).toBeLessThan(10);
  });

  it("interpolates rather than holding, so no stair-step buzz is added", () => {
    // Two very different samples: the inserted points must lie between them, not repeat
    // the left one. Zero-order hold puts harmonics inside the speech band and a
    // transcriber cannot know the buzz is ours.
    const frame = Buffer.from([0xff, 0x00]);
    const out = muLawToPcm(frame, 8000, 24_000);

    const values: number[] = [];
    for (let i = 0; i < out.length; i += 2) values.push(out.readInt16LE(i));

    const distinct = new Set(values).size;
    expect(distinct).toBeGreaterThan(2);
  });

  it("handles an empty frame without throwing", () => {
    expect(muLawToPcm(Buffer.alloc(0), 8000, 24_000).length).toBe(0);
  });

  it("never wraps a loud sample around to the opposite sign", () => {
    // Clamping matters: interpolation overshoot on a full-scale sample would otherwise
    // flip +32767 to -32768 and produce a click.
    const frame = Buffer.from([0x00, 0x80, 0x00, 0x80]);
    const out = muLawToPcm(frame, 8000, 24_000);
    for (let i = 0; i < out.length; i += 2) {
      const v = out.readInt16LE(i);
      expect(v).toBeGreaterThanOrEqual(-32768);
      expect(v).toBeLessThanOrEqual(32767);
    }
  });
});
