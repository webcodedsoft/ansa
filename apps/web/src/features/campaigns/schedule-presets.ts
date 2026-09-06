import type { CampaignWindow } from "./campaigns.service";

/**
 * When a run starts and stops, as the choices somebody actually means.
 *
 * Pure, and kept apart from the card that draws it because this is date arithmetic, which
 * is where the bugs live: a Sunday on which "tomorrow" and "next Monday" are the same
 * morning, a Friday evening on which "end of the week" has already gone, a campaign whose
 * window opens at nine rather than eight. Each is a test here rather than a surprise on the
 * page.
 */

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * A local wall-clock reading of an instant, in the shape the inputs want.
 *
 * `toISOString` would be the wrong half of the problem: it renders UTC, so an 09:00 start in
 * Lagos comes back as 08:00 and the operator is shown a time they did not set. These read the
 * browser's own zone, which is the zone the person picking the time is standing in.
 */
export const parts = (iso: string | null): { readonly date: string; readonly time: string } => {
  if (iso === null) return { date: "", time: "" };
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { date: "", time: "" };
  return {
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  };
};

export type Parts = { readonly date: string; readonly time: string };

/** A local date at a whole hour, as the inputs want it. */
const at = (day: Date, hour: number): Parts => {
  const copy = new Date(day);
  copy.setHours(hour, 0, 0, 0);
  return parts(copy.toISOString());
};

const daysFrom = (now: Date, days: number): Date => {
  const copy = new Date(now);
  copy.setDate(copy.getDate() + days);
  return copy;
};

/** The next Monday strictly after today. */
export const nextMonday = (now: Date): Date => daysFrom(now, ((8 - now.getDay()) % 7) || 7);

/** This week's Friday, or next week's if Friday has gone. */
export const thisFriday = (now: Date): Date => {
  const ahead = (5 - now.getDay() + 7) % 7;
  return daysFrom(now, ahead === 0 && now.getHours() >= 20 ? 7 : ahead);
};

export interface Preset {
  readonly key: string;
  readonly label: string;
  readonly resolve: (now: Date, window: CampaignWindow | null) => Parts;
}

/*
 * The starts and stops somebody actually means, resolved against the campaign's own hours
 * so "tomorrow" is tomorrow at the first hour it may ring and "end of today" is the last.
 * A campaign with no window uses the 08:00–20:00 bound every call is held to anyway.
 */
const opens = (window: CampaignWindow | null): number => window?.startHour ?? 8;
const closes = (window: CampaignWindow | null): number => window?.endHour ?? 20;

export const STARTS: readonly Preset[] = [
  { key: "tomorrow", label: "Tomorrow", resolve: (now, w) => at(daysFrom(now, 1), opens(w)) },
  { key: "monday", label: "Next Monday", resolve: (now, w) => at(nextMonday(now), opens(w)) },
  { key: "week", label: "In a week", resolve: (now, w) => at(daysFrom(now, 7), opens(w)) },
];

export const STOPS: readonly Preset[] = [
  { key: "today", label: "End of today", resolve: (now, w) => at(now, closes(w)) },
  { key: "tomorrow", label: "End of tomorrow", resolve: (now, w) => at(daysFrom(now, 1), closes(w)) },
  { key: "friday", label: "End of the week", resolve: (now, w) => at(thisFriday(now), closes(w)) },
  { key: "week", label: "In a week", resolve: (now, w) => at(daysFrom(now, 7), closes(w)) },
];

export const CUSTOM = "custom";

/** Which preset produces exactly these parts, if any; otherwise the custom key. */
export const presetFor = (
  value: Parts,
  presets: readonly Preset[],
  now: Date,
  window: CampaignWindow | null,
): string | null => {
  if (value.date === "" && value.time === "") return null;
  const hit = presets.find((preset) => {
    const resolved = preset.resolve(now, window);
    return resolved.date === value.date && resolved.time === value.time;
  });
  return hit?.key ?? CUSTOM;
};

export const readable = (value: Parts): string => {
  const when = new Date(`${value.date}T${value.time}`);
  return Number.isNaN(when.getTime())
    ? ""
    : when.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};


/**
 * One chip per moment. A preset that resolves to the same time as an earlier one is dropped,
 * because two chips for one time means clicking the second lights the first.
 */
export const offeredPresets = (
  presets: readonly Preset[],
  now: Date,
  window: CampaignWindow | null,
): readonly Preset[] =>
  presets.filter((preset, index) => {
    const mine = preset.resolve(now, window);
    return !presets.slice(0, index).some((earlier) => {
      const theirs = earlier.resolve(now, window);
      return theirs.date === mine.date && theirs.time === mine.time;
    });
  });
