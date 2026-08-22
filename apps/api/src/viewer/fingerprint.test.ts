import type { CallRecord } from "@ansa/db";
import { describe, expect, it } from "vitest";

import { catchphrases, phraseShape } from "./fingerprint";

/**
 * The measurement is per call, and almost every mistake available here is a mistake about
 * that. An agent that repeats itself inside one difficult call has had one awkward call; an
 * agent that says the same thing once in every call has a catchphrase, and only the second
 * is worth anybody rewriting a prompt over.
 */

/**
 * Enough calls that one occurrence is below the threshold.
 *
 * The first version of these fixtures used four calls, where a single utterance is 25% and
 * every unique reply reported itself as a catchphrase. The window has to be wide enough for
 * "said once" and "said always" to be different numbers.
 */
const QUIET = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9", "q10"];

const call = (callId: string, said: readonly string[]): CallRecord =>
  ({
    callId,
    carrierCallId: `CA-${callId}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    configVersion: 1,
    endReason: "caller hung up",
    durationSeconds: 42,
    callerTurns: said.length,
    agentTurns: said.length,
    events: said.map((text) => ({ kind: "agent said", detail: { text } })),
    reviewed: [],
    confidences: [],
  }) as unknown as CallRecord;

describe("reducing a sentence to its shape", () => {
  it("ignores case and punctuation", () => {
    expect(phraseShape("Let me check that.")).toBe(phraseShape("let me check that"));
  });

  it("flattens numbers, because the digits vary and the phrasing does not", () => {
    /* "Your balance is 12000 naira" and "your balance is 400 naira" are one phrasing said
       twice. Counting them apart hides every catchphrase that quotes a figure. */
    expect(phraseShape("Your balance is 12000 naira")).toBe(phraseShape("your balance is 400 naira"));
  });

  it("keeps phrasings that differ apart", () => {
    // Strip too much and these collapse, reporting a catchphrase nobody said.
    expect(phraseShape("Let me check that")).not.toBe(phraseShape("Let me see"));
    expect(phraseShape("One moment")).not.toBe(phraseShape("Just one moment"));
  });

  it("returns nothing for a turn that was only a number", () => {
    // Not a phrasing, and it would otherwise be the commonest "catchphrase" there is.
    expect(phraseShape("447")).toBe("");
    expect(phraseShape("  ...  ")).toBe("");
  });
});

describe("finding the phrasings that have become habits", () => {
  it("counts a phrase once per call, however often it was said", () => {
    /* Three times in one call out of four is one call in four — under the threshold, and
       the agent was having a hard conversation rather than developing a tic. */
    const records = [
      call("a", ["Let me check that.", "Let me check that.", "Let me check that."]),
      ...QUIET.map((id) => call(id, [`Something only said on ${id}`])),
    ];
    expect(catchphrases(records).phrases).toEqual([]);
  });

  it("reports a phrase that turns up in most calls", () => {
    const records = QUIET.map((id) =>
      call(id, ["Let me check that.", `Something only said on ${id}`]),
    );
    const report = catchphrases(records);

    expect(report.callsScanned).toBe(QUIET.length);
    expect(report.phrases).toHaveLength(1);
    expect(report.phrases[0]?.calls).toBe(QUIET.length);
    expect(report.phrases[0]?.share).toBe(1);
    // The words as they were said, not the key — the point is that somebody reads this.
    expect(report.phrases[0]?.example).toBe("Let me check that.");
  });

  it("leaves a phrase just under the threshold alone", () => {
    /* Some repetition is desirable. An agent that never says "one moment" is an agent
       straining for variety, and reporting it would send somebody to fix nothing. */
    // One call in ten is under fifteen percent, and is somebody being normal.
    const records = [
      call("a", ["One moment."]),
      ...QUIET.slice(1).map((id) => call(id, [`Something only said on ${id}`])),
    ];
    expect(catchphrases(records).phrases).toEqual([]);
  });

  it("puts the worst first and holds a stable order under a tie", () => {
    // Two phrases on the same count must not swap between requests and read as a change.
    const records = QUIET.map((id) => call(id, ["Bear with me.", "Almost there."]));
    const shapes = catchphrases(records).phrases.map((p) => p.shape);
    expect(shapes).toEqual([...shapes].sort());
  });

  it("says nothing about no calls, rather than dividing by none", () => {
    expect(catchphrases([])).toEqual({ callsScanned: 0, phrases: [] });
  });

  it("ignores everything that is not the agent speaking", () => {
    // A caller repeating themselves is not the agent's habit.
    const records = QUIET.map(
      (id) =>
        ({
          ...call(id, []),
          events: [
            // The same question on every call, from the caller. Not the agent's habit.
            { kind: "caller said", detail: { text: "Is it there yet?" } },
            { kind: "agent said", detail: { text: `Something only said on ${id}` } },
          ],
        }) as unknown as CallRecord,
    );
    expect(catchphrases(records).phrases).toEqual([]);
  });

  it("survives an event whose detail is not what it should be", () => {
    /* `detail` is jsonb and comes back as whatever was written. A report that throws on one
       malformed row is a report nobody can open. */
    const records = [
      { ...call("a", []), events: [{ kind: "agent said", detail: null }] } as unknown as CallRecord,
      { ...call("b", []), events: [{ kind: "agent said", detail: { text: 42 } }] } as unknown as CallRecord,
    ];
    expect(() => catchphrases(records)).not.toThrow();
    expect(catchphrases(records).phrases).toEqual([]);
  });
});
