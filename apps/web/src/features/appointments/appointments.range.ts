/**
 * What a calendar view covers: the range to fetch, the days to draw, and what to call it.
 *
 * `appointments.time.ts` owns the primitives — reading an instant's wall clock in a zone,
 * turning a wall time back into an instant, walking days and Mondays. This owns the layer
 * above: given a view (`day`, `week`, `month`) and an anchor date, it says which instants
 * bound the query, which day cells the grid draws, and which heading sits over them.
 *
 * Pure and zone-explicit, for the same reason the module below it is. Every step — a month
 * forward, a week back, "today" — is arithmetic on a plain date in the *calendar's* zone, and
 * the only place a real instant appears is `from`/`to`, which go through `zonedTimeToUtc` so a
 * DST week is 167 or 169 hours rather than a hopeful 168. The browser's zone never enters into
 * it, and neither does the server's.
 *
 * Month names are spelled out here rather than taken from `Intl`, because a heading that
 * changes wording when ICU is updated is a heading that cannot be asserted on.
 */

import {
  DAYS_IN_WEEK,
  WEEKDAY_SHORT,
  addDays,
  isoDate,
  mondayOf,
  todayIn,
  weekdayOf,
  zonedTimeToUtc,
  type PlainDate,
} from "./appointments.time";

/** The four ways the calendar can be read. Anything else in the URL falls back to `week`. */
export type CalendarView = "day" | "week" | "month" | "schedule";

export const CALENDAR_VIEWS: readonly CalendarView[] = ["day", "week", "month", "schedule"];

export const DEFAULT_VIEW: CalendarView = "week";

export const VIEW_LABELS: Readonly<Record<CalendarView, string>> = {
  day: "Day",
  week: "Week",
  month: "Month",
  schedule: "Schedule",
};

/** The single-key shortcuts, the same letters Google uses, so muscle memory carries over. */
export const VIEW_KEYS: Readonly<Record<string, CalendarView>> = {
  d: "day",
  w: "week",
  m: "month",
  a: "schedule",
};

/** Read `?view=`. Unknown and missing both mean the week, which is the working default. */
export const parseView = (raw: string | undefined): CalendarView =>
  raw === "day" || raw === "week" || raw === "month" || raw === "schedule" ? raw : DEFAULT_VIEW;

/**
 * How far the schedule looks ahead.
 *
 * Four weeks and change: far enough that "what is coming up" is genuinely answered, short
 * enough that it is one query and one scroll rather than a year of empty days.
 */
export const SCHEDULE_DAYS = 30;

/** Read `?weekends=`. Absent means shown, because hiding days is the unusual choice. */
export const parseWeekends = (raw: string | undefined): boolean => raw !== "0";

const isWeekend = (weekday: number): boolean => weekday === 0 || weekday === 6;

/**
 * The month grid is always six rows.
 *
 * A month spans four to six weeks depending on where its first day falls, and letting the grid
 * shrink means the page jumps in height every time you page through the year. Six rows always,
 * padded from the months either side, is what every calendar worth copying does.
 */
export const MONTH_GRID_WEEKS = 6;

const MONTH_NAMES: readonly string[] = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Days in a month, Gregorian leap rule included. February 2028 has 29. */
export const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Add whole months, clamping the day to the target month's length.
 *
 * 31 January plus one month is 28 February, not 3 March. `Date.setUTCMonth` overflows into the
 * next month instead, which is how a "next month" button silently skips February — press it
 * twice from 31 January and you land in March having never seen February at all.
 */
export const addMonths = (date: PlainDate, delta: number): PlainDate => {
  const zeroBased = date.month - 1 + delta;
  const year = date.year + Math.floor(zeroBased / 12);
  const month = (((zeroBased % 12) + 12) % 12) + 1;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
};

/** The first of the month an anchor falls in. */
export const startOfMonth = (date: PlainDate): PlainDate => ({ ...date, day: 1 });

