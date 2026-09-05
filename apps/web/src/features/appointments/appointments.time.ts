/**
 * The date and slot arithmetic the calendar view is built on.
 *
 * Pure: dates and strings in, plain data out, no I/O and no React. The whole point of
 * pulling it out here is that the one genuinely error-prone thing in this feature — placing
 * an instant on the right day and row of a grid drawn in a calendar's *own* timezone, which
 * is not the reader's — can be tested against `Africa/Lagos` without a browser or a call.
 *
 * The API already does the hard half: `slots` come back pre-expanded with the calendar's own
 * UTC offset, and `bookings` carry ISO instants. So this module never has to invent an
 * offset. It reads the wall clock an instant shows in the calendar's zone (`zonedParts`), and
 * — only to bound the week query — turns a wall time in that zone back into an instant
 * (`zonedTimeToUtc`). Nigeria keeps no DST, but the conversion is written to survive a zone
 * that does, because a calendar can be set to any IANA zone.
 */

/** Minutes in a day, for the day-window maths below. */
const DAY_MINUTES = 24 * 60;

/** Days in a displayed week. Monday-first, the way a working week is read. */
export const DAYS_IN_WEEK = 7;

/**
 * Weekday labels indexed the way the API counts them: 0 is Sunday, 6 is Saturday, which is
 * also what `Date.getDay()` returns. The availability editor stores these numbers, so the
 * labels and the storage cannot drift.
 */
export const WEEKDAY_LABELS: readonly string[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export const WEEKDAY_SHORT: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The IANA zones offered in the timezone picker, with the home zone first.
 *
 * `Intl.supportedValuesOf` returns the same list on the Node server and in the browser, so a
 * `<select>` built from it renders identically on both sides and does not trip hydration.
 * Falls back to a short hand-list if the runtime is too old to answer, rather than an empty
 * picker that cannot create a calendar at all.
 */
export const ianaZones = (): readonly string[] => {
  const home = "Africa/Lagos";
  const supported =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : null;
  const all =
    supported ?? [home, "Africa/Accra", "Africa/Nairobi", "Europe/London", "America/New_York", "UTC"];
  return [home, ...all.filter((zone) => zone !== home)];
};

/** The wall-clock fields an instant shows in a given zone. */
export interface ZonedParts {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly hour: number; // 0-23
  readonly minute: number; // 0-59
  readonly weekday: number; // 0 Sun … 6 Sat
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * What wall clock an instant reads as in `timeZone`.
 *
 * This is the one primitive the placement code needs: given a booking's ISO instant, which
 * day column and which minute of the day does it fall on for someone reading the calendar in
 * its own zone. Built on `Intl.DateTimeFormat`, which is the only thing in the platform that
 * knows a zone's offset — and its DST history — for an arbitrary instant.
 */
export const zonedParts = (instant: Date, timeZone: string): ZonedParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(instant);

  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
};

/** Minutes since midnight that an instant reads as in `timeZone`. */
export const minutesOfDay = (instant: Date, timeZone: string): number => {
  const { hour, minute } = zonedParts(instant, timeZone);
  return hour * 60 + minute;
};

/** A calendar date, decoupled from any clock, as the grid keys days by. */
export interface PlainDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
}

