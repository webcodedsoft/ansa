import { describe, expect, it } from "vitest";

import { callsThisWeek, daysSince, timelineOf } from "./contact-timeline";

/* The API's own shapes, narrowed to the fields these functions read. Casting keeps the test
   about the windowing rule rather than about assembling two full response objects. */
const call = (id: string, at: string) =>
  ({ callId: id, calledAt: at, direction: "inbound", durationSeconds: 60, endReason: "completed" }) as never;
const value = (key: string, at: string) =>
  ({ fieldKey: key, fieldType: "text", value: `${key} value`, sourceCallId: null, updatedAt: at }) as never;
/* `bookedAt` is when it was arranged and `startsAt` is what it is for — deliberately far
   apart here, because which of the two places the entry is the whole question. */
const booking = (bookedAt: string, startsAt: string) =>
  ({ id: "a1", startsAt, status: "booked", title: "Viewing", callId: null, bookedAt }) as never;
const grant = (at: string, kind: "granted" | "withdrawn" = "granted") =>
  ({ at, kind, basis: "existing relationship" }) as never;

const NOW = new Date("2026-09-06T12:00:00.000Z");

describe("a person's timeline", () => {
  it("puts calls and values on one spine, newest first", () => {
    const entries = timelineOf(
      [call("c2", "2026-09-05T10:00:00.000Z"), call("c1", "2026-09-01T10:00:00.000Z")],
      [value("area", "2026-09-03T09:00:00.000Z")],
      [],
      [],
      { first: true, last: true },
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
    expect(timelineOf(march, recent, [], [], { first: false, last: true }).map((e) => e.kind)).toEqual(["call", "call"]);
    // The same page on page one: the window reaches forward to now, so it belongs.
    expect(timelineOf(march, recent, [], [], { first: true, last: false }).map((e) => e.kind)).toEqual(["value", "call", "call"]);
  });

  it("keeps a value off any page whose calls are all newer than it", () => {
    const recentCalls = [call("c2", "2026-09-05T10:00:00.000Z")];
    const old = [value("area", "2026-01-01T09:00:00.000Z")];
    expect(timelineOf(recentCalls, old, [], [], { first: true, last: false }).map((e) => e.kind)).toEqual(["call"]);
  });

  it("still has a spine for somebody imported and never rung", () => {
    const imported = [value("area", "2026-08-02T09:00:00.000Z")];
    expect(timelineOf([], imported, [], [], { first: true, last: true })).toHaveLength(1);
    // …but not on a later page, which covers no span at all.
    expect(timelineOf([], imported, [], [], { first: false, last: true })).toEqual([]);
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

describe("the other two things that happen to a person", () => {
  it("puts an appointment where it was booked, not where it is for", () => {
    /* A viewing on 20 September has not happened yet. Filed at `startsAt` it would sit above
       every call the person has ever made, and the spine would open on a future event. */
    const entries = timelineOf(
      [call("c1", "2026-09-05T10:00:00.000Z")],
      [],
      [booking("2026-09-04T09:00:00.000Z", "2026-09-20T15:30:00.000Z")],
      [],
      { first: true, last: true },
    );
    expect(entries.map((e) => e.kind)).toEqual(["call", "appointment"]);
    expect(entries[1]?.at).toBe("2026-09-04T09:00:00.000Z");
  });

  it("carries a grant and its withdrawal as two moments", () => {
    const entries = timelineOf(
      [call("c1", "2026-09-01T10:00:00.000Z")],
      [],
      [],
      [grant("2026-09-03T09:00:00.000Z", "withdrawn"), grant("2026-09-02T09:00:00.000Z")],
      { first: true, last: true },
    );
    expect(entries.map((e) => e.kind)).toEqual(["consent", "consent", "call"]);
  });

  it("applies the same page window to every kind, not just to values", () => {
    /* Page two covers March. A booking made and a consent recorded last week did not happen
       in March, and the rule that keeps a value off this page must keep these off too. */
    const march = [call("c9", "2026-03-04T10:00:00.000Z"), call("c8", "2026-03-01T10:00:00.000Z")];
    const later = timelineOf(
      march,
      [],
      [booking("2026-09-03T09:00:00.000Z", "2026-09-20T15:30:00.000Z")],
      [grant("2026-09-03T09:00:00.000Z")],
      { first: false, last: true },
    );
    expect(later.map((e) => e.kind)).toEqual(["call", "call"]);
    // The same page reaching forward to now: both belong.
    const firstPage = timelineOf(
      march,
      [],
      [booking("2026-09-03T09:00:00.000Z", "2026-09-20T15:30:00.000Z")],
      [grant("2026-09-03T09:00:00.000Z")],
      { first: true, last: false },
    );
    expect(firstPage).toHaveLength(4);
  });
});

describe("the end of the history reaches back", () => {
  it("shows the import that created somebody, below their first call", () => {
    /* The old rule held anything older than the oldest call for an older page. On the last
       page there is no older page, so the row that says where this person came from was
       invisible on every page at once. */
    const entries = timelineOf(
      [call("c1", "2026-08-04T16:20:00.000Z")],
      [value("source", "2026-08-02T11:02:00.000Z")],
      [],
      [],
      { first: true, last: true },
    );
    expect(entries.map((e) => e.kind)).toEqual(["call", "value"]);
  });

  it("still holds it back while an older page exists to hold it", () => {
    const entries = timelineOf(
      [call("c1", "2026-08-04T16:20:00.000Z")],
      [value("source", "2026-08-02T11:02:00.000Z")],
      [],
      [],
      { first: true, last: false },
    );
    expect(entries.map((e) => e.kind)).toEqual(["call"]);
  });
});
