import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { createSpeechGate, frameEnergy, muLawToLinear } from "./speech-gate";

/** mu-law silence is 0xFF, which is a large byte and near-zero amplitude. */
const silence = (frames: number): Buffer[] =>
  Array.from({ length: frames }, () => Buffer.alloc(160, 0xff));

/** A loud alternating pattern: far from the mu-law zero point in both directions. */
const speech = (frames: number): Buffer[] =>
  Array.from({ length: frames }, (_unused, i) =>
    Buffer.from(Array.from({ length: 160 }, (_u, j) => ((i + j) % 2 === 0 ? 0x00 : 0x80))),
  );

describe("muLawToLinear", () => {
  it("puts silence near zero and 0x00 far from it", () => {
    // The whole reason the gate cannot measure raw bytes: 0xFF is silence and 0x00 is
    // the loudest positive sample, so byte value is inversely related to loudness.
    expect(Math.abs(muLawToLinear(0xff))).toBeLessThan(10);
    expect(Math.abs(muLawToLinear(0x00))).toBeGreaterThan(30_000);
  });
});

describe("frameEnergy", () => {
  it("separates silence from speech by orders of magnitude", () => {
    expect(frameEnergy(Buffer.alloc(160, 0xff))).toBeLessThan(50);
    expect(frameEnergy(speech(1)[0] as Buffer)).toBeGreaterThan(10_000);
  });
});

describe("speech gate", () => {
  it("forwards nothing while the line is silent", () => {
    const gate = createSpeechGate();
    const forwarded = silence(100).flatMap((f) => gate.push(f));

    // This is the audio that made three separate providers invent a language.
    expect(forwarded).toHaveLength(0);
    expect(gate.open).toBe(false);
  });

  it("opens on speech and includes the onset it had already missed", () => {
    const gate = createSpeechGate({ preRollMs: 100, frameMs: 20 });
    for (const f of silence(50)) gate.push(f);

    const first = gate.push(speech(1)[0] as Buffer);

    // Pre-roll plus the triggering frame: without it the first consonant is lost, and on
    // a name or a policy number that is the whole value.
    expect(first.length).toBeGreaterThan(1);
    expect(gate.open).toBe(true);
  });

  it("holds through the pauses inside ordinary speech", () => {
    const gate = createSpeechGate({ hangoverMs: 700, frameMs: 20 });
    for (const f of speech(20)) gate.push(f);

    // 300ms of thinking pause mid-sentence must not close the gate; chopping here is
    // what cost a caller their name.
    const during = silence(15).flatMap((f) => gate.push(f));
    expect(during.length).toBe(15);
    expect(gate.open).toBe(true);
  });

  it("closes once the caller has really stopped", () => {
    const gate = createSpeechGate({ hangoverMs: 200, frameMs: 20 });
    for (const f of speech(20)) gate.push(f);
    for (const f of silence(40)) gate.push(f);

    expect(gate.open).toBe(false);
  });

  it("passes a whole utterance through unbroken", () => {
    const gate = createSpeechGate();
    for (const f of silence(30)) gate.push(f);

    const utterance = speech(100).flatMap((f) => gate.push(f));
    expect(utterance.length).toBeGreaterThanOrEqual(100);
  });

  it("drops the bulk of a mostly-silent call", () => {
    const gate = createSpeechGate();
    for (const f of silence(500)) gate.push(f);
    for (const f of speech(50)) gate.push(f);
    for (const f of silence(500)) gate.push(f);

    // Silence is most of a call, and every dropped frame is one the transcriber cannot
    // hallucinate from — and is not billed for.
    expect(gate.dropped).toBeGreaterThan(800);
  });

  it("adapts to a noisy line instead of treating hiss as speech", () => {
    const gate = createSpeechGate();
    // Constant low-level noise, well above digital silence.
    const hiss = Array.from({ length: 300 }, () => Buffer.alloc(160, 0xf0));
    const forwarded = hiss.flatMap((f) => gate.push(f));

    // A steady noise floor is measured and ignored; only what rises above it counts.
    expect(forwarded.length).toBeLessThan(60);
  });
});
