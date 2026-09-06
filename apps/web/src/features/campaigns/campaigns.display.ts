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

/**
 * Roughly when a running campaign will be done, as a sentence or nothing.
 *
 * The estimate is the pending count spread across the calling window at the retry interval,
 * which is honest about what bounds it: not the dialler's speed, but how many hours a day it
 * is allowed to ring and how long it waits between tries. It is deliberately rough — "around
 * Thursday afternoon" is what somebody wants, and a minute-precise figure would claim a
 * certainty the estimate does not have.
 *
 * Null when there is nothing to project: no pending calls, or no window to project across.
 * An `endsAt` earlier than the projection wins, because the campaign stops there whatever is
 * left, and the sentence says so.
 */
export const projectedFinish = (campaign: {
  readonly pending: number;
  readonly retryAfterMinutes: number;
  readonly callingWindow: CampaignWindow | null;
  readonly endsAt: string | null;
}): string | null => {
  if (campaign.pending === 0) return null;

  const window = campaign.callingWindow ?? { startHour: 8, endHour: 20, weekdays: [0, 1, 2, 3, 4, 5, 6] };
  const hoursPerDay = Math.max(0, window.endHour - window.startHour);
  const daysPerWeek = new Set(window.weekdays).size;
  if (hoursPerDay === 0 || daysPerWeek === 0) return null;

  /* One attempt per row per retry interval is the pessimistic reading — the dialler works
     through pending rows far faster than that, but a row that rings out waits the full
     interval before its next go, and a campaign's tail is made of exactly those rows. */
  const hoursNeeded = (campaign.pending * campaign.retryAfterMinutes) / 60;
  const workingDays = hoursNeeded / hoursPerDay;
  const calendarDays = workingDays * (7 / daysPerWeek);

  const projected = new Date(Date.now() + calendarDays * 86_400_000);
  const cutoff = campaign.endsAt === null ? null : new Date(campaign.endsAt);

  const say = (at: Date): string =>
    at.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });

  if (cutoff !== null && cutoff.getTime() < projected.getTime()) {
    return `Stops ${say(cutoff)}, with some of the list likely unreached.`;
  }
  if (calendarDays < 1) return "Should finish today.";
  return `Should finish around ${say(projected)}.`;
};
