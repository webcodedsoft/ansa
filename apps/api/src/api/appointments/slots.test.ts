import { describe, expect, it } from "vitest";

import {
  availabilityProblem,
  computeFreeSlots,
  isValidTimezone,
  toOffsetIso,
  type SlotBooking,
  type SlotWindow,
} from "./slots";

/**
 * The arithmetic the database refuses to do, tested where it lives.
 *
 * Every case here is one the header of `slots.ts` promises to get right: a booking a slot
 * straddles, a buffer eating the edge, an unexpired hold, a weekday with no hours, and — the
 * one that separates a correct implementation from a plausible one — a range crossing a
 * daylight-saving boundary in the calendar's own zone, where a slot generator that steps in
 * UTC drifts by an hour and this one must not.
 */

const LAGOS = "Africa/Lagos"; // WAT, +01:00 all year — no DST.
const NEW_YORK = "America/New_York"; // EST/EDT — DST twice a year.
// +14 all year: the zone furthest ahead of UTC, so its local date is a day ahead for ten
// hours out of every twenty-four. A holiday judged in UTC lands on the wrong day here.
const KIRITIMATI = "Pacific/Kiritimati";

/** A Monday, 09:00–11:00 local. Weekday 1 as the stored column has it. */
const MONDAY_MORNING: SlotWindow = { weekday: 1, startMinute: 9 * 60, endMinute: 11 * 60 };

const at = (iso: string): Date => new Date(iso);

const startsOf = (
  timeZone: string,
  windows: SlotWindow[],
  bookings: SlotBooking[],
  from: string,
  to: string,
  holidays: string[] = [],
): string[] =>
  computeFreeSlots({
    timeZone,
    slotMinutes: 30,
    bufferMinutes: 0,
    windows,
    bookings,
    holidays,
    from: at(from),
    to: at(to),
  }).map((slot) => toOffsetIso(slot.start, timeZone));

