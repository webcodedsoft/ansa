import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CallRecord, MetricEvent } from "@ansa/db";
import { describe, expect, it } from "vitest";

import { DEFAULT_REVIEW_WEIGHTS, reviewQueue, scoreCallForReview } from "./review";
import { trendByConfigVersion } from "./trends";

/**
 * The post-call scan (R9.2.1) and the queue it ranks (R9.2.2).
 *
 * Every event below is spelled the way the orchestrator spells it, and two of those
 * spellings are checked against the orchestrator's own source at the bottom of this file
 * rather than trusted. A scan that reads `"barge_in"` while the pipeline writes `"barge-in"`
 * does not fail — it returns an empty queue and reads as a quiet week, which is the failure
 * mode that put `recovery_line` and `tool_call` in `metrics.ts` and out of the SQL that
 * feeds it for two slices.
 */

const call = (over: Partial<CallRecord> = {}): CallRecord => ({
  callId: "c1",
  carrierCallId: "CA1",
  createdAt: "2026-08-08T12:00:00.000Z",
  configVersion: 1,
  endReason: "carrier sent stop",
  durationSeconds: 60,
  callerTurns: 4,
  agentTurns: 4,
  events: [],
  reviewed: [],
  confidences: [],
  ...over,
});

const kinds = (record: CallRecord): readonly string[] =>
  scoreCallForReview(record).signals.map((s) => s.kind);

describe("a call that went fine", () => {
  it("scores zero and is not in the queue", () => {
    const clean = call({
      events: [{ kind: "latency", detail: { stage: "turn_to_audio", ms: 600 } }],
      confidences: [0.94, 0.88],
    });

    expect(scoreCallForReview(clean).severity).toBe(0);
    expect(scoreCallForReview(clean).signals).toEqual([]);
    expect(reviewQueue([clean])).toEqual([]);
  });

  it("is still scored, so the share of calls that go wrong is computable", () => {
    // A function that only returns the bad calls cannot say what fraction of calls are bad,
    // and that fraction is what R9.2.6 tracks over a provider change.
    expect(scoreCallForReview(call()).callId).toBe("c1");
  });
});