/**
 * The anchor `delta` steps away, in the units the current view moves in.
 *
 * A day at a time, a week at a time, a month at a time — the same button means three different
 * amounts, which is the whole reason this takes the view. Week steps run from the anchor's
 * Monday so that repeated presses stay on Mondays rather than drifting by the anchor's own
 * weekday; month steps keep the day of the month so switching back to the day view lands where
 * you were, clamped when the target month is shorter.
 */
export const stepAnchor = (view: CalendarView, anchor: PlainDate, delta: number): PlainDate => {
  if (view === "day") return addDays(anchor, delta);
  if (view === "schedule") return addDays(anchor, delta * SCHEDULE_DAYS);
  if (view === "week") return addDays(mondayOf(anchor), delta * DAYS_IN_WEEK);
  return addMonths(anchor, delta);
};

/** One day cell of a view: the date, how to key it, and whether it is inside the period drawn. */
export interface RangeDay {
  readonly date: PlainDate;
  readonly iso: string;
  readonly weekday: number; // 0 Sun … 6 Sat
  readonly shortLabel: string;
  readonly dayNumber: number;
  /**
   * False for the leading and trailing days a month grid borrows from the months either side.
   * Always true for the day and week views, which have no outside.
   */
  readonly inPeriod: boolean;
  readonly isToday: boolean;
}

export interface CalendarRange {
  readonly view: CalendarView;
  readonly anchor: PlainDate;
  /** The instant the view's first day begins, in the calendar's zone. Inclusive. */
  readonly from: string;
  /** The instant after the view's last day ends. Exclusive. */
  readonly to: string;
  readonly days: readonly RangeDay[];
  /** The same days in rows of seven — one row for a day, one for a week, six for a month. */
  readonly weeks: readonly (readonly RangeDay[])[];
  /** "March 2026" · "2–8 March 2026" · "Tuesday 3 March". */
  readonly title: string;
}

/** "Tuesday 3 March 2026". */
const dayTitle = (date: PlainDate): string => {
  const month = MONTH_NAMES[date.month - 1] ?? "";
  return `${date.day} ${month} ${date.year}`;
};

/**
 * "2–8 March 2026", widening only as far as it has to.
 *
 * A week inside one month names the month once; a week that straddles two names both; a week
 * that straddles New Year names both years. The year is never dropped, because a heading that
 * says "2–8 March" is exactly as useless as a time with no timezone.
 */
const weekTitle = (first: PlainDate, last: PlainDate): string => {
  const firstMonth = MONTH_NAMES[first.month - 1] ?? "";
  const lastMonth = MONTH_NAMES[last.month - 1] ?? "";
  if (first.year !== last.year) {
    return `${first.day} ${firstMonth} ${first.year} – ${last.day} ${lastMonth} ${last.year}`;
  }
  if (first.month !== last.month) {
    return `${first.day} ${firstMonth} – ${last.day} ${lastMonth} ${last.year}`;
  }
  return `${first.day}–${last.day} ${firstMonth} ${first.year}`;
};

/** The heading over a view, for a header that does not want the whole range object. */
export const rangeTitle = (view: CalendarView, anchor: PlainDate): string => {
  if (view === "day") return dayTitle(anchor);
  if (view === "month") return `${MONTH_NAMES[anchor.month - 1] ?? ""} ${anchor.year}`;
  if (view === "schedule") return weekTitle(anchor, addDays(anchor, SCHEDULE_DAYS - 1));
  const monday = mondayOf(anchor);
  return weekTitle(monday, addDays(monday, DAYS_IN_WEEK - 1));
};

