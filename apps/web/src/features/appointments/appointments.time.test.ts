import { describe, expect, it } from "vitest";

import { calendarRange } from "./appointments.range";

import {
  addDays,
  availabilityProblem,
  clockLabel,
  dayWindow,
  groupBookingsByDay,
  groupSlotsByDay,
  isoDate,
  minutesOfDay,
  minutesToTime,
  mondayOf,
  parseIsoDate,
  timeToMinutes,
  weekDays,
  weekRange,
  weekdayOf,
  zonedParts,
  zonedTimeToUtc,
} from "./appointments.time";

const LAGOS = "Africa/Lagos"; // UTC+1, no DST
const NEW_YORK = "America/New_York"; // UTC-4/-5, DST

describe("zonedParts", () => {
  it("reads an instant as the wall clock of the calendar's zone, not the reader's", () => {
    // 08:30Z is 09:30 in Lagos.
    const parts = zonedParts(new Date("2026-03-02T08:30:00Z"), LAGOS);
    expect(parts).toMatchObject({ year: 2026, month: 3, day: 2, hour: 9, minute: 30, weekday: 1 });
  });

  it("crosses the date line backwards for a western zone late in the UTC day", () => {
    // 02:00Z on the 3rd is 21:00 on the 2nd in New York.
    const parts = zonedParts(new Date("2026-03-03T02:00:00Z"), NEW_YORK);
    expect(parts).toMatchObject({ month: 3, day: 2, hour: 21 });
  });
});

describe("minutesOfDay", () => {
  it("is the minute of the day in the calendar's zone", () => {
    expect(minutesOfDay(new Date("2026-03-02T08:00:00Z"), LAGOS)).toBe(9 * 60);
  });
});

describe("zonedTimeToUtc", () => {
  it("turns a Lagos wall time into the right instant", () => {
    // 00:00 Lagos on 2026-03-02 is 23:00Z on 2026-03-01.
    const instant = zonedTimeToUtc({ year: 2026, month: 3, day: 2 }, 0, LAGOS);
    expect(instant.toISOString()).toBe("2026-03-01T23:00:00.000Z");
  });

  it("round-trips through zonedParts across a DST zone", () => {
    // Midday well clear of any transition; the wall clock must survive the round trip.
    const instant = zonedTimeToUtc({ year: 2026, month: 7, day: 15 }, 12 * 60, NEW_YORK);
    const parts = zonedParts(instant, NEW_YORK);
    expect(parts).toMatchObject({ year: 2026, month: 7, day: 15, hour: 12, minute: 0 });
  });
});

describe("plain-date arithmetic", () => {
  it("rolls addDays across a month boundary", () => {
    expect(addDays({ year: 2026, month: 1, day: 31 }, 1)).toEqual({ year: 2026, month: 2, day: 1 });
  });

  it("weekdayOf agrees with the API numbering (Monday is 1)", () => {
    expect(weekdayOf({ year: 2026, month: 3, day: 2 })).toBe(1); // a Monday
    expect(weekdayOf({ year: 2026, month: 3, day: 1 })).toBe(0); // the Sunday before
  });

  it("mondayOf maps a Sunday back to the Monday six days earlier", () => {
    expect(mondayOf({ year: 2026, month: 3, day: 8 })).toEqual({ year: 2026, month: 3, day: 2 });
    expect(mondayOf({ year: 2026, month: 3, day: 2 })).toEqual({ year: 2026, month: 3, day: 2 });
  });

  it("parses and rejects ISO dates", () => {
    expect(parseIsoDate("2026-03-02")).toEqual({ year: 2026, month: 3, day: 2 });
    expect(parseIsoDate("2026-13-02")).toBeNull();
    expect(parseIsoDate("nonsense")).toBeNull();
    expect(parseIsoDate(undefined)).toBeNull();
  });

  it("isoDate pads its parts", () => {
    expect(isoDate({ year: 2026, month: 3, day: 2 })).toBe("2026-03-02");
  });
});

