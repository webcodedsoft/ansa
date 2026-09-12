import { describe, expect, it } from "vitest";

import { closedDaysLabel, daysLabel, hourLabel, nowInWat, openNow } from "./org.display";

const HOURS = { opensAtHour: 8, closesAtHour: 19, openDays: [1, 2, 3, 4, 5, 6], closedDates: [] };

describe("whether the organisation is open right now", () => {
  it("reads the clock in WAT, not in UTC", () => {
    // 07:30 UTC is 08:30 in Lagos — open, though the UTC hour is before opening.
    expect(openNow(HOURS, new Date("2026-09-12T07:30:00.000Z"))).toBe(true);
    // 18:30 UTC is 19:30 in Lagos — closed, though the UTC hour is before closing.
    expect(openNow(HOURS, new Date("2026-09-12T18:30:00.000Z"))).toBe(false);
  });

  it("treats the closing hour as exclusive, the way the call path does", () => {
    // 18:00 UTC is exactly 19:00 WAT: shut at five holds 17, shut at seven holds 19.
    expect(openNow(HOURS, new Date("2026-09-12T18:00:00.000Z"))).toBe(false);
  });

  it("is closed on a day the organisation does not open", () => {
    // 13 September 2026 is a Sunday.
    expect(openNow(HOURS, new Date("2026-09-13T11:00:00.000Z"))).toBe(false);
  });

  it("is closed on a closed date, even on an open weekday inside the hours", () => {
    // Saturday 12 September 2026, 11:00 WAT — open by the pattern, shut by the calendar.
    const holiday = { ...HOURS, closedDates: ["2026-09-12"] };
    expect(openNow(holiday, new Date("2026-09-12T10:00:00.000Z"))).toBe(false);
  });

  it("is always open when no hours are set, which is what the API means by null", () => {
    expect(openNow(null, new Date("2026-09-13T02:00:00.000Z"))).toBe(true);
  });
});

describe("how hours and days are said", () => {
  it("names a bound the organisation has left to the platform", () => {
    expect(hourLabel(8)).toBe("08:00");
    expect(hourLabel(null)).toBe("not narrowed");
  });

  it("collapses a run of days and lists the rest", () => {
    expect(daysLabel([1, 2, 3, 4, 5, 6])).toBe("Mon–Sat");
    expect(daysLabel([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(daysLabel([1, 2, 3, 4, 5, 6, 7])).toBe("every day");
    expect(daysLabel([])).toBe("no days");
  });

  it("counts only the closed dates still to come this year, and lists at most three", () => {
    const now = new Date("2026-09-12T13:02:00.000Z");
    expect(closedDaysLabel([], now)).toBe("none this year");
    expect(closedDaysLabel(["2026-10-01", "2026-12-25", "2026-06-12"], now)).toBe("2 this year · 1 Oct, 25 Dec");
    expect(closedDaysLabel(["2026-10-01", "2026-12-25", "2026-12-26", "2026-11-01", "2027-01-01"], now)).toBe(
      "4 this year · 1 Oct, 1 Nov, 25 Dec +1",
    );
  });

  it("stamps now in WAT", () => {
    expect(nowInWat(new Date("2026-09-12T13:02:00.000Z"))).toBe("14:02");
  });
});