/** The plain dates a view draws, in order, before they are dressed as `RangeDay`s. */
const datesFor = (view: CalendarView, anchor: PlainDate): readonly PlainDate[] => {
  if (view === "day") return [anchor];
  /* The schedule runs from the anchor forward, not from its Monday: "what is coming up"
     starts today, and rewinding to Monday would open it on days already gone. */
  if (view === "schedule") {
    return Array.from({ length: SCHEDULE_DAYS }, (_unused, index) => addDays(anchor, index));
  }
  if (view === "week") {
    const monday = mondayOf(anchor);
    return Array.from({ length: DAYS_IN_WEEK }, (_unused, index) => addDays(monday, index));
  }
  /* The month grid starts on the Monday on or before the 1st and runs a fixed six weeks, so
     the first row always holds the 1st and the height never changes between months. */
  const gridStart = mondayOf(startOfMonth(anchor));
  return Array.from({ length: MONTH_GRID_WEEKS * DAYS_IN_WEEK }, (_unused, index) =>
    addDays(gridStart, index),
  );
};

const chunkBy = (days: readonly RangeDay[], width: number): readonly (readonly RangeDay[])[] => {
  const rows: RangeDay[][] = [];
  for (let index = 0; index < days.length; index += width) {
    rows.push(days.slice(index, index + width));
  }
  return rows;
};

/**
 * Everything one view needs: what to fetch, what to draw, what to call it.
 *
 * `today` is a parameter rather than a read of the clock so the whole thing stays a function of
 * its arguments and can be asserted on. It defaults to today in the calendar's zone, which is
 * what every caller but a test wants.
 */
export const calendarRange = (
  view: CalendarView,
  anchor: PlainDate,
  timeZone: string,
  {
    today = todayIn(timeZone),
    showWeekends = true,
  }: { readonly today?: PlainDate; readonly showWeekends?: boolean } = {},
): CalendarRange => {
  const dates = datesFor(view, anchor);
  const first = dates[0] ?? anchor;
  const last = dates[dates.length - 1] ?? anchor;
  const todayIso = isoDate(today);

  const all: readonly RangeDay[] = dates.map((date) => {
    const weekday = weekdayOf(date);
    const iso = isoDate(date);
    return {
      date,
      iso,
      weekday,
      shortLabel: WEEKDAY_SHORT[weekday] ?? "",
      dayNumber: date.day,
      inPeriod: view === "month" ? date.month === anchor.month && date.year === anchor.year : true,
      isToday: iso === todayIso,
    };
  });

  /* Hiding weekends drops the *columns*, never the query: `from`/`to` still bound the whole
     span. A Saturday booking that is not drawn is still a booking, and narrowing the fetch to
     match the view would mean the same URL returned different data depending on a display
     preference. Day and schedule views are unaffected — asking for a Saturday and being shown
     nothing would be absurd, and an agenda lists what is there. */
  const hide = !showWeekends && (view === "week" || view === "month");
  const days = hide ? all.filter((day) => !isWeekend(day.weekday)) : all;
  const width = hide ? DAYS_IN_WEEK - 2 : DAYS_IN_WEEK;

  const from = zonedTimeToUtc(first, 0, timeZone).toISOString();
  const to = zonedTimeToUtc(addDays(last, 1), 0, timeZone).toISOString();

  return {
    view,
    anchor,
    from,
    to,
    days,
    weeks: chunkBy(days, width),
    title: rangeTitle(view, anchor),
  };
};

/**
 * What an appointment is called in a block or a month cell.
 *
 * The title first, because that is the whole reason the column exists — a person writing in
 * the diary names the thing. A booking taken on a call has no title, and its note is the
 * nearest thing to one; the status is the honest last resort rather than an invented name.
 *
 * The contact's name would sit between the two, and does not, because a booking row carries a
 * `contactId` and not a name — resolving it means a lookup per appointment, which is not worth
 * a round trip to relabel a block. The dialog, which fetches one booking's worth, shows it.
 */
export const bookingLabel = (booking: {
  readonly status: "held" | "booked";
  readonly title: string | null;
  readonly notes: string | null;
}): string => {
  const title = booking.title?.trim() ?? "";
  if (title.length > 0) return title;
  const note = booking.notes?.trim() ?? "";
  if (note.length > 0) return note;
  return booking.status === "held" ? "Held" : "Booked";
};
