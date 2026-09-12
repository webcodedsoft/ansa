import { describe, expect, it } from "vitest";

import { notableEvents } from "./event-log";

/* The API's own event shape, narrowed to the fields the log reads. */
const event = (
  kind: string,
  detail: Partial<Record<string, unknown>> = {},
  offsetMs: number | null = 1000,
  at = "2026-09-12T10:00:00.000Z",
) =>
  ({
    kind,
    offsetMs,
    at,
    detail: {
      stage: null,
      ms: null,
      seq: null,
      attempt: null,
      reason: null,
      subject: null,
      outcome: null,
      tool: null,
      chars: null,
      answeredBy: null,
      ...detail,
    },
  }) as never;

const START = "2026-09-12T10:00:00.000Z";

describe("what a person is shown of a call's events", () => {
  it("leaves the machinery out", () => {
    /* These are how the call was taken apart, not what happened on it. Several hundred of
       them per call; none are what somebody asking "what did the agent do" is asking. */
    const rows = notableEvents([
      event("stt_partial", { chars: 1 }),
      event("latency", { ms: 0, stage: "stt_final" }),
      event("call_state"),
      event("llm_usage"),
      event("tts_start", { seq: 1 }),
      event("call configuration"),
      event("hallucination discarded"),
    ], START);
    expect(rows).toEqual([]);
  });

  it("keeps what the agent did, in plain words", () => {
    const rows = notableEvents([
      event("barge-in", { seq: 3 }, 19_000),
      event("tool_call", { tool: "find_appointment_slots", outcome: "3 slots", ms: 1210 }, 21_000),
      event("confirmation_requested", { subject: "name", attempt: 2 }, 30_000),
      event("escalated to a human", {}, 44_000),
    ], START);
    expect(rows.map((row) => [row.label, row.detail])).toEqual([
      ["Caller interrupted", "turn 3"],
      ["Tool used", "find_appointment_slots · 3 slots · 1210 ms"],
      ["Read back to confirm", "name · attempt 2"],
      ["Handed to a human", ""],
    ]);
  });

  it("does not say 'attempt 1' — the first try is not a retry", () => {
    const [row] = notableEvents([event("confirmation_requested", { subject: "phone", attempt: 1 })], START);
    expect(row?.detail).toBe("phone");
  });

  it("hides a kind nobody has looked at, rather than showing its internal name", () => {
    expect(notableEvents([event("something_new_the_orchestrator_writes")], START)).toEqual([]);
  });

  it("places an event with no media offset by its wall-clock time from the call's start", () => {
    /* The notable kinds are written by the orchestrator without an offset. Left as "—" they
       all sat at the same unplaced moment; the wall clock puts them where they happened. */
    const [row] = notableEvents(
      [event("barge-in", { seq: 1 }, null, "2026-09-12T10:00:19.000Z")],
      START,
    );
    expect(row?.offsetMs).toBe(19_000);
  });
});
