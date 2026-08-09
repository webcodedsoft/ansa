import type { CallRecord } from "@ansa/db";
import { describe, expect, it } from "vitest";

import { scoreCalls, wordErrorRate } from "./metrics";

const call = (over: Partial<CallRecord> = {}): CallRecord => ({
  callId: "c1",
  carrierCallId: "CA-metrics",
  createdAt: "2026-01-01T00:00:00.000Z",
  configVersion: 1,
  endReason: "carrier sent stop",
  durationSeconds: 42,
  callerTurns: 4,
  agentTurns: 4,
  events: [],
  reviewed: [],
  confidences: [],
  ...over,
});

describe("what a corrected transcript is worth", () => {
  it("scores a perfect transcription at zero errors", () => {
    expect(wordErrorRate("My name is Sikiru", "My name is Sikiru")).toBe(0);
  });

  it("ignores punctuation and case, which are not transcription errors", () => {
    // "Adebayo." and "adebayo" are the same transcription, and counting the full stop as
    // an error would flatter whichever provider happens to punctuate least.
    expect(wordErrorRate("adebayo", "Adebayo.")).toBe(0);
  });

  it("counts a substituted word once, not twice", () => {
    // The name problem, in miniature: "Security" for "Sikiru" is one substitution in four.
    expect(wordErrorRate("My name is Security", "My name is Sikiru")).toBeCloseTo(0.25);
  });

  it("counts an omission", () => {
    expect(wordErrorRate("four one seven nine", "four one seven two nine")).toBeCloseTo(0.2);
  });

  it("has no opinion when there is nothing to compare against", () => {
    expect(wordErrorRate("something", "")).toBeNull();
  });

  it("pools word accuracy across turns rather than averaging rates", () => {
    // A one-word turn getting one word wrong is 100% WER, and averaging per-turn rates
    // would let it outweigh a twenty-word turn that was perfect.
    const metrics = scoreCalls([
      call({
        reviewed: [
          { heard: "yes", corrected: "no" },
          {
            heard: "your policy renews in May and the premium is unchanged this year",
            corrected: "your policy renews in May and the premium is unchanged this year",
          },
        ],
      }),
    ]);

    expect(metrics.sttExactMatch).toBe(0.5);
    expect(metrics.sttWordAccuracy ?? 0).toBeGreaterThan(0.9);
    expect(metrics.correctionRate).toBe(0.5);
  });

  it("says nothing rather than zero when nothing has been reviewed", () => {
    // A tenant nobody has reviewed is not a tenant with perfect transcription, and a
    // dashboard that renders it as 0% would be read as exactly that.
    const metrics = scoreCalls([call()]);
    expect(metrics.sttExactMatch).toBeNull();
    expect(metrics.sttWordAccuracy).toBeNull();
    expect(metrics.reviewed).toBe(0);
  });
});

describe("what the event log says about a call", () => {
  it("separates a readback that was accepted from one that was not", () => {
    const metrics = scoreCalls([
      call({
        callerTurns: 10,
        events: [
          { kind: "confirmation_requested", detail: { subject: "reference", attempt: 1 } },
          { kind: "confirmation_requested", detail: { subject: "reference", attempt: 2 } },
          { kind: "value confirmed", detail: { chars: 5 } },
        ],
      }),
    ]);

    expect(metrics.confirmationRate).toBeCloseTo(0.1);
    expect(metrics.readbackRejectionRate).toBe(1);
    expect(metrics.captureCompletionRate).toBe(1);
  });

  it("measures the one latency a caller experiences, not the components of it", () => {
    const metrics = scoreCalls([
      call({
        events: [
          { kind: "latency", detail: { stage: "turn_to_audio", ms: 700 } },
          { kind: "latency", detail: { stage: "turn_to_audio", ms: 1500 } },
          // Diagnostic stages must not dilute the number a tenant is promised.
          { kind: "latency", detail: { stage: "tts_first_byte", ms: 50 } },
        ],
      }),
    ]);

    expect(metrics.responseLatencyMs.samples).toBe(2);
    expect(metrics.responseLatencyMs.p50).toBe(700);
    expect(metrics.responseLatencyMs.p95).toBe(1500);
  });

  it("counts barge-ins against agent turns", () => {
    const metrics = scoreCalls([
      call({ agentTurns: 4, events: [{ kind: "barge-in", detail: { reason: "caller interrupted" } }] }),
    ]);
    expect(metrics.bargeInRate).toBe(0.25);
  });

  it("counts a call that escalated once, however many times it said so", () => {
    const metrics = scoreCalls([
      call({
        events: [
          { kind: "escalated to a human", detail: {} },
          { kind: "escalated to a human", detail: {} },
        ],
      }),
      call({ callId: "c2" }),
    ]);
    expect(metrics.transferRate).toBe(0.5);
  });

  it("treats a call the caller never spoke on as abandoned", () => {
    const metrics = scoreCalls([call({ callerTurns: 0, agentTurns: 1 }), call({ callId: "c2" })]);
    expect(metrics.abandonmentRate).toBe(0.5);
  });

  it("surfaces discarded hallucinations as a count, because any at all is news", () => {
    const metrics = scoreCalls([
      call({ events: [{ kind: "hallucination discarded", detail: { speechMs: 0 } }] }),
    ]);
    expect(metrics.hallucinationsDiscarded).toBe(1);
  });

  it("survives an event whose detail is not an object", () => {
    // detail is jsonb and comes back as whatever was written. A metrics page that throws
    // on one malformed row is a metrics page nobody can open.
    const metrics = scoreCalls([call({ events: [{ kind: "latency", detail: null }] })]);
    expect(metrics.responseLatencyMs.samples).toBe(0);
  });

  it("has no metrics at all for no calls, rather than zeroes", () => {
    const metrics = scoreCalls([]);
    expect(metrics.calls).toBe(0);
    expect(metrics.transferRate).toBeNull();
    expect(metrics.bargeInRate).toBeNull();
  });
});
