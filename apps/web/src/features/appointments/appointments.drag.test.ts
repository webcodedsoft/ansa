import { describe, expect, it } from "vitest";

import {
  clampSpan,
  dragSpan,
  minuteAt,
  minuteToInput,
  snapMinute,
  snapStepFor,
} from "./appointments.drag";

const DAY = { dayStartMinute: 8 * 60, dayEndMinute: 18 * 60 };

describe("the snap increment", () => {
  it("is a quarter hour for an ordinary calendar", () => {
    expect(snapStepFor(30)).toBe(15);
    expect(snapStepFor(60)).toBe(15);
    expect(snapStepFor(15)).toBe(15);
  });

  it("follows a calendar whose slots are shorter, so every slot stays reachable", () => {
    expect(snapStepFor(10)).toBe(10);
    expect(snapStepFor(5)).toBe(5);
  });

  it("does not divide by a nonsense slot length", () => {
    expect(snapStepFor(0)).toBe(15);
    expect(snapMinute(613, 0)).toBe(613);
  });
});

describe("reading a pointer as a minute", () => {
  it("maps the top of the column to the start of the drawn day", () => {
    expect(minuteAt(0, 52, 480)).toBe(480);
  });

  it("maps one hour of pixels to one hour", () => {
    expect(minuteAt(52, 52, 480)).toBe(540);
    expect(minuteAt(26, 52, 480)).toBe(510);
  });
});

describe("a drag becomes a span", () => {
  it("snaps a hand-drawn drag onto the quarter hour", () => {
    const span = dragSpan({
      anchorMinute: 543, // 09:03
      pointerMinute: 611, // 10:11
      step: 15,
      defaultMinutes: 30,
      ...DAY,
    });
    expect(span).toEqual({ startMinute: 540, endMinute: 615 });
  });

  it("means the same thing dragged upward as dragged downward", () => {
    const down = dragSpan({ anchorMinute: 540, pointerMinute: 660, step: 15, defaultMinutes: 30, ...DAY });
    const up = dragSpan({ anchorMinute: 660, pointerMinute: 540, step: 15, defaultMinutes: 30, ...DAY });
    expect(up).toEqual(down);
    expect(down).toEqual({ startMinute: 540, endMinute: 660 });
  });

  it("treats a click with no travel as one default length at that time", () => {
    const span = dragSpan({ anchorMinute: 540, pointerMinute: 540, step: 15, defaultMinutes: 30, ...DAY });
    expect(span).toEqual({ startMinute: 540, endMinute: 570 });
  });

  it("treats a twitch shorter than one step as a click, not a zero-length appointment", () => {
    const span = dragSpan({ anchorMinute: 541, pointerMinute: 545, step: 15, defaultMinutes: 30, ...DAY });
    expect(span.endMinute - span.startMinute).toBe(30);
  });

  it("gives a click at least one step even when the default is smaller", () => {
    const span = dragSpan({ anchorMinute: 540, pointerMinute: 540, step: 15, defaultMinutes: 5, ...DAY });
    expect(span.endMinute - span.startMinute).toBe(15);
  });

  it("keeps the length when a drag runs past the bottom of the day, moving the start up", () => {
    // Released below the column: the gesture asked for an hour, and gets an hour that fits.
    const span = dragSpan({
      anchorMinute: 17 * 60 + 30,
      pointerMinute: 21 * 60,
      step: 15,
      defaultMinutes: 30,
      ...DAY,
    });
    expect(span.endMinute).toBe(18 * 60);
    expect(span.startMinute).toBe(14 * 60 + 30);
  });

  it("holds a drag above the top of the day down to the start", () => {
    const span = dragSpan({
      anchorMinute: 8 * 60 + 30,
      pointerMinute: 5 * 60,
      step: 15,
      defaultMinutes: 30,
      ...DAY,
    });
    expect(span.startMinute).toBe(8 * 60);
    // 05:00 to 08:30 is three and a half hours, and the length survives the clamp.
    expect(span.endMinute).toBe(11 * 60 + 30);
  });

  it("gives the whole drawn day to a drag longer than it, rather than refusing", () => {
    const span = dragSpan({
      anchorMinute: 0,
      pointerMinute: 24 * 60,
      step: 15,
      defaultMinutes: 30,
      ...DAY,
    });
    expect(span).toEqual({ startMinute: 8 * 60, endMinute: 18 * 60 });
  });
});

describe("holding a span inside the day", () => {
  it("leaves one that already fits alone", () => {
    const span = { startMinute: 600, endMinute: 660 };
    expect(clampSpan(span, 480, 1080)).toEqual(span);
  });

  it("never returns a start after its end", () => {
    const span = clampSpan({ startMinute: 1200, endMinute: 1260 }, 480, 1080);
    expect(span.startMinute).toBeLessThan(span.endMinute);
    expect(span.endMinute).toBeLessThanOrEqual(1080);
  });
});

describe("filling a time field", () => {
  it("writes a two-digit 24-hour clock", () => {
    expect(minuteToInput(0)).toBe("00:00");
    expect(minuteToInput(9 * 60 + 5)).toBe("09:05");
    expect(minuteToInput(13 * 60 + 30)).toBe("13:30");
    expect(minuteToInput(23 * 60 + 59)).toBe("23:59");
  });

  it("shows the end of the day as midnight rather than as hour 24", () => {
    expect(minuteToInput(24 * 60)).toBe("00:00");
  });
});
