import { describe, expect, it } from "vitest";

import { callsThisWeek, daysSince, timelineOf } from "./contact-timeline";

/* The API's own shapes, narrowed to the fields these functions read. Casting keeps the test
   about the windowing rule rather than about assembling two full response objects. */
const call = (id: string, at: string) =>
  ({ callId: id, calledAt: at, direction: "inbound", durationSeconds: 60, endReason: "completed" }) as never;
const value = (key: string, at: string) =>
  ({ fieldKey: key, fieldType: "text", value: `${key} value`, sourceCallId: null, updatedAt: at }) as never;

const NOW = new Date("2026-09-06T12:00:00.000Z");

describe("a person's timeline", () => {
  it("puts calls and values on one spine, newest first", () => {
    const entries = timelineOf(
      [call("c2", "2026-09-05T10:00:00.000Z"), call("c1", "2026-09-01T10:00:00.000Z")],
      [value("area", "2026-09-03T09:00:00.000Z")],
      true,
    );
    expect(entries.map((e) => e.at)).toEqual([
      "2026-09-05T10:00:00.000Z",
      "2026-09-03T09:00:00.000Z",
      "2026-09-01T10:00:00.000Z",
    ]);
    expect(entries[1]?.kind).toBe("value");
  });

  it("keeps a value off a page whose calls are all older than it", () => {
    /* Page two covers March. A value confirmed last week did not happen in March, and putting
       it there would tell the same week's story twice in two places. */
    const march = [call("c9", "2026-03-04T10:00:00.000Z"), call("c8", "2026-03-01T10:00:00.000Z")];
    const recent = [value("area", "2026-09-03T09:00:00.000Z")];
    expect(timelineOf(march, recent, false).map((e) => e.kind)).toEqual(["call", "call"]);
    // The same page on page one: the window reaches forward to now, so it belongs.
    expect(timelineOf(march, recent, true).map((e) => e.kind)).toEqual(["value", "call", "call"]);
  });

  it("keeps a value off any page whose calls are all newer than it", () => {
    const recentCalls = [call("c2", "2026-09-05T10:00:00.000Z")];
    const old = [value("area", "2026-01-01T09:00:00.000Z")];
    expect(timelineOf(recentCalls, old, true).map((e) => e.kind)).toEqual(["call"]);
  });

  it("still has a spine for somebody imported and never rung", () => {
    const imported = [value("area", "2026-08-02T09:00:00.000Z")];
    expect(timelineOf([], imported, true)).toHaveLength(1);
    // …but not on a later page, which covers no span at all.
    expect(timelineOf([], imported, false)).toEqual([]);
  });
});

describe("counting the week", () => {
  it("counts only when the page holds the whole history", () => {
    const calls = [call("c2", "2026-09-05T10:00:00.000Z"), call("c1", "2026-07-01T10:00:00.000Z")];
    expect(callsThisWeek(calls, 2, NOW)).toBe(1);
  });

  it("refuses to answer when calls are hidden on another page", () => {
    /* A number that is right for most people and quietly wrong for the busiest ones is worse
       than no number, because nobody can tell which one they are looking at. */
    const calls = [call("c2", "2026-09-05T10:00:00.000Z")];
    expect(callsThisWeek(calls, 40, NOW)).toBeNull();
  });
});

describe("days since", () => {
  it("floors to whole days and never goes negative", () => {
    expect(daysSince("2026-09-01T12:00:00.000Z", NOW)).toBe(5);
    expect(daysSince("2026-09-06T11:00:00.000Z", NOW)).toBe(0);
    // A clock skew that puts a call in the future reads as today, not as minus one.
    expect(daysSince("2026-09-08T12:00:00.000Z", NOW)).toBe(0);
  });

  it("says nothing about somebody who has never called", () => {
    expect(daysSince(null, NOW)).toBeNull();
    expect(daysSince("not a date", NOW)).toBeNull();
  });
});