describe("weekDays and weekRange", () => {
  it("returns seven Monday-first days for any day in the week", () => {
    const days = weekDays({ year: 2026, month: 3, day: 5 }); // a Thursday
    expect(days.map((day) => day.iso)).toEqual([
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
    ]);
    expect(days[0]?.shortLabel).toBe("Mon");
  });

  it("bounds the week with the calendar's own offset, from Monday 00:00 to next Monday 00:00", () => {
    const { from, to } = weekRange({ year: 2026, month: 3, day: 5 }, LAGOS);
    expect(from).toBe("2026-03-01T23:00:00.000Z"); // Mon 00:00 Lagos
    expect(to).toBe("2026-03-08T23:00:00.000Z"); // next Mon 00:00 Lagos
  });
});

describe("groupSlotsByDay", () => {
  const days = weekDays({ year: 2026, month: 3, day: 2 });

  it("files each slot under the day its start reads as in the calendar's zone", () => {
    const grouped = groupSlotsByDay(
      [
        { start: "2026-03-02T09:00:00+01:00", end: "2026-03-02T09:30:00+01:00" },
        { start: "2026-03-02T09:30:00+01:00", end: "2026-03-02T10:00:00+01:00" },
        { start: "2026-03-04T14:00:00+01:00", end: "2026-03-04T14:30:00+01:00" },
      ],
      days,
      LAGOS,
    );
    const monday = grouped.get("2026-03-02") ?? [];
    expect(monday).toHaveLength(2);
    expect(monday[0]).toMatchObject({ startMinute: 540, endMinute: 570, label: "9:00" });
    expect(grouped.get("2026-03-04")).toHaveLength(1);
    expect(grouped.get("2026-03-03")).toHaveLength(0);
  });

  it("keeps slots sorted within a day even when supplied out of order", () => {
    const grouped = groupSlotsByDay(
      [
        { start: "2026-03-02T11:00:00+01:00", end: "2026-03-02T11:30:00+01:00" },
        { start: "2026-03-02T09:00:00+01:00", end: "2026-03-02T09:30:00+01:00" },
      ],
      days,
      LAGOS,
    );
    expect((grouped.get("2026-03-02") ?? []).map((slot) => slot.startMinute)).toEqual([540, 660]);
  });

  it("drops a slot whose day is outside the shown week", () => {
    const grouped = groupSlotsByDay(
      [{ start: "2026-03-20T09:00:00+01:00", end: "2026-03-20T09:30:00+01:00" }],
      days,
      LAGOS,
    );
    for (const bucket of grouped.values()) expect(bucket).toHaveLength(0);
  });
});

describe("groupBookingsByDay", () => {
  const days = weekDays({ year: 2026, month: 3, day: 2 });

  it("places held and booked appointments and excludes cancelled ones", () => {
    const grouped = groupBookingsByDay(
      [
        { startsAt: "2026-03-02T08:00:00Z", endsAt: "2026-03-02T08:30:00Z", status: "booked" as const },
        { startsAt: "2026-03-02T09:00:00Z", endsAt: "2026-03-02T09:30:00Z", status: "held" as const },
        { startsAt: "2026-03-02T10:00:00Z", endsAt: "2026-03-02T10:30:00Z", status: "cancelled" as const },
      ],
      days,
      LAGOS,
    );
    const monday = grouped.get("2026-03-02") ?? [];
    expect(monday).toHaveLength(2);
    // 08:00Z is 09:00 Lagos.
    expect(monday[0]).toMatchObject({ startMinute: 540, endMinute: 570 });
    expect(monday[1]?.booking.status).toBe("held");
  });
});

describe("dayWindow", () => {
  it("falls back to a working day when nothing is set", () => {
    expect(dayWindow([], [])).toEqual({ startMinute: 8 * 60, endMinute: 18 * 60 });
  });

  it("brackets the open hours with an hour of air, without leaving the day", () => {
    const window = dayWindow([{ startMinute: 9 * 60, endMinute: 17 * 60 }], []);
    expect(window).toEqual({ startMinute: 8 * 60, endMinute: 18 * 60 });
  });

  it("widens to cover a booking that spills past the open hours", () => {
    const window = dayWindow(
      [{ startMinute: 9 * 60, endMinute: 17 * 60 }],
      [{ startMinute: 19 * 60, endMinute: 20 * 60 }],
    );
    expect(window.endMinute).toBe(21 * 60);
  });
});

