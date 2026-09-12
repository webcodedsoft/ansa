import { describe, expect, it } from "vitest";

import { daysLabel, hourLabel, nowInWat, openNow } from "./org.display";

const HOURS = { opensAtHour: 8, closesAtHour: 19, openDays: [1, 2, 3, 4, 5, 6] };

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

  it("stamps now in WAT", () => {
    expect(nowInWat(new Date("2026-09-12T13:02:00.000Z"))).toBe("14:02");
  });
});