/** `YYYY-MM-DD`, the stable key and the URL form of a plain date. */
export const isoDate = (date: PlainDate): string =>
  `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;

/** Parse `YYYY-MM-DD`, or null when it is not one. Guards the `?week=` search param. */
export const parseIsoDate = (raw: string | undefined): PlainDate | null => {
  if (raw === undefined) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
};

/**
 * How far `timeZone` is ahead of UTC at a given instant, in milliseconds.
 *
 * Reads the instant's wall clock in the zone, treats those fields as if they were UTC, and
 * takes the difference. For Lagos this is a constant +3,600,000; for a DST zone it changes
 * across the year, which is exactly why it is derived per instant rather than hard-coded.
 */
const zoneOffsetMs = (instant: Date, timeZone: string): number => {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  // Seconds are dropped by zonedParts; align the comparison to the same minute.
  const flooredInstant = Math.floor(instant.getTime() / 60_000) * 60_000;
  return asUtc - flooredInstant;
};

/**
 * The instant at which the wall clock in `timeZone` reads the given date and time.
 *
 * The inverse of `zonedParts`, needed only to bound the week: "Monday 00:00 in the calendar's
 * zone" is an instant the slots and bookings queries take. One correction pass handles the
 * hour a DST transition skips or repeats; a no-DST zone settles on the first guess.
 */
export const zonedTimeToUtc = (
  date: PlainDate,
  minutesFromMidnight: number,
  timeZone: string,
): Date => {
  const hour = Math.floor(minutesFromMidnight / 60);
  const minute = minutesFromMidnight % 60;
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0);
  const firstGuess = new Date(wallAsUtc - zoneOffsetMs(new Date(wallAsUtc), timeZone));
  const secondOffset = zoneOffsetMs(firstGuess, timeZone);
  const settled = new Date(wallAsUtc - secondOffset);
  return settled;
};

/** Add whole days to a plain date, rolling months and years over correctly. */
export const addDays = (date: PlainDate, delta: number): PlainDate => {
  const base = new Date(Date.UTC(date.year, date.month - 1, date.day));
  base.setUTCDate(base.getUTCDate() + delta);
  return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() };
};

/** The weekday (0 Sun … 6 Sat) of a plain date. */
export const weekdayOf = (date: PlainDate): number =>
  new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();

/**
 * The Monday on or before a date. Sunday belongs to the week that just ended, the way a
 * working week is read, so it maps back six days rather than forward one.
 */
export const mondayOf = (date: PlainDate): PlainDate => {
  const weekday = weekdayOf(date);
  const backToMonday = weekday === 0 ? 6 : weekday - 1;
  return addDays(date, -backToMonday);
};

export interface WeekDay {
  readonly date: PlainDate;
  readonly iso: string;
  readonly weekday: number;
  readonly shortLabel: string;
}

/** The seven Monday-first days of the week containing `anchor`. */
export const weekDays = (anchor: PlainDate): readonly WeekDay[] => {
  const monday = mondayOf(anchor);
  return Array.from({ length: DAYS_IN_WEEK }, (_unused, index) => {
    const date = addDays(monday, index);
    const weekday = weekdayOf(date);
    return { date, iso: isoDate(date), weekday, shortLabel: WEEKDAY_SHORT[weekday] ?? "" };
  });
};

/** The [from, to) instants that bound a displayed week, for the slots and bookings queries. */
export const weekRange = (
  anchor: PlainDate,
  timeZone: string,
): { readonly from: string; readonly to: string } => {
  const days = weekDays(anchor);
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) {
    // Unreachable: weekDays always yields seven. Keeps the types honest without a cast.
    const now = new Date().toISOString();
    return { from: now, to: now };
  }
  const from = zonedTimeToUtc(first.date, 0, timeZone);
  const to = zonedTimeToUtc(addDays(last.date, 1), 0, timeZone);
  return { from: from.toISOString(), to: to.toISOString() };
};

/** Today as a plain date, read in `timeZone`. The calendar opens on the calendar's today. */
export const todayIn = (timeZone: string): PlainDate => {
  const { year, month, day } = zonedParts(new Date(), timeZone);
  return { year, month, day };
};

export interface PlacedSlot {
  readonly start: string;
  readonly end: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly label: string;
}

export interface PlacedBooking<T> {
  readonly booking: T;
  readonly startMinute: number;
  readonly endMinute: number;
}

/** `9:00` / `14:30`, 24-hour, the reading a Nigerian office clock shows. */
export const clockLabel = (minutes: number): string => {
  const clamped = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  return `${hour}:${String(minute).padStart(2, "0")}`;
};

/**
 * Group free slots into the day columns they belong to, in the calendar's zone.
 *
 * A slot is filed by the wall-clock day its start reads as, and carries its minute offsets so
 * the grid can place it without re-parsing. A slot whose day is not one of the seven — a query
 * that returned an edge instant — is dropped rather than forced into a column it does not
 * belong to.
 */
export const groupSlotsByDay = (
  slots: readonly { readonly start: string; readonly end: string }[],
  days: readonly WeekDay[],
  timeZone: string,
): ReadonlyMap<string, readonly PlacedSlot[]> => {
  const byDay = new Map<string, PlacedSlot[]>();
  for (const day of days) byDay.set(day.iso, []);

  for (const slot of slots) {
    const startInstant = new Date(slot.start);
    const parts = zonedParts(startInstant, timeZone);
    const key = isoDate({ year: parts.year, month: parts.month, day: parts.day });
    const bucket = byDay.get(key);
    if (bucket === undefined) continue;

    const startMinute = parts.hour * 60 + parts.minute;
    const endMinute = endMinuteOf(startInstant, new Date(slot.end), timeZone, startMinute);
    bucket.push({
      start: slot.start,
      end: slot.end,
      startMinute,
      endMinute,
      label: clockLabel(startMinute),
    });
  }
  for (const bucket of byDay.values()) bucket.sort((a, b) => a.startMinute - b.startMinute);
  return byDay;
};

/**
 * The end minute of an interval within its start day.
 *
 * An interval that ends on the next calendar day (a late slot crossing midnight) is clamped to
 * the end of the day it started, so a block never draws past the bottom of its column into the
 * wrong one. The common case — start and end on the same day — is the true end.
 */
const endMinuteOf = (start: Date, end: Date, timeZone: string, startMinute: number): number => {
  const startParts = zonedParts(start, timeZone);
  const endParts = zonedParts(end, timeZone);
  const sameDay =
    startParts.year === endParts.year &&
    startParts.month === endParts.month &&
    startParts.day === endParts.day;
  if (!sameDay) return DAY_MINUTES;
  const endMinute = endParts.hour * 60 + endParts.minute;
  return endMinute <= startMinute ? Math.min(startMinute + 1, DAY_MINUTES) : endMinute;
};

/**
 * Group bookings into day columns, keeping only those a caller has actually taken — held or
 * booked. Cancelled ones never come back from the API, but the type admits them, so the guard
 * is here rather than assumed.
 */
export const groupBookingsByDay = <
  T extends {
    readonly startsAt: string;
    readonly endsAt: string;
    readonly status: "held" | "booked" | "cancelled";
  },
>(
  bookings: readonly T[],
  days: readonly WeekDay[],
  timeZone: string,
): ReadonlyMap<string, readonly PlacedBooking<T>[]> => {
  const byDay = new Map<string, PlacedBooking<T>[]>();
  for (const day of days) byDay.set(day.iso, []);

  for (const booking of bookings) {
    if (booking.status === "cancelled") continue;
    const startInstant = new Date(booking.startsAt);
    const parts = zonedParts(startInstant, timeZone);
    const key = isoDate({ year: parts.year, month: parts.month, day: parts.day });
    const bucket = byDay.get(key);
    if (bucket === undefined) continue;

    const startMinute = parts.hour * 60 + parts.minute;
    const endMinute = endMinuteOf(startInstant, new Date(booking.endsAt), timeZone, startMinute);
    bucket.push({ booking, startMinute, endMinute });
  }
  for (const bucket of byDay.values()) bucket.sort((a, b) => a.startMinute - b.startMinute);
  return byDay;
};

/**
 * The vertical window the grid draws, in minutes since midnight.
 *
 * Narrowed to the hours that actually hold something — the calendar's open hours, widened to
 * cover any booking or slot that spills outside them — so a 9-to-5 calendar does not draw a
 * silent midnight-to-midnight cliff. Falls back to a plain working day when a calendar has no
 * hours and nothing booked yet, so the empty grid still looks like a calendar.
 */
/** The least a day ever draws: an ordinary office day, widened by whatever else is on it. */
const WORKING_DAY = { startMinute: 8 * 60, endMinute: 18 * 60 };

export const dayWindow = (
  availabilityMinutes: readonly { readonly startMinute: number; readonly endMinute: number }[],
  occupiedMinutes: readonly { readonly startMinute: number; readonly endMinute: number }[],
): { readonly startMinute: number; readonly endMinute: number } => {
  const spans = [...availabilityMinutes, ...occupiedMinutes];
  if (spans.length === 0) return { startMinute: WORKING_DAY.startMinute, endMinute: WORKING_DAY.endMinute };

  let earliest = DAY_MINUTES;
  let latest = 0;
  for (const span of spans) {
    if (span.startMinute < earliest) earliest = span.startMinute;
    if (span.endMinute > latest) latest = span.endMinute;
  }
  // Round out to whole hours and give a little air top and bottom, without leaving the day.
  const startMinute = Math.max(0, Math.floor(earliest / 60) * 60 - 60);
  const endMinute = Math.min(DAY_MINUTES, Math.ceil(latest / 60) * 60 + 60);

  /* Never narrower than a working day, only ever wider. The window is a canvas to write on,
     not a summary of what is already written — shrinking it around the day's one booking
     leaves nowhere to drag a second one, which is how a calendar with a single 10am
     appointment ends up drawing four hours and refusing the afternoon. */
  return {
    startMinute: Math.min(startMinute, WORKING_DAY.startMinute),
    endMinute: Math.max(Math.max(endMinute, startMinute + 60), WORKING_DAY.endMinute),
  };
};

/** A weekly availability window, as the editor holds and the API stores it. */
export interface AvailabilityWindow {
  readonly weekday: number;
  readonly startMinute: number;
  readonly endMinute: number;
}

/**
 * The first thing wrong with a proposed week, or null when it is sound.
 *
 * Mirrors the two rules the API enforces so the operator hears them before a round trip: every
 * window must end after it starts, and two windows on the same weekday must not overlap. The
 * message names the weekday, because a week has seven places the fault could be and "windows
 * overlap" without one sends the reader hunting.
 */
export const availabilityProblem = (windows: readonly AvailabilityWindow[]): string | null => {
  for (const window of windows) {
    if (window.endMinute <= window.startMinute) {
      return `${WEEKDAY_LABELS[window.weekday] ?? "A day"}: each open period must end after it starts.`;
    }
  }
  for (let day = 0; day < DAYS_IN_WEEK; day += 1) {
    const onDay = windows
      .filter((window) => window.weekday === day)
      .slice()
      .sort((a, b) => a.startMinute - b.startMinute);
    for (let index = 1; index < onDay.length; index += 1) {
      const previous = onDay[index - 1];
      const current = onDay[index];
      if (previous !== undefined && current !== undefined && current.startMinute < previous.endMinute) {
        return `${WEEKDAY_LABELS[day] ?? "A day"}: two open periods overlap.`;
      }
    }
  }
  return null;
};

/** `HH:MM` (a native time input's value) to minutes since midnight, or null when unparseable. */
export const timeToMinutes = (value: string): number | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
};

/** Minutes since midnight to `HH:MM`, the value a native time input takes. */
export const minutesToTime = (minutes: number): string => {
  const clamped = Math.max(0, Math.min(DAY_MINUTES - 1, minutes));
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

/**
 * A friendly, unambiguous rendering of a booking's start, in the calendar's zone.
 *
 * The zone is spelled out because a time with no zone on a page a colleague in another one
 * might read is the ambiguity this whole feature is trying to remove.
 */
export const bookingWhen = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-NG", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
