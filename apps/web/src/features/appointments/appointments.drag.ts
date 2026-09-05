/**
 * Turning a gesture on the grid into a span of time.
 *
 * Pointer maths, kept out of the component so it can be asserted on rather than dragged at.
 * The grid is a fixed number of pixels per hour, so a Y offset inside a day column *is* a
 * minute of that day; everything here is the arithmetic between that raw minute and the span
 * an appointment is actually given.
 *
 * The rules are the ones a person expects without being told:
 *
 *   - Times land on a quarter hour, so a hand-drawn drag reads as 10:15 and not 10:13. A
 *     calendar whose slots are shorter than that snaps to the slot instead, because on a
 *     ten-minute calendar every second slot would otherwise be unreachable by mouse.
 *   - Dragging upward means the same span as dragging downward across it. The pointer does
 *     not know which end you started from and neither should the appointment.
 *   - A click is a drag of no distance, and means "one default length starting here" rather
 *     than an appointment of zero minutes.
 *   - Nothing runs past the end of the day it started in. A drag that reaches the bottom of
 *     the column stops there rather than silently becoming tomorrow's problem.
 */

/** Where times land by default. A quarter hour is what a hand can aim at on an hour of pixels. */
export const SNAP_MINUTES = 15;

/**
 * The snap increment for a calendar whose slots are `slotMinutes` long.
 *
 * Never coarser than the slot: a calendar that offers ten-minute appointments must be able to
 * express one, and snapping that to fifteen would put half its slots out of reach of a mouse.
 */
export const snapStepFor = (slotMinutes: number): number =>
  slotMinutes > 0 && slotMinutes < SNAP_MINUTES ? slotMinutes : SNAP_MINUTES;

/** Round a minute to the nearest step. */
export const snapMinute = (minute: number, step: number): number =>
  step <= 0 ? Math.round(minute) : Math.round(minute / step) * step;

/**
 * The minute of the day a pointer is over, given its offset down a column.
 *
 * Unsnapped and unclamped on purpose — this is the reading, and what to do about a reading
 * past the end of the column is `dragSpan`'s decision, not this one's.
 */
export const minuteAt = (offsetPx: number, hourPx: number, dayStartMinute: number): number =>
  dayStartMinute + (offsetPx / hourPx) * 60;

export interface Span {
  readonly startMinute: number;
  readonly endMinute: number;
}

/**
 * The span a gesture asks for, snapped, ordered and kept inside the day.
 *
 * `anchorMinute` is where the pointer went down and `pointerMinute` is where it is now or was
 * released; either may be the earlier of the two. A gesture that covers less than one step is
 * a click, and gets `defaultMinutes` starting where it was clicked.
 *
 * The clamp runs last and moves the *start* when it has to. Pushing the end back instead would
 * quietly shorten an appointment dragged against the bottom of the grid, which reads as the
 * drag having failed; moving the whole span up keeps the length the gesture asked for.
 */
export const dragSpan = ({
  anchorMinute,
  pointerMinute,
  step,
  defaultMinutes,
  dayStartMinute,
  dayEndMinute,
}: {
  readonly anchorMinute: number;
  readonly pointerMinute: number;
  readonly step: number;
  readonly defaultMinutes: number;
  readonly dayStartMinute: number;
  readonly dayEndMinute: number;
}): Span => {
  const anchor = snapMinute(anchorMinute, step);
  const pointer = snapMinute(pointerMinute, step);

  const low = Math.min(anchor, pointer);
  const high = Math.max(anchor, pointer);

  /* Less than one step of travel is a click, not a drag: give it a normal-length appointment
     starting where the pointer went down rather than an empty one. */
  const length = high - low <= 0 ? Math.max(defaultMinutes, step) : high - low;
  const from = high - low <= 0 ? anchor : low;

  return clampSpan({ startMinute: from, endMinute: from + length }, dayStartMinute, dayEndMinute);
};

/**
 * Hold a span inside the day, keeping its length if the day is long enough to hold it.
 *
 * An appointment longer than the drawn day — a two-hour drag on a calendar that draws a
 * ninety-minute window — is given the whole day rather than being refused. The grid is a view
 * of the day, not the definition of one, and the alternative is a gesture that does nothing.
 */
export const clampSpan = (span: Span, dayStartMinute: number, dayEndMinute: number): Span => {
  const dayLength = dayEndMinute - dayStartMinute;
  const length = Math.min(span.endMinute - span.startMinute, dayLength);
  const start = Math.min(Math.max(span.startMinute, dayStartMinute), dayEndMinute - length);
  return { startMinute: start, endMinute: start + length };
};

/** `13:05` in the calendar's own clock, for prefilling a time field. */
export const minuteToInput = (minute: number): string => {
  const whole = Math.max(0, Math.round(minute));
  const hours = Math.floor(whole / 60) % 24;
  const minutes = whole % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};
