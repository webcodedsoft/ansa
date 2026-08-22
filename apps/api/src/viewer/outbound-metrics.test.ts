import type { CallRecord } from "@ansa/db";
import { describe, expect, it } from "vitest";

import { outboundMetrics } from "./outbound-metrics";

/**
 * Four figures, and the one that matters is the do-not-call rate: every request behind it
 * is a permanent, platform-wide suppression, so a rate that climbs is a list burning
 * through numbers nobody can ever dial again. The rest of these tests mostly guard the
 * denominators, because a rate with the wrong denominator is worse than no rate.
 */

const call = (over: Partial<CallRecord> = {}): CallRecord =>
  ({
    callId: "c1",
    carrierCallId: "CA-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    direction: "outbound",
    configVersion: 1,
    endReason: "caller hung up",
    durationSeconds: 30,
    callerTurns: 2,
    agentTurns: 2,
    events: [],
    reviewed: [],
    confidences: [],
    ...over,
  }) as unknown as CallRecord;

const answeredBy = (verdict: string) => ({ kind: "answered_by", detail: { answeredBy: verdict } });
const askedNotToBeCalled = { kind: "do_not_call_recorded", detail: { saidWhat: "take me off" } };

describe("keeping inbound out of it", () => {
  it("ignores inbound calls entirely", () => {
    /* An inbound call is answered by definition. Counting them would make the connect rate
       a measure of how much inbound traffic there was. */
    const metrics = outboundMetrics([
      call({ direction: "inbound" }),
      call({ direction: "inbound", endReason: "no-answer" }),
    ]);
    expect(metrics.calls).toBe(0);
    expect(metrics.connectRate).toBeNull();
  });

  it("says nothing rather than zero when nothing was placed", () => {
    // Null and zero are different readings: no campaign, versus a campaign reaching nobody.
    expect(outboundMetrics([]).connectRate).toBeNull();
    expect(outboundMetrics([]).doNotCallRate).toBeNull();
  });
});

describe("whether the calls reached anybody", () => {
  it("counts the carrier's never-answered statuses as not connected", () => {
    const metrics = outboundMetrics([
      call({ endReason: "no-answer" }),
      call({ endReason: "busy" }),
      call({ endReason: "failed" }),
      call({ endReason: "caller hung up" }),
    ]);
    expect(metrics.connectRate).toBe(0.25);
  });

  it("treats a call still in progress as connected", () => {
    /* A null end reason is a live call or one whose closing was lost. The alternative
       reports every call currently happening as a failure to reach anybody. */
    expect(outboundMetrics([call({ endReason: null })]).connectRate).toBe(1);
  });
});

describe("whether a person answered", () => {
  it("counts humans against the calls the carrier gave a verdict for", () => {
    /* Not against every call. Detection can be off, or the verdict can be lost, and
       dividing by calls with no verdict would report a made-up shortfall. */
    const metrics = outboundMetrics([
      call({ events: [answeredBy("human")] }),
      call({ events: [answeredBy("machine_end_beep")] }),
      call({ events: [] }),
    ]);
    expect(metrics.answeredByKnown).toBe(2);
    expect(metrics.humanAnswerRate).toBe(0.5);
  });

  it("counts an uncertain verdict as neither", () => {
    // The carrier could not tell. Folding that into either side puts its uncertainty into
    // a number that gets read as fact.
    const metrics = outboundMetrics([
      call({ events: [answeredBy("human")] }),
      call({ events: [answeredBy("unknown")] }),
    ]);
    expect(metrics.answeredByKnown).toBe(2);
    expect(metrics.humanAnswerRate).toBe(0.5);
  });

  it("has no rate when no verdict arrived at all", () => {
    expect(outboundMetrics([call()]).humanAnswerRate).toBeNull();
  });
});

describe("the alarm", () => {
  it("reports the share of calls somebody asked to be taken off", () => {
    const metrics = outboundMetrics([
      call({ events: [askedNotToBeCalled] }),
      call(),
      call(),
      call(),
    ]);
    expect(metrics.doNotCallRate).toBe(0.25);
  });

  it("counts a caller who said it three times as one call", () => {
    /* Somebody repeating themselves is one person asking. Counting the repeats would make
       a single angry caller look like a trend, on the number whose whole job is trends. */
    const metrics = outboundMetrics([
      call({ events: [askedNotToBeCalled, askedNotToBeCalled, askedNotToBeCalled] }),
      call(),
    ]);
    expect(metrics.doNotCallRate).toBe(0.5);
  });
});

describe("how long they stayed on", () => {
  it("takes the median of connected calls", () => {
    const metrics = outboundMetrics([
      call({ durationSeconds: 10 }),
      call({ durationSeconds: 20 }),
      call({ durationSeconds: 240 }),
    ]);
    // The mean is 90 and describes none of them.
    expect(metrics.medianSecondsToHangup).toBe(20);
  });

  it("leaves out calls that never connected", () => {
    // A no-answer has no duration to speak of, and counting it as zero drags the median
    // toward a hangup that never happened.
    const metrics = outboundMetrics([
      call({ endReason: "no-answer", durationSeconds: 0 }),
      call({ durationSeconds: 30 }),
    ]);
    expect(metrics.medianSecondsToHangup).toBe(30);
  });
});