describe("what the scan flags", () => {
  it("flags invented speech above everything else", () => {
    const hallucinated = call({ events: [{ kind: "hallucination discarded", detail: { text: "x" } }] });
    const slow = call({ events: [{ kind: "latency", detail: { stage: "turn_to_audio", ms: 2_400 } }] });

    expect(kinds(hallucinated)).toEqual(["hallucination"]);
    expect(scoreCallForReview(hallucinated).severity).toBeGreaterThan(
      scoreCallForReview(slow).severity,
    );
  });

  it("flags a call that was handed to a person", () => {
    expect(kinds(call({ events: [{ kind: "escalated to a human", detail: {} }] }))).toEqual([
      "escalated",
    ]);
  });

  it("counts a repeated readback once per value, not once per attempt", () => {
    // A policy number read back three times is one problem with one value. Counting the
    // attempts would rank a single stubborn number above three separate ones.
    const events: readonly MetricEvent[] = [
      { kind: "confirmation_requested", detail: { subject: "policy_number", attempt: 1 } },
      { kind: "confirmation_requested", detail: { subject: "policy_number", attempt: 2 } },
      { kind: "confirmation_requested", detail: { subject: "policy_number", attempt: 3 } },
    ];
    const signal = scoreCallForReview(call({ events })).signals[0];

    expect(signal?.kind).toBe("repeated-confirmation");
    expect(signal?.count).toBe(1);
  });

  it("does not treat the readback every capture opens with as a repeat", () => {
    const opened: readonly MetricEvent[] = [
      { kind: "confirmation_requested", detail: { subject: "policy_number", attempt: 1 } },
    ];
    expect(kinds(call({ events: opened }))).toEqual([]);
  });

  it("flags a turn the transcriber itself was unsure of, reviewed or not", () => {
    const score = scoreCallForReview(call({ confidences: [0.94, 0.31, null] }));

    expect(kinds(call({ confidences: [0.94, 0.31, null] }))).toEqual(["low-confidence"]);
    // Null is "the provider reported none", which is not low and must not be counted as it.
    expect(score.signals[0]?.count).toBe(1);
  });

  it("flags interruptions only when they outnumber every other agent turn", () => {
    const occasional = call({ agentTurns: 8, events: [{ kind: "barge-in", detail: {} }] });
    const storm = call({
      agentTurns: 4,
      events: Array.from({ length: 5 }, () => ({ kind: "barge-in", detail: {} })),
    });

    expect(kinds(occasional)).toEqual([]);
    expect(kinds(storm)).toEqual(["barge-in-storm"]);
  });

  it("flags a turn that produced nothing and needed an apology", () => {
    expect(kinds(call({ events: [{ kind: "recovery_line", detail: { reason: "llm failed" } }] }))).toEqual(
      ["recovery-line"],
    );
  });

  it("flags a sentence the caller never heard", () => {
    expect(
      kinds(call({ events: [{ kind: "tts_sentence_dropped", detail: { seq: 2, chars: 40 } }] })),
    ).toEqual(["sentence-dropped"]);
  });

  it("flags capture falling through to spelling or the keypad", () => {
    // Both mean the same thing about the call: speech had already failed twice.
    const spelling = call({ events: [{ kind: "agent said", detail: { reason: "readback:spelling" } }] });
    const keypad = call({ events: [{ kind: "agent said", detail: { reason: "readback:keypad" } }] });

    expect(kinds(spelling)).toEqual(["capture-fallback"]);
    expect(kinds(keypad)).toEqual(["capture-fallback"]);
  });

  it("does not read an ordinary agent turn as a capture fallback", () => {
    expect(kinds(call({ events: [{ kind: "agent said", detail: { seq: 1, action: "answer" } }] }))).toEqual(
      [],
    );
  });

  it("flags dead air the caller would read as a dropped call", () => {
    const quiet = call({
      events: [
        { kind: "latency", detail: { stage: "turn_to_audio", ms: 2_400 } },
        // A component stage over the same threshold is diagnosis, not the gap the caller
        // experienced, and counting it would double every slow turn.
        { kind: "latency", detail: { stage: "llm", ms: 2_400 } },
      ],
    });
    const signal = scoreCallForReview(quiet).signals[0];

    expect(signal?.kind).toBe("long-silence");
    expect(signal?.count).toBe(1);
  });

  it("flags a tool that failed, and not one the tier gate refused", () => {
    const failed = call({ events: [{ kind: "tool_call", detail: { outcome: "failed" } }] });
    const refused = call({ events: [{ kind: "tool_call", detail: { outcome: "transfer" } }] });

    expect(kinds(failed)).toEqual(["tool-failure"]);
    expect(kinds(refused)).toEqual([]);
  });

  it("flags the transcriber or the voice dropping mid-call", () => {
    expect(kinds(call({ events: [{ kind: "listen_failed", detail: { reason: "socket" } }] }))).toEqual([
      "pipeline-failure",
    ]);
    expect(kinds(call({ events: [{ kind: "tts_failed", detail: { seq: 1 } }] }))).toEqual([
      "pipeline-failure",
    ]);
  });

  it("flags a caller who heard the greeting and left", () => {
    expect(kinds(call({ callerTurns: 0 }))).toEqual(["no-caller-turn"]);
  });
});

describe("severity", () => {
  it("caps one signal so a long call cannot outrank a bad one", () => {
    // Without the cap the queue sorts by call length: forty barge-ins on a six-minute call
    // buries a two-minute call in which the agent invented a policy number.
    const many = call({
      events: Array.from({ length: 40 }, () => ({ kind: "recovery_line", detail: {} })),
    });
    const signal = scoreCallForReview(many).signals[0];

    expect(signal?.count).toBe(40);
    expect(signal?.weight).toBe(DEFAULT_REVIEW_WEIGHTS.cap * DEFAULT_REVIEW_WEIGHTS.recoveryLine);
  });

  it("does not scale a signal that is one fact however many events carry it", () => {
    // Twenty interruptions is one broken echo guard, not twenty problems. Scaling it would
    // let a long call outrank a call where the agent invented a policy number — the same
    // failure the cap prevents, arriving through the other door.
    const storm = call({
      agentTurns: 4,
      events: Array.from({ length: 20 }, () => ({ kind: "barge-in", detail: {} })),
    });
    const signal = scoreCallForReview(storm).signals[0];

    expect(signal?.count).toBe(20);
    expect(signal?.weight).toBe(DEFAULT_REVIEW_WEIGHTS.bargeInStorm);
    expect(scoreCallForReview(storm).severity).toBeLessThan(
      scoreCallForReview(call({ events: [{ kind: "hallucination discarded", detail: {} }] }))
        .severity,
    );
  });

  it("is the sum of what each signal contributed, and says so per signal", () => {
    const both = call({
      events: [
        { kind: "hallucination discarded", detail: {} },
        { kind: "escalated to a human", detail: {} },
      ],
    });
    const score = scoreCallForReview(both);

    expect(score.severity).toBe(
      DEFAULT_REVIEW_WEIGHTS.hallucination + DEFAULT_REVIEW_WEIGHTS.escalated,
    );
    expect(score.signals.reduce((total, s) => total + s.weight, 0)).toBe(score.severity);
  });
});

