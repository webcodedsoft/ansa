import { describe, expect, it } from "vitest";

import {
  SCHEDULE_DAYS,
  addMonths,
  calendarRange,
  daysInMonth,
  parseView,
  parseWeekends,
  rangeTitle,
  stepAnchor,
  bookingLabel,
} from "./appointments.range";
import { isoDate, type PlainDate } from "./appointments.time";

const date = (year: number, month: number, day: number): PlainDate => ({ year, month, day });

describe("reading the view out of the URL", () => {
  it("takes the three it knows and falls back to the week", () => {
    expect(parseView("day")).toBe("day");
    expect(parseView("month")).toBe("month");
    expect(parseView("week")).toBe("week");
    expect(parseView(undefined)).toBe("week");
    expect(parseView("agenda")).toBe("week");
  });
});

describe("stepping a month", () => {
  it("knows how long a month is, leap years included", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it("clamps the day rather than overflowing into the month after next", () => {
    // The bug this exists to prevent: 31 Jan + 1 month landing on 3 March and skipping
    // February entirely, so a "next month" button never shows it.
    expect(addMonths(date(2026, 1, 31), 1)).toEqual(date(2026, 2, 28));
    expect(addMonths(date(2028, 1, 31), 1)).toEqual(date(2028, 2, 29));
    expect(addMonths(date(2026, 3, 31), 1)).toEqual(date(2026, 4, 30));
  });

  it("crosses years in both directions", () => {
    expect(addMonths(date(2026, 12, 15), 1)).toEqual(date(2027, 1, 15));
    expect(addMonths(date(2026, 1, 15), -1)).toEqual(date(2025, 12, 15));
    expect(addMonths(date(2026, 6, 10), -18)).toEqual(date(2024, 12, 10));
  });

  it("steps a whole month at a time from the 31st without stalling", () => {
    // Two presses of "next" from 31 January must reach March, not sit on February.
    const first = addMonths(date(2026, 1, 31), 1);
    expect(addMonths(first, 1)).toEqual(date(2026, 3, 28));
  });
});

describe("the step a button means depends on the view", () => {
  const anchor = date(2026, 3, 4); // a Wednesday

  it("moves a day, a week, or a month", () => {
    expect(stepAnchor("day", anchor, 1)).toEqual(date(2026, 3, 5));
    expect(stepAnchor("month", anchor, 1)).toEqual(date(2026, 4, 4));
  });

  it("lands the week step on a Monday and stays there", () => {
    const next = stepAnchor("week", anchor, 1);
    expect(isoDate(next)).toBe("2026-03-09");
    expect(isoDate(stepAnchor("week", next, 1))).toBe("2026-03-16");
    expect(isoDate(stepAnchor("week", anchor, -1))).toBe("2026-02-23");
  });
});

describe("the days a view draws", () => {
  const zone = "Africa/Lagos";

  it("draws one day, seven days, or six whole weeks", () => {
    expect(calendarRange("day", date(2026, 3, 4), zone).days).toHaveLength(1);
    expect(calendarRange("week", date(2026, 3, 4), zone).days).toHaveLength(7);
    expect(calendarRange("month", date(2026, 3, 4), zone).days).toHaveLength(42);
  });

  it("starts the week on Monday whatever day the anchor is", () => {
    const week = calendarRange("week", date(2026, 3, 4), zone);
    expect(week.days[0]?.iso).toBe("2026-03-02");
    expect(week.days[6]?.iso).toBe("2026-03-08");
  });

  it("pads the month from the months either side and marks them outside", () => {
    // March 2026 begins on a Sunday, so the grid opens on Monday 23 February.
    const month = calendarRange("month", date(2026, 3, 1), zone);
    expect(month.days[0]?.iso).toBe("2026-02-23");
    expect(month.days[0]?.inPeriod).toBe(false);
    expect(month.days.filter((day) => day.inPeriod)).toHaveLength(31);
    expect(month.weeks).toHaveLength(6);
    expect(month.weeks.every((week) => week.length === 7)).toBe(true);
  });

  it("always holds the 1st in its first row", () => {
    // Six rows from the Monday on or before the 1st: the row can never miss it.
    for (let month = 1; month <= 12; month += 1) {
      const grid = calendarRange("month", date(2026, month, 1), zone);
      const firstRow = grid.weeks[0] ?? [];
      expect(firstRow.some((day) => day.dayNumber === 1 && day.inPeriod)).toBe(true);
    }
  });

  it("marks today only on today, in the calendar's zone", () => {
    const week = calendarRange("week", date(2026, 3, 4), zone, { today: date(2026, 3, 5) });
    expect(week.days.filter((day) => day.isToday).map((day) => day.iso)).toEqual(["2026-03-05"]);
  });

  it("marks no day today when today is outside the range drawn", () => {
    const week = calendarRange("week", date(2026, 3, 4), zone, { today: date(2026, 9, 5) });
    expect(week.days.some((day) => day.isToday)).toBe(false);
  });
});

describe("the instants a view fetches", () => {
  it("bounds a day by that day's own midnights in the calendar's zone", () => {
    // Lagos is UTC+1 with no DST, so midnight there is 23:00 UTC the day before.
    const day = calendarRange("day", date(2026, 3, 4), "Africa/Lagos");
    expect(day.from).toBe("2026-03-03T23:00:00.000Z");
    expect(day.to).toBe("2026-03-04T23:00:00.000Z");
  });

  it("gives a spring-forward week 167 hours, not a hopeful 168", () => {
    // London moves to BST on Sunday 29 March 2026, so that week is an hour short.
    const week = calendarRange("week", date(2026, 3, 23), "Europe/London");
    const hours = (Date.parse(week.to) - Date.parse(week.from)) / 3_600_000;
    expect(hours).toBe(167);
  });

  it("gives an autumn-back week 169 hours", () => {
    // BST ends on Sunday 25 October 2026, the last day of that week.
    const week = calendarRange("week", date(2026, 10, 19), "Europe/London");
    const hours = (Date.parse(week.to) - Date.parse(week.from)) / 3_600_000;
    expect(hours).toBe(169);
  });

  it("covers a leap day", () => {
    const month = calendarRange("month", date(2028, 2, 1), "Africa/Lagos");
    expect(month.days.some((day) => day.iso === "2028-02-29" && day.inPeriod)).toBe(true);
  });
});

describe("what a view is called", () => {
  it("names a month, a day, and a week inside one month", () => {
    expect(rangeTitle("month", date(2026, 3, 4))).toBe("March 2026");
    expect(rangeTitle("day", date(2026, 3, 4))).toBe("4 March 2026");
    expect(rangeTitle("week", date(2026, 3, 4))).toBe("2–8 March 2026");
  });

  it("widens across a month and across a year, never dropping the year", () => {
    expect(rangeTitle("week", date(2026, 4, 1))).toBe("30 March – 5 April 2026");
    expect(rangeTitle("week", date(2026, 12, 31))).toBe("28 December 2026 – 3 January 2027");
  });
});

describe("what an appointment is called on the grid", () => {
  it("prefers the title, then the note, then the state it is in", () => {
    expect(bookingLabel({ status: "booked", title: "Second viewing", notes: "bring keys" }))
      .toBe("Second viewing");
    expect(bookingLabel({ status: "booked", title: null, notes: "bring keys" })).toBe("bring keys");
    expect(bookingLabel({ status: "booked", title: "   ", notes: null })).toBe("Booked");
    expect(bookingLabel({ status: "held", title: null, notes: "  " })).toBe("Held");
  });
});


describe("the schedule looks forward, not around", () => {
  const zone = "Africa/Lagos";

  it("starts on the anchor rather than rewinding to its Monday", () => {
    // "What is coming up" starts today; opening on Monday would show days already gone.
    const schedule = calendarRange("schedule", date(2026, 3, 4), zone);
    expect(schedule.days[0]?.iso).toBe("2026-03-04");
    expect(schedule.days).toHaveLength(SCHEDULE_DAYS);
  });

  it("steps a whole span at a time and crosses the month end", () => {
    expect(isoDate(stepAnchor("schedule", date(2026, 3, 4), 1))).toBe("2026-04-03");
    expect(isoDate(stepAnchor("schedule", date(2026, 3, 4), -1))).toBe("2026-02-02");
  });

  it("is named by the span it covers", () => {
    expect(rangeTitle("schedule", date(2026, 3, 4))).toBe("4 March – 2 April 2026");
  });

  it("takes its shortcut key and survives an unknown view", () => {
    expect(parseView("schedule")).toBe("schedule");
    expect(parseView("year")).toBe("week");
  });
});

describe("hiding weekends drops columns, never the query", () => {
  const zone = "Africa/Lagos";

  it("is on unless the URL says otherwise", () => {
    expect(parseWeekends(undefined)).toBe(true);
    expect(parseWeekends("1")).toBe(true);
    expect(parseWeekends("0")).toBe(false);
  });

  it("draws five weekdays instead of seven", () => {
    const week = calendarRange("week", date(2026, 3, 4), zone, { showWeekends: false });
    expect(week.days).toHaveLength(5);
    expect(week.days.map((day) => day.shortLabel)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
    expect(week.weeks[0]).toHaveLength(5);
  });

  it("still fetches the whole span, so a Saturday booking is not silently unfetched", () => {
    const shown = calendarRange("week", date(2026, 3, 4), zone, { showWeekends: false });
    const all = calendarRange("week", date(2026, 3, 4), zone);
    expect(shown.from).toBe(all.from);
    expect(shown.to).toBe(all.to);
  });

  it("keeps the month grid in whole five-day rows", () => {
    const month = calendarRange("month", date(2026, 3, 1), zone, { showWeekends: false });
    expect(month.weeks).toHaveLength(6);
    expect(month.weeks.every((week) => week.length === 5)).toBe(true);
    expect(month.days.every((day) => day.weekday !== 0 && day.weekday !== 6)).toBe(true);
  });

  it("leaves the day and schedule views alone — a Saturday asked for is a Saturday shown", () => {
    const saturday = calendarRange("day", date(2026, 3, 7), zone, { showWeekends: false });
    expect(saturday.days).toHaveLength(1);
    expect(saturday.days[0]?.iso).toBe("2026-03-07");

    const schedule = calendarRange("schedule", date(2026, 3, 4), zone, { showWeekends: false });
    expect(schedule.days).toHaveLength(SCHEDULE_DAYS);
  });
});
