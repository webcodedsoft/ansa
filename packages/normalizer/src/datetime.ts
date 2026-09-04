/**
 * Dates and times, in both directions.
 *
 * A date is the entity most likely to be *almost* right. A misheard policy number fails
 * loudly at the lookup; a callback booked for the wrong Tuesday fails a week later, and
 * the caller is the one who finds out. That is why the readback here says the weekday as
 * well as the date — "Thursday the fourteenth of August" — even though the caller only
 * gave one of them. If they said Tuesday and meant Tuesday, hearing "Thursday" is what
 * catches it, and nothing else in the pipeline can.
 *
 * Pure, like the rest of the package. The clock is a parameter, never a call to
 * `Date.now()`: a parser that reads the system clock cannot be tested and, on a server
 * in another timezone, is wrong by a day for part of every day.
 */

import { sayNumber, sayOrdinal } from "./numbers";

/**
 * West Africa Time. Nigeria is UTC+1 all year — no daylight saving, so a fixed offset is
 * correct rather than an approximation. Computing "tomorrow" in the server's timezone
 * instead is how a call at 00:30 Lagos time books a callback for the wrong day.
 */
const WAT_OFFSET_MS = 60 * 60 * 1000;

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const WEEKDAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

/** Ordinals as a caller says a day of the month. Cardinals too — "August fourteen". */
const DAY_WORDS: Readonly<Record<string, number>> = {
  first: 1, one: 1, second: 2, two: 2, third: 3, three: 3, fourth: 4, four: 4,
  fifth: 5, five: 5, sixth: 6, six: 6, seventh: 7, seven: 7, eighth: 8, eight: 8,
  ninth: 9, nine: 9, tenth: 10, ten: 10, eleventh: 11, eleven: 11,
  twelfth: 12, twelve: 12, thirteenth: 13, thirteen: 13, fourteenth: 14, fourteen: 14,
  fifteenth: 15, fifteen: 15, sixteenth: 16, sixteen: 16, seventeenth: 17, seventeen: 17,
  eighteenth: 18, eighteen: 18, nineteenth: 19, nineteen: 19, twentieth: 20, twenty: 20,
  thirtieth: 30, thirty: 30,
};

const TEN_PREFIX: Readonly<Record<string, number>> = { twenty: 20, thirty: 30 };

/** Civil date parts in Lagos for an instant. */
const watParts = (atMs: number): { y: number; m: number; d: number; weekday: number } => {
  const shifted = new Date(atMs + WAT_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
};

const pad = (n: number): string => String(n).padStart(2, "0");

const iso = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

/** A calendar day offset, done in UTC on a normalized noon so no DST or offset can shift it. */
const addDays = (atMs: number, days: number): string => {
  const { y, m, d } = watParts(atMs);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return iso(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
};

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

const daysIn = (y: number, m: number): number =>
  m === 2 && isLeap(y) ? 29 : (DAYS_IN_MONTH[m - 1] ?? 31);

export const isIsoDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
};

/**
 * The day of the month in a run of words, if there is one.
 *
 * Handles "twenty first" as two tokens, which is what a transcriber produces about half
 * the time — the other half arrives hyphenated and the tokenizer has already split it.
 */
const dayFrom = (tokens: readonly string[], from: number): number | null => {
  const first = tokens[from] ?? "";

  const numeric = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(first);
  if (numeric !== null) {
    const day = Number(numeric[1]);
    return day >= 1 && day <= 31 ? day : null;
  }

  const tens = TEN_PREFIX[first];
  if (tens !== undefined) {
    const unit = DAY_WORDS[tokens[from + 1] ?? ""];
    return unit !== undefined && unit <= 9 ? tens + unit : tens;
  }

  const word = DAY_WORDS[first];
  return word ?? null;
};

/**
 * The same, read backwards from `end` — "the twenty first **of** September".
 *
 * Needed because the tens prefix is two tokens to the left of the month and taking only
 * the nearest one turns the twenty-first into the first. That is a whole three weeks,
 * and it is exactly the kind of almost-right date nobody notices without a readback.
 */
const dayEndingAt = (tokens: readonly string[], end: number): number | null => {
  const found = dayFrom(tokens, end - 1);
  if (found === null) return null;
  const tens = TEN_PREFIX[tokens[end - 2] ?? ""];
  return tens !== undefined && found <= 9 ? tens + found : found;
};

/**
 * The year the caller meant when they did not say one.
 *
 * The next occurrence, not the current one: on the 20th of August, "the fourteenth of
 * August" means next year only if they are looking backwards, and in a service call they
 * are almost always looking forwards — a callback, a renewal, an appointment. Sixty days
 * of slack keeps "the fourteenth" meaning last week rather than next August when a
 * caller is describing something that already happened.
 */
const inferYear = (atMs: number, month: number, day: number): number => {
  const { y, m, d } = watParts(atMs);
  const thisYear = Date.UTC(y, month - 1, day);
  const today = Date.UTC(y, m - 1, d);
  const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;
  if (thisYear >= today - SIXTY_DAYS) return y;
  return y + 1;
};

const RELATIVE: readonly (readonly [RegExp, number])[] = [
  [/\bday after tomorrow\b/i, 2],
  [/\btomorrow\b/i, 1],
  [/\btoday\b/i, 0],
  [/\bthis evening\b|\btonight\b/i, 0],
  [/\byesterday\b/i, -1],
];

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9/\s-]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "");

