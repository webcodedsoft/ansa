import { describe, expect, it } from "vitest";

import type { CallDetail } from "./calls.service";
import { linesOf } from "./call-conversation";

/**
 * Reading a call back as a conversation (0076).
 *
 * Before the agent's words had a row, this merged caller transcripts with bare agent *turns*
 * and rendered the word "spoke" where a reply belonged. Both sides come from `transcripts`
 * now, and what these pin down is the correlation: an agent line finding its own turn for the
 * cut marker, and neither side finding the other's.
 */
const line = (over: Partial<CallDetail["transcripts"][number]>) =>
  ({
    id: "t1",
    speaker: "caller",
    text: "hello",
    correctedText: null,
    correctedAt: null,
    confidence: "0.900",
    offsetMs: 0,
    provider: "flux",
    ...over,
  }) as CallDetail["transcripts"][number];

const turn = (over: Partial<CallDetail["turns"][number]>) =>
  ({
    seq: 1,
    speaker: "agent",
    startedOffsetMs: 0,
    endedOffsetMs: 1000,
    bargedInAtMs: null,
    ...over,
  }) as CallDetail["turns"][number];

const event = (over: Record<string, unknown>) =>
  ({
    kind: "tool dispatched",
    offsetMs: 0,
    at: "2026-09-06T13:12:04.000Z",
    detail: {
      tool: null,
      outcome: null,
      ms: null,
      stage: null,
      reason: null,
      subject: null,
      attempt: null,
    },
    ...over,
  }) as unknown as CallDetail["events"][number];

const call = (over: Partial<CallDetail>): CallDetail =>
  ({ transcripts: [], turns: [], events: [], ...over }) as CallDetail;

describe("reading a call back", () => {
  it("puts both sides on one spine, in the order they were said", () => {
    const lines = linesOf(
      call({
        transcripts: [
          line({ id: "a", speaker: "agent", text: "Good day.", offsetMs: 0 }),
          line({ id: "b", speaker: "caller", text: "Hello.", offsetMs: 2000 }),
        ],
        turns: [turn({ startedOffsetMs: 0 })],
      }),
    );
    expect(lines.map((l) => l.speaker)).toEqual(["agent", "caller"]);
    expect(lines.map((l) => l.transcript?.text)).toEqual(["Good day.", "Hello."]);
  });

  it("gives an agent line the cut point from its own turn, and never the caller's", () => {
    const lines = linesOf(
      call({
        transcripts: [
          line({ id: "a", speaker: "agent", offsetMs: 5000 }),
          // A caller line that happens to share the offset must not inherit the mark.
          line({ id: "b", speaker: "caller", offsetMs: 5000 }),
        ],
        turns: [turn({ startedOffsetMs: 5000, bargedInAtMs: 1400 })],
      }),
    );
    expect(lines.find((l) => l.speaker === "agent")?.bargedInAtMs).toBe(1400);
    expect(lines.find((l) => l.speaker === "caller")?.bargedInAtMs).toBeNull();
  });

  it("keeps a turn that made a sound but left no words", () => {
    /* Cut off before a whole word landed. A gap in the record reads worse than a line saying
       plainly that something was said and not captured. */
    const lines = linesOf(call({ transcripts: [], turns: [turn({ seq: 3, startedOffsetMs: 800 })] }));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.transcript).toBeNull();
    expect(lines[0]?.speaker).toBe("agent");
  });

  it("does not repeat an agent turn that did leave words", () => {
    const lines = linesOf(
      call({
        transcripts: [line({ id: "a", speaker: "agent", offsetMs: 800 })],
        turns: [turn({ startedOffsetMs: 800 })],
      }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.transcript?.text).toBe("hello");
  });

  it("drops a tool call into the gap it explains", () => {
    const lines = linesOf(
      call({
        transcripts: [
          line({ id: "a", speaker: "caller", offsetMs: 0 }),
          line({ id: "b", speaker: "agent", offsetMs: 4000 }),
        ],
        turns: [turn({ startedOffsetMs: 4000 })],
        events: [
          event({
            offsetMs: 2000,
            detail: { tool: "find_appointment_slots", outcome: "ok", ms: 1210 },
          }),
          // No tool named: an ordinary event, and not part of the conversation.
          event({ kind: "barge-in", offsetMs: 2500, detail: { tool: null, outcome: null, ms: null } }),
        ],
      }),
    );
    expect(lines.map((l) => l.speaker)).toEqual(["caller", "tool", "agent"]);
    expect(lines[1]?.aside).toContain("find_appointment_slots");
    expect(lines[1]?.aside).toContain("1210ms");
  });
});
