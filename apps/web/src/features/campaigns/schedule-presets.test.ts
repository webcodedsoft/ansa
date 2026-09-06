import { describe, expect, it } from "vitest";

import { CUSTOM, nextMonday, offeredPresets, presetFor, STARTS, STOPS, thisFriday } from "./schedule-presets";

/* Local times, because the card resolves against the browser's clock and the inputs hold
   local wall-clock parts. Days chosen for their traps: a Sunday, a Friday night. */
const sunday = new Date(2026, 8, 6, 14, 0); // Sun 6 Sep 2026
const wednesday = new Date(2026, 8, 9, 10, 0);
const fridayNight = new Date(2026, 8, 11, 21, 0);

const nine = { startHour: 9, endHour: 17, weekdays: [1, 2, 3, 4, 5] };

const find = (key: string, presets = STARTS) => {
  const preset = presets.find((one) => one.key === key);
  if (preset === undefined) throw new Error(`no preset ${key}`);
  return preset;
};

describe("when a run starts", () => {
  it("lands tomorrow on the first hour the campaign may ring", () => {
    expect(find("tomorrow").resolve(wednesday, null)).toEqual({ date: "2026-09-10", time: "08:00" });
    expect(find("tomorrow").resolve(wednesday, nine)).toEqual({ date: "2026-09-10", time: "09:00" });
  });

  it("finds next Monday from any day, never today", () => {
    expect(nextMonday(wednesday).getDate()).toBe(14);
    expect(nextMonday(sunday).getDate()).toBe(7);
    // On a Monday, next Monday is a week away, not this morning.
    expect(nextMonday(new Date(2026, 8, 7, 9, 0)).getDate()).toBe(14);
  });

  it("offers one chip per moment, so a Sunday does not show tomorrow twice", () => {
    const offered = offeredPresets(STARTS, sunday, null);
    expect(offered.map((one) => one.key)).toEqual(["tomorrow", "week"]);
    // And on a Wednesday all three are different mornings.
    expect(offeredPresets(STARTS, wednesday, null).map((one) => one.key)).toEqual(["tomorrow", "monday", "week"]);
  });
});

describe("when a run stops", () => {
  it("ends today at the last hour it may ring", () => {
    expect(find("today", STOPS).resolve(wednesday, null)).toEqual({ date: "2026-09-09", time: "20:00" });
    expect(find("today", STOPS).resolve(wednesday, nine)).toEqual({ date: "2026-09-09", time: "17:00" });
  });

  it("rolls the end of the week over once Friday's calls are done", () => {
    expect(thisFriday(wednesday).getDate()).toBe(11);
    expect(thisFriday(fridayNight).getDate()).toBe(18);
  });
});

describe("reading a saved time back", () => {
  it("names the preset that produces it, and custom for any other", () => {
    expect(presetFor(find("tomorrow").resolve(wednesday, null), STARTS, wednesday, null)).toBe("tomorrow");
    expect(presetFor({ date: "2026-09-10", time: "08:30" }, STARTS, wednesday, null)).toBe(CUSTOM);
    expect(presetFor({ date: "", time: "" }, STARTS, wednesday, null)).toBeNull();
  });
});