describe("availabilityProblem", () => {
  it("passes a sound week", () => {
    expect(
      availabilityProblem([
        { weekday: 1, startMinute: 540, endMinute: 720 },
        { weekday: 1, startMinute: 780, endMinute: 1020 },
        { weekday: 2, startMinute: 540, endMinute: 1020 },
      ]),
    ).toBeNull();
  });

  it("rejects a window that ends at or before it starts, naming the day", () => {
    expect(availabilityProblem([{ weekday: 1, startMinute: 720, endMinute: 540 }])).toMatch(
      /Monday.*end after/,
    );
    expect(availabilityProblem([{ weekday: 3, startMinute: 540, endMinute: 540 }])).toMatch(
      /Wednesday/,
    );
  });

  it("rejects two windows overlapping on the same weekday", () => {
    expect(
      availabilityProblem([
        { weekday: 1, startMinute: 540, endMinute: 720 },
        { weekday: 1, startMinute: 660, endMinute: 900 },
      ]),
    ).toMatch(/Monday.*overlap/);
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

describe("clock helpers", () => {
  it("clockLabel is 24-hour", () => {
    expect(clockLabel(9 * 60)).toBe("9:00");
    expect(clockLabel(14 * 60 + 30)).toBe("14:30");
  });

  it("timeToMinutes parses and rejects", () => {
    expect(timeToMinutes("09:30")).toBe(570);
    expect(timeToMinutes("24:00")).toBeNull();
    expect(timeToMinutes("9:30")).toBeNull();
    expect(timeToMinutes("bad")).toBeNull();
  });

  it("minutesToTime is the inverse for a valid minute", () => {
    expect(minutesToTime(570)).toBe("09:30");
    expect(timeToMinutes(minutesToTime(725))).toBe(725);
  });
});

describe("the drawn day is a canvas, not a summary", () => {
  it("never shrinks below a working day around what is already booked", () => {
    // A calendar with no hours and one late-morning appointment must still offer the
    // afternoon to drag into, or a second appointment cannot be written at all.
    const window = dayWindow([], [{ startMinute: 10 * 60, endMinute: 11 * 60 + 30 }]);
    expect(window).toEqual({ startMinute: 8 * 60, endMinute: 18 * 60 });
  });

  it("still widens for anything outside that day, in both directions", () => {
    const early = dayWindow([], [{ startMinute: 6 * 60, endMinute: 7 * 60 }]);
    expect(early.startMinute).toBe(5 * 60);
    expect(early.endMinute).toBe(18 * 60);

    const late = dayWindow([], [{ startMinute: 20 * 60, endMinute: 21 * 60 }]);
    expect(late.startMinute).toBe(8 * 60);
    expect(late.endMinute).toBe(22 * 60);
  });
});

describe("a wall time inside a spring-forward gap", () => {
  /**
   * Havana jumps at midnight, so 00:00 on 8 March 2026 does not exist there.
   *
   * The old two-pass conversion answered with the instant *before* the gap, which in a zone
   * that jumps at midnight is 23:00 on the previous day. That was not a harmless rounding:
   * `calendarRange` bounds a view with `zonedTimeToUtc(lastDay + 1, 0)`, so the range ended an
   * hour early and an appointment in that hour failed `starts_at < to` — absent from the grid,
   * no error, nothing to notice.
   */
  it("resolves forward, not onto the day before", () => {
    const midnight = zonedTimeToUtc({ year: 2026, month: 3, day: 8 }, 0, "America/Havana");
    const back = zonedParts(midnight, "America/Havana");

    expect(back.day).toBe(8);
    expect(back.hour).toBe(1);
  });

  it("leaves an ordinary day and an autumn repeat alone", () => {
    const plain = zonedTimeToUtc({ year: 2026, month: 6, day: 10 }, 9 * 60, "America/Havana");
    expect(zonedParts(plain, "America/Havana")).toMatchObject({ day: 10, hour: 9, minute: 0 });

    // Lagos has no DST at all; midnight is midnight.
    const lagos = zonedTimeToUtc({ year: 2026, month: 3, day: 8 }, 0, "Africa/Lagos");
    expect(zonedParts(lagos, "Africa/Lagos")).toMatchObject({ day: 8, hour: 0 });
  });

  it("keeps a day view's range covering its whole last day", () => {
    const day = calendarRange("day", { year: 2026, month: 3, day: 7 }, "America/Havana");
    const endsAt = zonedParts(new Date(day.to), "America/Havana");

    // The exclusive end is the next day's first real instant, not 23:00 on the 7th.
    expect(endsAt.day).toBe(8);
  });
});
