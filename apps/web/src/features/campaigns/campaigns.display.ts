import type { Tone } from "@/components/ui";

import type { CampaignStatus, CampaignWindow, ScheduledCallStatus } from "./campaigns.service";

/**
 * How a campaign's state reads, in one colour.
 *
 * Running takes the accent because it is the one state where the phone is actually dialling;
 * everything else is a resting state and wears the hairline. Paused is a warning rather than
 * neutral so a campaign somebody stopped on purpose is not mistaken for one that never began.
 */
export const campaignTone: Record<CampaignStatus, Tone> = {
  draft: "neutral",
  scheduled: "neutral",
  running: "accent",
  paused: "warn",
  done: "neutral",
};

/** How each scheduled-call outcome reads, in one colour. */
export const callTone: Record<ScheduledCallStatus, Tone> = {
  pending: "neutral",
  placing: "accent",
  answered: "ok",
  no_answer: "neutral",
  busy: "warn",
  voicemail: "warn",
  failed: "bad",
  suppressed: "bad",
};

/** Snake case from the API as words, without inventing meaning. */
export const callStatusLabel: Record<ScheduledCallStatus, string> = {
  pending: "Pending",
  placing: "Placing",
  answered: "Answered",
  no_answer: "No answer",
  busy: "Busy",
  voicemail: "Voicemail",
  failed: "Failed",
  suppressed: "Suppressed",
};

/** Day abbreviations by the API's own 0–6, Sunday first as JavaScript counts them. */
const DAY_ABBR: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const hour = (h: number): string => `${String(h).padStart(2, "0")}:00`;

/**
 * A calling window as one line, or the default when there is none.
 *
 * `null` is not "no calls" — it is the API's own 08:00–20:00 WAT bound, which every campaign
 * falls back to. Said plainly here so an operator who set no window is not left wondering when
 * the phone will ring. Named days lead with Monday, the way a working week is read.
 */
export const windowSummary = (window: CampaignWindow | null): string => {
  if (window === null) return "Default hours — 08:00–20:00 WAT, any day";

  const days = [...window.weekdays].sort((a, b) => a - b);
  const isWeekdays = days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));
  const mondayFirst = (d: number): number => (d + 6) % 7;
  const label =
    days.length === 7
      ? "every day"
      : isWeekdays
        ? "weekdays"
        : [...days].sort((a, b) => mondayFirst(a) - mondayFirst(b)).map((d) => DAY_ABBR[d]).join(", ");

  return `${hour(window.startHour)}–${hour(window.endHour)} WAT, ${label}`;
};
