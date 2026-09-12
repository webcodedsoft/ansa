import type { Organisation } from "./org.service";

type Hours = NonNullable<Organisation["businessHours"]>;

/** Lagos never changes its clocks: WAT is UTC+1 all year, and Ansa's hours are in WAT. */
const WAT_OFFSET_HOURS = 1;

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** `08:00`, or "not narrowed" for a bound the organisation has left to the platform. */
export const hourLabel = (hour: number | null): string =>
  hour === null ? "not narrowed" : `${String(hour).padStart(2, "0")}:00`;

/**
 * The open days as a person says them: "Mon–Sat", "Mon–Fri", "Mon, Wed, Fri".
 *
 * A run of consecutive days collapses to a range; anything else is listed. Seven days is
 * "every day", and none is "no days", which the hours form does not allow but the label
 * should still not lie about.
 */
export const daysLabel = (openDays: readonly number[]): string => {
  const days = [...new Set(openDays)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (days.length === 0) return "no days";
  if (days.length === 7) return "every day";
  const consecutive = days.every((d, i) => i === 0 || d === (days[i - 1] ?? 0) + 1);
  const name = (d: number): string => DAY_NAMES[d - 1] ?? "";
  if (consecutive && days.length > 2) return `${name(days[0] ?? 1)}–${name(days[days.length - 1] ?? 7)}`;
  return days.map(name).join(", ");
};

/**
 * Whether the organisation counts as open at this instant, in its own zone.
 *
 * Null hours is "always open", which is what the API means by it. `closesAtHour` is
 * exclusive, so a line that shuts at five holds 17 and is closed at 17:00 exactly — the same
 * reading the call path makes, so the badge and the agent agree.
 */
export const openNow = (hours: Hours | null, now = new Date()): boolean => {
  if (hours === null) return true;
  const wat = new Date(now.getTime() + WAT_OFFSET_HOURS * 3_600_000);
  const isoDay = ((wat.getUTCDay() + 6) % 7) + 1;
  const hour = wat.getUTCHours();
  return hours.openDays.includes(isoDay) && hour >= hours.opensAtHour && hour < hours.closesAtHour;
};

/** The current time in WAT as `HH:MM`, for a badge that says when "now" was. */
export const nowInWat = (now = new Date()): string => {
  const wat = new Date(now.getTime() + WAT_OFFSET_HOURS * 3_600_000);
  return `${String(wat.getUTCHours()).padStart(2, "0")}:${String(wat.getUTCMinutes()).padStart(2, "0")}`;
};