/**
 * A date the caller spoke, as `YYYY-MM-DD`, or null.
 *
 * `atMs` is "now" as epoch milliseconds and is required, because half the forms people
 * use are relative to it.
 *
 * Day-first for the numeric form, which is how Nigeria writes dates. It is ambiguous
 * with the American order by nature, and the wrong guess produces a wrong date read back
 * — which is precisely what the readback exists to catch, and why this parser is allowed
 * to guess at all.
 */
export const parseSpokenDate = (text: string, atMs: number): string | null => {
  const lower = text.toLowerCase();

  const isoMatch = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(lower);
  if (isoMatch !== null && isIsoDate(isoMatch[0])) return isoMatch[0];

  const slashed = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(lower);
  if (slashed !== null) {
    const day = Number(slashed[1]);
    const month = Number(slashed[2]);
    const rawYear = slashed[3];
    const year =
      rawYear === undefined ? inferYear(atMs, month, day)
      : rawYear.length === 2 ? 2000 + Number(rawYear)
      : Number(rawYear);
    if (month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month)) {
      return iso(year, month, day);
    }
  }

  for (const [pattern, offset] of RELATIVE) {
    if (pattern.test(lower)) return addDays(atMs, offset);
  }

  const tokens = tokenize(lower);

  // A month name anchors everything else: "the fourteenth of August" and "August the
  // fourteenth" are the same date with the parts in either order.
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    const monthIndex = MONTHS.findIndex((m) => m === token || m.slice(0, 3) === token);
    if (monthIndex === -1) continue;
    const month = monthIndex + 1;

    // Look forward past "the", then backward past "of" and "the".
    const after =
      dayFrom(tokens, i + 1) ?? (tokens[i + 1] === "the" ? dayFrom(tokens, i + 2) : null);
    // Reading backwards, "of" is skipped: "the twenty first of September".
    const endsAt = tokens[i - 1] === "of" ? i - 1 : i;
    const before = endsAt >= 1 ? dayEndingAt(tokens, endsAt) : null;

    const day = after ?? before;
    if (day === null) continue;

    const yearToken = tokens
      .slice(i)
      .find((t) => /^(19|20)\d{2}$/.test(t));
    const year = yearToken === undefined ? inferYear(atMs, month, day) : Number(yearToken);
    if (day > daysIn(year, month)) continue;
    return iso(year, month, day);
  }

  // A bare weekday means the next one. "Next Monday" said on a Monday means the Monday
  // after this one, which is the reading every English speaker shares and the one a
  // naive "days until Monday" gets wrong by seven.
  for (let i = 0; i < tokens.length; i += 1) {
    const weekday = WEEKDAYS.indexOf(tokens[i] ?? "");
    if (weekday === -1) continue;
    const { weekday: current } = watParts(atMs);
    const ahead = (weekday - current + 7) % 7;
    const next = tokens[i - 1] === "next";
    return addDays(atMs, ahead === 0 ? 7 : next && ahead < 7 ? ahead + 7 : ahead);
  }

  return null;
};

/**
 * A bare day of the month — "the fourteenth", with no month attached.
 *
 * Only usable when something has just asked for a date. In free speech a bare ordinal is
 * a fragment and a date parser let loose on every turn would find one in "fourteen
 * Adeola Odeku Street"; in answer to "what day suits you?" it is unambiguous.
 *
 * Resolves to the next occurrence, which is what "the fourteenth" means when the
 * fourteenth of this month has gone.
 */
export const parseSpokenDayOfMonth = (text: string, atMs: number): string | null => {
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i += 1) {
    // Read backwards from just past this token so "twenty first" comes out whole.
    const day = dayEndingAt(tokens, i + 1);
    if (day === null) continue;

    const { y, m, d } = watParts(atMs);
    // This month if it has not passed, otherwise the next month that has such a day —
    // "the thirty first" in April means May, not an invalid date in April.
    for (let ahead = 0; ahead < 13; ahead += 1) {
      const month = ((m - 1 + ahead) % 12) + 1;
      const year = y + Math.floor((m - 1 + ahead) / 12);
      if (day > daysIn(year, month)) continue;
      if (ahead === 0 && day < d) continue;
      return iso(year, month, day);
    }
  }
  return null;
};

