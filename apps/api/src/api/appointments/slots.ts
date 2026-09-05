/**
 * Turning opening hours into offerable times.
 *
 * `packages/db/src/appointments.ts` is deliberate about not doing this: "Thursday at two is
 * free" is the weekly availability pattern expanded over real dates in the calendar's
 * timezone, minus the live bookings, minus the buffer — arithmetic that belongs beside the
 * timezone library rather than in SQL that cannot see one. This is that arithmetic.
 *
 * It is pure: dates and numbers in, slots out, no I/O and no clock of its own. The one thing
 * it has to get right is the timezone. Availability is stored as a weekday and minutes past
 * midnight *in the calendar's zone*, so nine in the morning is nine in the morning whether or
 * not the clocks have gone forward — and the UTC instant that nine o'clock maps to moves by an
 * hour across a DST boundary. Stepping through slots in UTC would drift by that hour; every
 * boundary here is computed from wall-clock components in the zone instead, so it does not.
 */

/** True when `Intl` recognises the zone. A made-up zone throws `RangeError` on construction. */
export const isValidTimezone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
};

/**
 * The zone's offset from UTC at a given instant, in milliseconds, positive east of UTC.
 *
 * Found by formatting the instant in the zone and reading how far the wall clock there is
 * from the same components read as UTC. This is the value that changes across a DST boundary,
 * and every conversion below is built on it.
 */
const tzOffsetMs = (instant: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const field = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"));
  return asUtc - instant.getTime();
};

/**
 * The UTC instant of a wall-clock time in the zone.
 *
 * The guess reads the wall components as though they were UTC, then shifts by the offset.
 * The offset itself depends on the instant, so on a day the clocks change the first guess can
 * land on the wrong side of the transition — the second read corrects it. A wall time inside a
 * spring-forward gap does not exist; it resolves to one side rather than throwing, which for a
 * window boundary is harmless.
 */
const wallTimeToInstant = (
  year: number,
  month: number,
  day: number,
  minutes: number,
  timeZone: string,
): Date => {
  const utcGuess = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  const firstOffset = tzOffsetMs(new Date(utcGuess), timeZone);
  const instant = utcGuess - firstOffset;
  const secondOffset = tzOffsetMs(new Date(instant), timeZone);
  return new Date(secondOffset === firstOffset ? instant : utcGuess - secondOffset);
};

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * An instant as ISO-8601 carrying the calendar's own offset, e.g. `2026-03-15T09:00:00+01:00`.
 *
 * A caller reading a slot list wants the local time it will speak to the caller, and the offset
 * beside it so the instant is still unambiguous. `Date#toISOString` gives the instant in `Z`
 * and loses the local reading; this keeps both.
 */
export const toOffsetIso = (instant: Date, timeZone: string): string => {
  const offsetMs = tzOffsetMs(instant, timeZone);
  const local = new Date(instant.getTime() + offsetMs);
  const totalMinutes = Math.round(Math.abs(offsetMs) / 60000);
  const sign = offsetMs < 0 ? "-" : "+";
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(totalMinutes / 60))}:${pad(totalMinutes % 60)}`
  );
};

/** A recurring opening, as `AvailabilityWindow` has it: weekday 0 (Sunday) to 6, minutes past midnight. */
export interface SlotWindow {
  readonly weekday: number;
  readonly startMinute: number;
  readonly endMinute: number;
}

/** A slot the arithmetic must subtract: a live booking or an unexpired hold. Only its span matters. */
export interface SlotBooking {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface SlotRequest {
  readonly timeZone: string;
  readonly slotMinutes: number;
  readonly bufferMinutes: number;
  readonly windows: readonly SlotWindow[];
  readonly bookings: readonly SlotBooking[];
  readonly from: Date;
  readonly to: Date;
}

export interface Slot {
  readonly start: Date;
  readonly end: Date;
}

/**
 * Why a set of availability windows cannot be saved, or null when it can.
 *
 * The schema already holds each field to its range; this holds the pair and the set: an end
 * must come after its start, and two windows on the same weekday must not overlap — an agent
 * cannot offer the same minute twice. Weekday-by-weekday, because Tuesday and Wednesday
 * windows never collide.
 */
export const availabilityProblem = (windows: readonly SlotWindow[]): string | null => {
  for (const window of windows) {
    if (window.startMinute >= window.endMinute) {
      return "each window must end after it starts";
    }
  }
  for (let weekday = 0; weekday <= 6; weekday += 1) {
    const ofDay = windows
      .filter((window) => window.weekday === weekday)
      .slice()
      .sort((a, b) => a.startMinute - b.startMinute);
    for (let index = 1; index < ofDay.length; index += 1) {
      const previous = ofDay[index - 1];
      const current = ofDay[index];
      if (previous !== undefined && current !== undefined && current.startMinute < previous.endMinute) {
        return "windows on the same weekday must not overlap";
      }
    }
  }
  return null;
};

const localDate = (instant: Date, timeZone: string): { year: number; month: number; day: number } => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const field = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: field("year"), month: field("month"), day: field("day") };
};

/**
 * The bookable slots in `[from, to)`.
 *
 * Each calendar day in the zone contributes its weekday's windows; each window is stepped in
 * `slotMinutes` from its start, keeping only whole slots that fit. A slot is dropped if it
 * falls outside the range, or if it touches any booking once that booking is grown by the
 * buffer on both sides — the buffer is dead time around an appointment, so a slot inside it is
 * not free even though nothing is booked in the slot itself.
 */
export const computeFreeSlots = (request: SlotRequest): readonly Slot[] => {
  const { timeZone, slotMinutes, bufferMinutes, windows, bookings, from, to } = request;
  if (from.getTime() >= to.getTime() || slotMinutes <= 0 || windows.length === 0) return [];

  const slotMs = slotMinutes * 60000;
  const bufferMs = bufferMinutes * 60000;
  const fromMs = from.getTime();
  const toMs = to.getTime();

  const conflicts = (start: Date, end: Date): boolean =>
    bookings.some(
      (booking) =>
        start.getTime() < booking.endsAt.getTime() + bufferMs &&
        end.getTime() > booking.startsAt.getTime() - bufferMs,
    );

  const start = localDate(from, timeZone);
  const end = localDate(to, timeZone);
  const lastDayMs = Date.UTC(end.year, end.month - 1, end.day);

  const slots: Slot[] = [];
  // A pure calendar cursor at UTC midnight — UTC has no DST, so stepping a day is exactly 24h
  // and the weekday it reports is the weekday of that calendar date in every zone.
  for (
    let cursor = Date.UTC(start.year, start.month - 1, start.day);
    cursor <= lastDayMs;
    cursor += 24 * 60 * 60 * 1000
  ) {
    const day = new Date(cursor);
    const weekday = day.getUTCDay();
    for (const window of windows) {
      if (window.weekday !== weekday) continue;
      const windowStart = wallTimeToInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), window.startMinute, timeZone).getTime();
      const windowEnd = wallTimeToInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), window.endMinute, timeZone).getTime();
      for (let slotStart = windowStart; slotStart + slotMs <= windowEnd; slotStart += slotMs) {
        const slotEnd = slotStart + slotMs;
        if (slotStart < fromMs || slotEnd > toMs) continue;
        const candidate = { start: new Date(slotStart), end: new Date(slotEnd) };
        if (!conflicts(candidate.start, candidate.end)) slots.push(candidate);
      }
    }
  }

  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
};