describe("computeFreeSlots", () => {
  it("expands a weekly window into whole slots in the calendar's zone", () => {
    // 2026-03-02 is a Monday. 09:00 Lagos is 08:00Z.
    const starts = startsOf(LAGOS, [MONDAY_MORNING], [], "2026-03-02T00:00:00Z", "2026-03-03T00:00:00Z");
    expect(starts).toEqual([
      "2026-03-02T09:00:00+01:00",
      "2026-03-02T09:30:00+01:00",
      "2026-03-02T10:00:00+01:00",
      "2026-03-02T10:30:00+01:00",
    ]);
  });

  it("drops every slot a booking straddles", () => {
    // A booking 09:15–09:45 Lagos (08:15–08:45Z) overlaps both the 09:00 and 09:30 slots.
    const booking: SlotBooking = { startsAt: at("2026-03-02T08:15:00Z"), endsAt: at("2026-03-02T08:45:00Z") };
    const starts = startsOf(LAGOS, [MONDAY_MORNING], [booking], "2026-03-02T00:00:00Z", "2026-03-03T00:00:00Z");
    expect(starts).toEqual(["2026-03-02T10:00:00+01:00", "2026-03-02T10:30:00+01:00"]);
  });

  it("lets the buffer eat the slots on either edge of a booking", () => {
    // Booking 10:00–10:30 Lagos (09:00–09:30Z) with a 15-minute buffer blocks 09:00:30 either
    // side, taking out the 09:30 slot before it and the 10:30 slot after it as well as the slot
    // itself. Only the 09:00 slot survives.
    const booking: SlotBooking = { startsAt: at("2026-03-02T09:00:00Z"), endsAt: at("2026-03-02T09:30:00Z") };
    const free = computeFreeSlots({
      timeZone: LAGOS,
      slotMinutes: 30,
      bufferMinutes: 15,
      windows: [MONDAY_MORNING],
      bookings: [booking],
      holidays: [],
      from: at("2026-03-02T00:00:00Z"),
      to: at("2026-03-03T00:00:00Z"),
    });
    expect(free.map((slot) => toOffsetIso(slot.start, LAGOS))).toEqual(["2026-03-02T09:00:00+01:00"]);
  });

  it("treats a passed-in hold as taking its slot", () => {
    // The controller only passes holds that have not lapsed; this proves the maths honours one.
    const hold: SlotBooking = { startsAt: at("2026-03-02T08:00:00Z"), endsAt: at("2026-03-02T08:30:00Z") };
    const starts = startsOf(LAGOS, [MONDAY_MORNING], [hold], "2026-03-02T00:00:00Z", "2026-03-03T00:00:00Z");
    expect(starts).toEqual([
      "2026-03-02T09:30:00+01:00",
      "2026-03-02T10:00:00+01:00",
      "2026-03-02T10:30:00+01:00",
    ]);
  });

  it("offers nothing on a weekday with no availability", () => {
    // Hours only on Wednesday (weekday 3); the range is a Monday.
    const wednesday: SlotWindow = { weekday: 3, startMinute: 9 * 60, endMinute: 17 * 60 };
    const starts = startsOf(LAGOS, [wednesday], [], "2026-03-02T00:00:00Z", "2026-03-03T00:00:00Z");
    expect(starts).toEqual([]);
  });

  it("keeps only whole slots — a partial tail is not offered", () => {
    // 09:00–11:00 in 45-minute slots fits 09:00 and 09:45; 10:30 would end at 11:15, past close.
    const free = computeFreeSlots({
      timeZone: LAGOS,
      slotMinutes: 45,
      bufferMinutes: 0,
      windows: [MONDAY_MORNING],
      bookings: [],
      holidays: [],
      from: at("2026-03-02T00:00:00Z"),
      to: at("2026-03-03T00:00:00Z"),
    });
    expect(free.map((slot) => toOffsetIso(slot.start, LAGOS))).toEqual([
      "2026-03-02T09:00:00+01:00",
      "2026-03-02T09:45:00+01:00",
    ]);
  });

  it("returns nothing when from is at or after to", () => {
    expect(
      startsOf(LAGOS, [MONDAY_MORNING], [], "2026-03-03T00:00:00Z", "2026-03-02T00:00:00Z"),
    ).toEqual([]);
    expect(
      startsOf(LAGOS, [MONDAY_MORNING], [], "2026-03-02T00:00:00Z", "2026-03-02T00:00:00Z"),
    ).toEqual([]);
  });

  it("clamps slots to the range and drops those that fall outside it", () => {
    // Range starts at 09:40 Lagos (08:40Z), so the 09:00 and 09:30 slots begin before it.
    const starts = startsOf(LAGOS, [MONDAY_MORNING], [], "2026-03-02T08:40:00Z", "2026-03-02T10:00:00Z");
    // to is 11:00 Lagos, so 10:30 (ends 11:00) still fits.
    expect(starts).toEqual([
      "2026-03-02T10:00:00+01:00",
      "2026-03-02T10:30:00+01:00",
    ]);
  });

  describe("on a day the office is shut", () => {
    /* The whole point of the holidays table: the week says Monday is open, the calendar says
       this particular Monday is Independence Day, and the agent must not offer it. Every case
       here is about the *date*, because that is the only thing a holiday is. */

    it("offers nothing at all on a holiday", () => {
      const starts = startsOf(
        LAGOS,
        [MONDAY_MORNING],
        [],
        "2026-03-02T00:00:00Z",
        "2026-03-03T00:00:00Z",
        ["2026-03-02"],
      );
      expect(starts).toEqual([]);
    });

    it("leaves the day before and the day after untouched", () => {
      // Open Monday, Tuesday and Wednesday 09:00–10:00; Tuesday the third is shut.
      const week: SlotWindow[] = [1, 2, 3].map((weekday) => ({
        weekday,
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }));
      const starts = startsOf(LAGOS, week, [], "2026-03-02T00:00:00Z", "2026-03-05T00:00:00Z", [
        "2026-03-03",
      ]);
      expect(starts).toEqual([
        "2026-03-02T09:00:00+01:00",
        "2026-03-02T09:30:00+01:00",
        "2026-03-04T09:00:00+01:00",
        "2026-03-04T09:30:00+01:00",
      ]);
    });

    it("ignores a date the organisation does not keep", () => {
      const starts = startsOf(
        LAGOS,
        [MONDAY_MORNING],
        [],
        "2026-03-02T00:00:00Z",
        "2026-03-03T00:00:00Z",
        ["2026-10-01", "2026-12-25"],
      );
      expect(starts).toHaveLength(4);
    });

    /* The two cases that separate "judged in the calendar's zone" from "judged in UTC". Both
       use a window whose slots fall on a *different* UTC date from the local one, so a
       generator that compared the holiday against the instant's UTC date gets them backwards. */

    it("judges the date in the calendar's zone when the zone runs ahead of UTC", () => {
      // Midnight to one in Lagos on Monday the second is 23:00–00:00Z on Sunday the first.
      const justAfterMidnight: SlotWindow = { weekday: 1, startMinute: 0, endMinute: 60 };
      const range = ["2026-03-01T00:00:00Z", "2026-03-03T00:00:00Z"] as const;

      // The UTC date of those instants. It is not the Lagos date, so nothing is suppressed.
      expect(
        startsOf(LAGOS, [justAfterMidnight], [], range[0], range[1], ["2026-03-01"]),
      ).toEqual(["2026-03-02T00:00:00+01:00", "2026-03-02T00:30:00+01:00"]);

      // The Lagos date, which is the day the caller would be told about.
      expect(startsOf(LAGOS, [justAfterMidnight], [], range[0], range[1], ["2026-03-02"])).toEqual(
        [],
      );
    });

    it("judges the date in the calendar's zone when the zone runs a day ahead of UTC", () => {
      // Kiritimati is +14 all year, so nine in the morning on Monday the second is 19:00Z on
      // Sunday the first — a whole calendar day apart from the local date.
      const range = ["2026-03-01T00:00:00Z", "2026-03-03T00:00:00Z"] as const;
      const nine: SlotWindow = { weekday: 1, startMinute: 9 * 60, endMinute: 10 * 60 };

      expect(startsOf(KIRITIMATI, [nine], [], range[0], range[1], ["2026-03-01"])).toEqual([
        "2026-03-02T09:00:00+14:00",
        "2026-03-02T09:30:00+14:00",
      ]);
      expect(startsOf(KIRITIMATI, [nine], [], range[0], range[1], ["2026-03-02"])).toEqual([]);
    });

    it("still subtracts bookings on the days around a holiday", () => {
      // A holiday suppresses its own day and changes nothing about any other, including the
      // ordinary business of a booking taking its slot.
      const week: SlotWindow[] = [1, 2].map((weekday) => ({
        weekday,
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      }));
      const onTuesday: SlotBooking = {
        startsAt: at("2026-03-03T08:00:00Z"), // 09:00 Lagos
        endsAt: at("2026-03-03T08:30:00Z"),
      };
      const starts = startsOf(
        LAGOS,
        week,
        [onTuesday],
        "2026-03-02T00:00:00Z",
        "2026-03-04T00:00:00Z",
        ["2026-03-02"],
      );
      expect(starts).toEqual(["2026-03-03T09:30:00+01:00"]);
    });
  });

  describe("across a daylight-saving boundary", () => {
    // A window from midnight to 06:00 on the Sunday the clocks change, hourly slots.
    const overnight: SlotWindow = { weekday: 0, startMinute: 0, endMinute: 6 * 60 };
    const hourly = (from: string, to: string): number =>
      computeFreeSlots({
        timeZone: NEW_YORK,
        slotMinutes: 60,
        bufferMinutes: 0,
        windows: [overnight],
        bookings: [],
        holidays: [],
        from: at(from),
        to: at(to),
      }).length;

    it("yields five hourly slots when an hour springs forward", () => {
      // 2026-03-08: 02:00 becomes 03:00, so 00:00–06:00 wall time is only five real hours.
      expect(hourly("2026-03-08T00:00:00Z", "2026-03-09T00:00:00Z")).toBe(5);
    });

    it("yields seven hourly slots when an hour falls back", () => {
      // 2026-11-01: 02:00 becomes 01:00, so 00:00–06:00 wall time is seven real hours.
      expect(hourly("2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z")).toBe(7);
    });

    it("anchors slots to wall-clock time on both sides of the boundary", () => {
      // Two consecutive Sundays, 09:00–10:00 each. The offset moves from EST to EDT between
      // them, and 09:00 local stays 09:00 local — a UTC-stepping generator would drift.
      const nineToTen: SlotWindow = { weekday: 0, startMinute: 9 * 60, endMinute: 10 * 60 };
      const free = computeFreeSlots({
        timeZone: NEW_YORK,
        slotMinutes: 60,
        bufferMinutes: 0,
        windows: [nineToTen],
        bookings: [],
        holidays: [],
        from: at("2026-03-01T00:00:00Z"), // covers Sun 2026-03-01 (EST) and Sun 2026-03-08 (EDT)
        to: at("2026-03-09T00:00:00Z"),
      });
      expect(free.map((slot) => toOffsetIso(slot.start, NEW_YORK))).toEqual([
        "2026-03-01T09:00:00-05:00",
        "2026-03-08T09:00:00-04:00",
      ]);
    });
  });
});