/**
 * A date read back with its weekday.
 *
 * The weekday is not decoration and it is not something the caller gave us. It is a
 * checksum they can verify for free: nobody knows what date next Tuesday is, and
 * everybody knows whether they meant Tuesday.
 */
export const sayDate = (value: string, atMs: number): string => {
  if (!isIsoDate(value)) return value;
  const [y = "0", m = "1", d = "1"] = value.split("-");
  const at = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const weekday = WEEKDAY_NAMES[at.getUTCDay()] ?? "";
  const month = MONTH_NAMES[Number(m) - 1] ?? "";
  const sameYear = watParts(atMs).y === Number(y);
  const year = sameYear ? "" : ` ${sayNumber(Number(y))}`;
  return `${weekday} the ${sayOrdinal(Number(d))} of ${month}${year}`;
};

/* ------------------------------------------------------------------- time */

export const isClockTime = (value: string): boolean => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
};

const MINUTE_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  quarter: 15, half: 30,
};

const MINUTE_TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };

/**
 * Minutes ending at `end` (exclusive), reading backwards.
 *
 * Backwards because the minutes come before "past" and "to" — "twenty five past two" —
 * and the two-word tens are the whole reason this needs its own function: taking only
 * the token nearest "past" turns twenty-five past into five past.
 */
const minutesEndingAt = (tokens: readonly string[], end: number): number | null => {
  const last = tokens[end - 1] ?? "";
  const unit = MINUTE_WORDS[last] ?? (/^\d{1,2}$/.test(last) ? Number(last) : undefined);
  if (unit === undefined || unit > 59) return null;

  const tens = MINUTE_TENS[tokens[end - 2] ?? ""];
  if (tens !== undefined && unit <= 9) return tens + unit;
  return unit;
};

const HOUR_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/**
 * Whether a bare hour means morning or afternoon.
 *
 * A caller who says "call me at two" means two in the afternoon; one who says "at nine"
 * means the morning. This guesses the way a person guesses, and the readback says which
 * one it picked in words — "two o'clock in the afternoon" — so a caller who meant 2am
 * hears the mistake immediately. Guessing silently would be indefensible; guessing out
 * loud is what a human agent does.
 */
const assumeMeridiem = (hour: number): number =>
  hour === 12 ? 12 : hour >= 7 && hour <= 11 ? hour : hour + 12;

const MORNING = /\b(a\.?m\.?|morning)\b/i;
const AFTERNOON = /\b(p\.?m\.?|afternoon|evening|tonight|night)\b/i;

const applyMeridiem = (hour: number, text: string): number => {
  if (MORNING.test(text)) return hour === 12 ? 0 : hour;
  if (AFTERNOON.test(text)) return hour === 12 ? 12 : hour + 12;
  return assumeMeridiem(hour);
};

