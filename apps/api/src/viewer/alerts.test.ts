import type { CallRecord, MetricEvent } from "@ansa/db";
import { describe, expect, it } from "vitest";

import { alertsFor } from "./alerts";
import { scoreCalls } from "./metrics";

/**
 * The thresholds, exercised through `scoreCalls` rather than against a hand-built metrics
 * object.
 *
 * That is the point of the file. Alerting reads exactly what the viewer's metrics page
 * reads, computed by exactly the same code over exactly the same events — so a definition
 * that changes changes both, and the pager and the dashboard cannot come to disagree about
 * whether the system is up.
 */

/** Enough calls to be judged at all, all identical. */
const window = (
  count: number,
  events: readonly MetricEvent[],
  turns = { caller: 4, agent: 4 },
): readonly CallRecord[] =>
  Array.from({ length: count }, (_v, i) => ({
    callId: `c${i}`,
    carrierCallId: `CA${i}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    configVersion: 1,
    endReason: "carrier sent stop",
    durationSeconds: 60,
    callerTurns: turns.caller,
    agentTurns: turns.agent,
    events,
    reviewed: [],
    confidences: [],
  }));

const fast: MetricEvent = { kind: "latency", detail: { stage: "turn_to_audio", ms: 600 } };
const named = (alerts: ReturnType<typeof alertsFor>["alerts"]): readonly string[] =>
  alerts.map((a) => a.name);

describe("nothing fires on too little evidence", () => {
  it("holds every threshold until the window is big enough", () => {
    // Two calls, one of which transferred, is a 50% transfer rate and means nothing.
    const records = window(2, [{ kind: "escalated to a human", detail: {} }]);
    const verdict = alertsFor(scoreCalls(records));

    expect(verdict.sampleTooSmall).toBe(true);
    expect(verdict.alerts).toEqual([]);
  });

  it("distinguishes a quiet window from a healthy one", () => {
    const healthy = alertsFor(scoreCalls(window(25, [fast])));

    expect(healthy.sampleTooSmall).toBe(false);
    expect(healthy.alerts).toEqual([]);
  });
});

describe("latency (PRD §5.5)", () => {
  it("says nothing while replies land inside the target", () => {
    expect(named(alertsFor(scoreCalls(window(25, [fast]))).alerts)).toEqual([]);
  });

  it("reports the p50 and the tail separately", () => {
    // Every turn at 1.6s: past the 800ms target and past the 1.5s hard fail.
    const slow: MetricEvent = { kind: "latency", detail: { stage: "turn_to_audio", ms: 1_600 } };
    const alerts = alertsFor(scoreCalls(window(25, [slow]))).alerts;

    expect(named(alerts)).toContain("Response latency p50");
    expect(named(alerts)).toContain("Response latency p95");
    expect(alerts[0]?.observed).toBe(1_600);
    expect(alerts[0]?.threshold).toBe(800);
  });

  it("reports only the tail when the typical turn is fine", () => {
    // Eighteen fast turns and two very slow ones, per call: the median holds, the tail
    // does not, and the caller who waited four seconds is the one who remembers it.
    const slow: MetricEvent = { kind: "latency", detail: { stage: "turn_to_audio", ms: 4_000 } };
    const events = [...Array.from({ length: 18 }, () => fast), slow, slow];
    const alerts = named(alertsFor(scoreCalls(window(25, events))).alerts);

    expect(alerts).toContain("Response latency p95");
    expect(alerts).not.toContain("Response latency p50");
  });
});

describe("the caller's experience", () => {
  it("fires when more than half of calls need a person (PRD §10)", () => {
    const escalated = window(15, [fast, { kind: "escalated to a human", detail: {} }]);
    const fine = window(10, [fast]);
    const alerts = named(alertsFor(scoreCalls([...escalated, ...fine])).alerts);

    expect(alerts).toContain("Transfer rate");
  });

  it("does not fire at exactly the documented target", () => {
    // Half is the promise, and the promise being met is not an alert.
    const escalated = window(10, [fast, { kind: "escalated to a human", detail: {} }]);
    const fine = window(10, [fast]);

    expect(named(alertsFor(scoreCalls([...escalated, ...fine])).alerts)).toEqual([]);
  });

  it("fires on turns that produced nothing and had to be apologised for", () => {
    // One recovery line in every call of four caller turns is 25%, against a budget of 1%.
    const records = window(25, [fast, { kind: "recovery_line", detail: { reason: "no transcript" } }]);
    const alerts = alertsFor(scoreCalls(records)).alerts;

    expect(named(alerts)).toContain("Silence recovered");
    expect(alerts.find((a) => a.name === "Silence recovered")?.threshold).toBe(0.01);
  });
});

describe("a tenant's own systems", () => {
  it("fires when their endpoint fails often enough for callers to hear it", () => {
    const records = window(25, [
      fast,
      { kind: "tool_call", detail: { tool: "check_policy", outcome: "failed" } },
      { kind: "tool_call", detail: { tool: "check_policy", outcome: "ok" } },
    ]);

    expect(named(alertsFor(scoreCalls(records)).alerts)).toContain("Tool failure rate");
  });

  it("does not count a refused write or a transfer as a failure", () => {
    // The tier gate working is not an outage. Counting a correctly refused irreversible
    // tool here would page somebody every time the product did the right thing.
    const records = window(25, [
      fast,
      { kind: "tool_call", detail: { tool: "cancel_policy", outcome: "transfer" } },
      { kind: "tool_call", detail: { tool: "change_address", outcome: "confirm" } },
    ]);

    expect(named(alertsFor(scoreCalls(records)).alerts)).toEqual([]);
  });

  it("says nothing about tools on a window that never called one", () => {
    const verdict = alertsFor(scoreCalls(window(25, [fast])));

    expect(named(verdict.alerts)).not.toContain("Tool failure rate");
  });
});

describe("a threshold carries what it needs to be acted on", () => {
  it("gives the reading, the limit and what to do", () => {
    const records = window(25, [{ kind: "latency", detail: { stage: "turn_to_audio", ms: 2_000 } }]);
    const alert = alertsFor(scoreCalls(records)).alerts[0];

    expect(alert?.observed).toBe(2_000);
    expect(alert?.threshold).toBe(800);
    expect(alert?.unit).toBe("ms");
    expect(alert?.meaning.length).toBeGreaterThan(0);
  });
});