describe("toOffsetIso", () => {
  it("renders a Lagos instant with a +01:00 offset", () => {
    expect(toOffsetIso(at("2026-03-02T08:00:00Z"), LAGOS)).toBe("2026-03-02T09:00:00+01:00");
  });

  it("renders a New York winter instant with a -05:00 offset", () => {
    expect(toOffsetIso(at("2026-01-15T17:00:00Z"), NEW_YORK)).toBe("2026-01-15T12:00:00-05:00");
  });

  it("renders a New York summer instant with a -04:00 offset", () => {
    expect(toOffsetIso(at("2026-07-15T16:00:00Z"), NEW_YORK)).toBe("2026-07-15T12:00:00-04:00");
  });
});

describe("availabilityProblem", () => {
  it("accepts non-overlapping windows in order", () => {
    expect(
      availabilityProblem([
        { weekday: 1, startMinute: 540, endMinute: 720 },
        { weekday: 1, startMinute: 780, endMinute: 1020 },
        { weekday: 2, startMinute: 540, endMinute: 1020 },
      ]),
    ).toBeNull();
  });

  it("rejects a window that ends before it starts", () => {
    expect(availabilityProblem([{ weekday: 1, startMinute: 720, endMinute: 540 }])).toMatch(/end after/);
  });

  it("rejects a window that ends at the minute it starts", () => {
    expect(availabilityProblem([{ weekday: 1, startMinute: 540, endMinute: 540 }])).toMatch(/end after/);
  });

  it("rejects two windows overlapping on the same weekday", () => {
    expect(
      availabilityProblem([
        { weekday: 1, startMinute: 540, endMinute: 720 },
        { weekday: 1, startMinute: 660, endMinute: 900 },
      ]),
    ).toMatch(/overlap/);
  });

  it("allows the same clock hours on different weekdays", () => {
    expect(
      availabilityProblem([
        { weekday: 1, startMinute: 540, endMinute: 720 },
        { weekday: 2, startMinute: 540, endMinute: 720 },
      ]),
    ).toBeNull();
  });
});

describe("isValidTimezone", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimezone("Africa/Lagos")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
  });

  it("rejects anything Intl does not know", () => {
    expect(isValidTimezone("Mars/Phobos")).toBe(false);
    expect(isValidTimezone("Not/A/Zone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});