/** A time of day the caller spoke, as 24-hour `HH:MM`, or null. */
export const parseSpokenTime = (text: string): string | null => {
  const lower = text.toLowerCase();

  if (/\b(noon|midday)\b/.test(lower)) return "12:00";
  if (/\bmidnight\b/.test(lower)) return "00:00";

  // 14:30, 2:05 pm
  const digital = /\b(\d{1,2})[:.](\d{2})\b/.exec(lower);
  if (digital !== null) {
    const rawHour = Number(digital[1]);
    const minutes = Number(digital[2]);
    if (rawHour <= 23 && minutes <= 59) {
      const hour = rawHour > 12 ? rawHour : applyMeridiem(rawHour, lower);
      return `${pad(hour % 24)}:${pad(minutes)}`;
    }
  }

  const tokens = tokenize(lower);

  // "half past two", "quarter to four", "twenty past nine"
  for (let i = 0; i < tokens.length; i += 1) {
    const direction = tokens[i];
    if (direction !== "past" && direction !== "to") continue;
    const minuteWord = minutesEndingAt(tokens, i);
    if (minuteWord === null || minuteWord === 0) continue;
    const afterToken = tokens[i + 1] ?? "";
    const hourWord =
      HOUR_WORDS[afterToken] ?? (/^\d{1,2}$/.test(afterToken) ? Number(afterToken) : undefined);
    if (hourWord === undefined || hourWord > 12) continue;

    const hour = applyMeridiem(hourWord, lower);
    if (direction === "past") return `${pad(hour % 24)}:${pad(minuteWord)}`;
    // "quarter to four" is 3:45 — the hour before, and midnight wraps to 23.
    return `${pad((hour + 23) % 24)}:${pad(60 - minuteWord)}`;
  }

  // "two o'clock", "two thirty", "fourteen thirty"
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    const numeric = /^\d{1,2}$/.test(token) ? Number(token) : undefined;
    const spoken = HOUR_WORDS[token];
    const rawHour = numeric ?? spoken;
    if (rawHour === undefined || rawHour > 23) continue;

    const next = tokens[i + 1] ?? "";
    if (next === "oclock" || next === "o" || next === "clock") {
      return `${pad(applyMeridiem(rawHour, lower) % 24)}:00`;
    }

    // "two thirty" and "two thirty five" both end the number, so read as far as the
    // minutes go rather than taking one token.
    const twoWord = minutesEndingAt(tokens, i + 3);
    const oneWord = /^\d{2}$/.test(next) ? Number(next) : MINUTE_WORDS[next];
    const minutes =
      twoWord !== null && MINUTE_TENS[next] !== undefined ? twoWord : oneWord;
    if (minutes === undefined || minutes > 59) continue;
    const hour = rawHour > 12 ? rawHour : applyMeridiem(rawHour, lower);
    return `${pad(hour % 24)}:${pad(minutes)}`;
  }

  /* "By two", "at two", "for two", "around two", "2pm": a bare hour after the word that
     puts it on the clock. "By" is the Nigerian one — "I'll call by two" is at two, not
     before it — and the others are how everybody says an appointment. A bare hour with no
     such word is left alone: "I have two" is a count, and treating it as a time is how a
     caller with two policies gets booked in for the afternoon. */
  for (let i = 0; i < tokens.length; i += 1) {
    const marker = tokens[i] ?? "";
    if (!ON_THE_CLOCK.has(marker)) continue;
    const next = tokens[i + 1] ?? "";
    const withMeridiem = /^(\d{1,2})(am|pm)$/.exec(next);
    const token = withMeridiem === null ? next : (withMeridiem[1] ?? "");
    const rawHour = /^\d{1,2}$/.test(token) ? Number(token) : HOUR_WORDS[token];
    if (rawHour === undefined || rawHour > 23) continue;
    /* "By two" is a time only if what follows could follow a time. "For four days", "by
       two people", "around nine of them" are a count, and the word after the number says
       so. The number has to end the thought, or be followed by something that goes after
       a clock time and nothing else. */
    const after = tokens[i + 2];
    if (after !== undefined && !AFTER_AN_HOUR.has(after)) continue;
    const meridiemText = withMeridiem === null ? lower : `${lower} ${withMeridiem[2] ?? ""}`;
    const hour = rawHour > 12 ? rawHour : applyMeridiem(rawHour, meridiemText);
    return `${pad(hour % 24)}:00`;
  }
  // "2pm" on its own carries its own clock word.
  const bareMeridiem = /\b(\d{1,2})\s?(am|pm)\b/.exec(lower);
  if (bareMeridiem !== null) {
    const rawHour = Number(bareMeridiem[1]);
    if (rawHour >= 1 && rawHour <= 12) {
      return `${pad(applyMeridiem(rawHour, `${lower} ${bareMeridiem[2] ?? ""}`) % 24)}:00`;
    }
  }

  return null;
};

/** The words that put the number after them on the clock. */
const ON_THE_CLOCK: ReadonlySet<string> = new Set(["by", "at", "for", "around", "about", "before", "after", "till", "until"]);

/** What may follow a bare hour and leave it an hour. Anything else makes it a count. */
const AFTER_AN_HOUR: ReadonlySet<string> = new Set([
  "am", "pm", "oclock", "o", "sharp", "in", "on", "this", "tomorrow", "today", "tonight",
  "then", "please", "thanks", "ok", "okay", "and", "or", "if", "but", "so",
]);

const partOfDay = (hour: number): string =>
  hour < 12 ? "in the morning" : hour < 17 ? "in the afternoon" : "in the evening";

/**
 * A time read back the way it is said, not the way it is stored.
 *
 * "Fourteen thirty" is a train announcement. "Half past two in the afternoon" is a
 * person, and the part of day is the bit that catches an am/pm mistake the parser had to
 * guess at.
 */
export const sayTime = (value: string): string => {
  if (!isClockTime(value)) return value;
  const [h = "0", m = "0"] = value.split(":");
  const hour24 = Number(h);
  const minutes = Number(m);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  const clock =
    minutes === 0 ? `${sayNumber(hour12)} o'clock`
    : minutes === 15 ? `quarter past ${sayNumber(hour12)}`
    : minutes === 30 ? `half past ${sayNumber(hour12)}`
    : minutes === 45 ? `quarter to ${sayNumber(hour12 === 12 ? 1 : hour12 + 1)}`
    // "oh five", not "five" — a bare "two five" is heard as twenty-five.
    : minutes < 10 ? `${sayNumber(hour12)} oh ${sayNumber(minutes)}`
    : `${sayNumber(hour12)} ${sayNumber(minutes)}`;

  if (hour24 === 12 && minutes === 0) return "midday";
  if (hour24 === 0 && minutes === 0) return "midnight";
  return `${clock} ${partOfDay(hour24)}`;
};
