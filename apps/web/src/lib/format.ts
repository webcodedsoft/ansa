/**
 * Rendering helpers shared by the call screens.
 *
 * All of these take the API's own representation — ISO 8601 timestamps, millisecond offsets
 * from the start of a call, whole seconds — and none of them parse or re-derive anything.
 * If a value looks wrong on screen it is wrong in the API, which is the only way to keep
 * this app usable as a debugging surface.
 */

/**
 * One locale, pinned, everywhere.
 *
 * `undefined` here means "whatever machine is rendering", and two machines
 * render every page: the Node server and the browser. When their locales
 * differ, the same timestamp comes out as "15 Aug 2026, 07:39" on one and
 * "Aug 15, 2026, 7:39 AM" on the other, and React reports the difference as a
 * hydration failure and re-renders the tree. Nigerian English is not a
 * neutral default picked to dodge that — it is the product's home locale.
 */
const LOCALE = "en-NG";

/** An absolute time. */
export const when = (iso: string): string =>
  new Date(iso).toLocaleString(LOCALE, { dateStyle: "medium", timeStyle: "short" });

/**
 * A call's length with its units: `1m 44s`, `38s`, `1h 02m`. Null when the call never ended,
 * which is not zero.
 *
 * This was clock notation — `1:44` — on the argument that a column compares at a glance when
 * every cell has the same shape. The argument lost to a plainer one: `1:44` beside a time of
 * day like `00:10` reads as another clock, and a person had to work out which was which. The
 * units say what the figure is. Seconds drop out above an hour, where they stop mattering.
 */
export const duration = (seconds: number | null): string => {
  if (seconds === null) return "—";
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${rest}s`;
};

/**
 * A Nigerian E.164 number grouped the way it is said: `+234 802 118 4429`.
 *
 * Only `+234` plus ten digits is regrouped. Every other country writes its
 * numbers differently, and applying a Nigerian shape to a British or American
 * one produces `+442 071 2345 67` — worse than leaving it alone. Grouping is
 * display only; the stored value and everything a tool receives stay unspaced.
 */
export const phone = (value: string): string => {
  const match = /^\+234([0-9]{3})([0-9]{3})([0-9]{4})$/.exec(value);
  return match === null ? value : `+234 ${match[1]} ${match[2]} ${match[3]}`;
};


/**
 * A position within a call, as `m:ss.t`.
 *
 * Tenths are kept because this is the column you read when working out whether the agent
 * talked over somebody, and that argument is decided in hundreds of milliseconds. Rounding
 * to the second would erase the thing being measured.
 */
export const offset = (ms: number | null): string => {
  if (ms === null) return "—";
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const tenths = Math.floor((total % 1000) / 100);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths}`;
};

/** Snake or kebab case from the API as something readable, without inventing wording. */
/**
 * What a call's direction is called on screen.
 *
 * The stored values stay `inbound` and `outbound` — they are the carrier's vocabulary, the
 * column's check constraint and what every comparison in this app tests against. This is the
 * label only. "Incoming Call" and "Outgoing Call" are what somebody running a phone line says,
 * and the mapping lives here so the four places that show it cannot drift into three spellings.
 */
export const directionLabel = (direction: string): string => {
  if (direction === "inbound") return "Incoming Call";
  if (direction === "outbound") return "Outgoing Call";
  return direction;
};

export const humanise = (value: string | null): string =>
  value === null || value === "" ? "—" : value.replace(/[_-]+/g, " ");

/**
 * Which day a timestamp belongs to, as a heading: Today, Yesterday, or the date.
 *
 * Calendar days, not 24-hour windows — a call at 23:50 last night is
 * "Yesterday" even if it was ten minutes ago, because that is how people
 * answer "when did they ring?".
 */
export const dayLabel = (iso: string): string => {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(LOCALE, { day: "numeric", month: "long" });
};

/**
 * A time of day alone, for rows already grouped under a day heading.
 *
 * Always 24-hour: "20:42" stays on one line in a narrow column where
 * "08:42 PM" wraps, and a call log reads like a log.
 */
export const timeOfDay = (iso: string): string =>
  new Date(iso).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hour12: false });