describe("the queue", () => {
  const bad = call({
    callId: "bad",
    createdAt: "2026-08-08T10:00:00.000Z",
    events: [
      { kind: "hallucination discarded", detail: {} },
      { kind: "escalated to a human", detail: {} },
    ],
  });
  const mild = call({ callId: "mild", createdAt: "2026-08-08T11:00:00.000Z", callerTurns: 0 });
  const older = call({ callId: "older", createdAt: "2026-08-08T09:00:00.000Z", callerTurns: 0 });
  const clean = call({ callId: "clean" });

  it("puts the worst call first and leaves the clean ones out", () => {
    expect(reviewQueue([clean, mild, bad]).map((s) => s.callId)).toEqual(["bad", "mild"]);
  });

  it("breaks a tie on recency, because the newer call is the one still in production", () => {
    expect(reviewQueue([older, mild]).map((s) => s.callId)).toEqual(["mild", "older"]);
  });

  it("can be narrowed to the backlog nobody has ruled on", () => {
    const worked = call({
      callId: "worked",
      callerTurns: 0,
      reviewed: [{ heard: "a", corrected: "a" }],
      confidences: [0.9],
    });

    expect(reviewQueue([worked, mild], { reviewed: false }).map((s) => s.callId)).toEqual(["mild"]);
    expect(reviewQueue([worked, mild], { reviewed: true }).map((s) => s.callId)).toEqual(["worked"]);
  });

  it("counts the turns still to rule on, not the calls", () => {
    // A half-worked call is the common case, and "reviewed: true" would hide it.
    const half = call({ reviewed: [{ heard: "a", corrected: "a" }], confidences: [0.9, 0.8, 0.7] });
    expect(scoreCallForReview(half).unreviewed).toBe(2);
  });

  it("honours a threshold and a limit", () => {
    expect(reviewQueue([bad, mild], { minSeverity: 10 }).map((s) => s.callId)).toEqual(["bad"]);
    expect(reviewQueue([bad, mild], { limit: 1 }).map((s) => s.callId)).toEqual(["bad"]);
  });
});

describe("trends by configuration version (R9.2.6)", () => {
  const v3 = call({ callId: "a", configVersion: 3, createdAt: "2026-08-08T09:00:00.000Z" });
  const v4good = call({ callId: "b", configVersion: 4, createdAt: "2026-08-08T10:00:00.000Z" });
  const v4bad = call({
    callId: "c",
    configVersion: 4,
    createdAt: "2026-08-08T11:00:00.000Z",
    events: [{ kind: "hallucination discarded", detail: {} }],
  });
  const unversioned = call({ callId: "d", configVersion: null });

  it("groups the window by the configuration that served each call", () => {
    const trends = trendByConfigVersion([v3, v4good, v4bad]);

    expect(trends.map((t) => t.configVersion)).toEqual([4, 3]);
    expect(trends[0]?.calls).toBe(2);
    expect(trends[0]?.flaggedRate).toBe(0.5);
    expect(trends[1]?.flaggedRate).toBe(0);
  });

  it("spans each version by its own first and last call", () => {
    const [four] = trendByConfigVersion([v4good, v4bad]);

    expect(four?.firstCallAt).toBe("2026-08-08T10:00:00.000Z");
    expect(four?.lastCallAt).toBe("2026-08-08T11:00:00.000Z");
  });

  it("sorts calls with no recorded version last rather than as version zero", () => {
    // An unregistered number is not the oldest configuration, and putting it at the top
    // would make it look like one.
    expect(trendByConfigVersion([unversioned, v3]).map((t) => t.configVersion)).toEqual([3, null]);
  });

  it("scores each version with the same arithmetic the whole window uses", () => {
    const [four] = trendByConfigVersion([v4good, v4bad]);
    expect(four?.metrics.hallucinationsDiscarded).toBe(1);
  });
});

/**
 * The two couplings this file cannot fake.
 *
 * A signal is only as good as the string the pipeline actually writes, and every literal
 * above is a copy of one. These two are read back out of the source that emits them, so a
 * rename in the orchestrator fails here rather than silently emptying the queue.
 */
describe("the strings the orchestrator actually writes", () => {
  const read = (path: string): string => readFileSync(resolve(process.cwd(), "src", path), "utf8");

  it("still spells the capture fallback reason `readback:<kind>`", () => {
    expect(read("orchestrator/orchestrator.ts")).toContain("`readback:${capture.kind}`");
  });

  it("still calls those capture states `spelling` and `keypad`", () => {
    const capture = read("orchestrator/capture.ts");
    expect(capture).toContain(`readonly kind: "spelling"`);
    expect(capture).toContain(`readonly kind: "keypad"`);
  });
});
