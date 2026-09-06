import type { CapturedField } from "@/features/agents/agents.schema";
import type { TemplateBranch } from "@/features/agents/templates.shape";
import { field } from "@/features/agents/templates.shape";

import type { CampaignWindow } from "./campaigns.service";

/**
 * A campaign somebody actually runs, ready to be pointed at a list.
 *
 * Not a form with defaults. Each of these is a specific thing a specific kind of
 * organisation rings people about — a school chasing fees before term, a clinic reminding
 * patients the day before — written with the reason the agent opens with, the exact verdicts
 * that campaign records, the conversation it has to have when the person says something back,
 * and the retry policy that suits the subject. A fee reminder can try three times over a
 * week; a same-day appointment reminder that has not connected by tonight is pointless
 * tomorrow.
 *
 * The purpose is what the agent says in its first breath, so it is written as the tail of
 * "I'm calling…". Anything in braces is filled per person from what is already known:
 * `{name}` always, and whatever the list carried as facts — `{amount}`, `{when}`,
 * `{property}`. A placeholder nobody has a value for is read out with its braces on, which is
 * why each template names the facts it expects and the create page shows them.
 *
 * The conversation reuses the agent-template machinery — the same `field` and `branch`
 * shapes, turned into a graph by `flowFromTemplate` — because a campaign's flow and an
 * agent's flow are the same kind of drawing and the canvas does not know the difference.
 */
export interface CampaignTemplate {
  readonly id: string;
  readonly name: string;
  /** The kind of organisation this is for. Matches the agent gallery's vocabulary. */
  readonly sector: string;
  /** One line for the card: what the campaign is for, not how it works. */
  readonly summary: string;
  /**
   * Why it rings, as the tail of "I'm calling…". The load-bearing field: without it the agent
   * composes a reason, and an invented reason for an unexpected call is what a scam sounds
   * like to whoever answers.
   */
  readonly purpose: string;
  /** The exact first line, or null to let the agent compose one from the purpose. */
  readonly opening: string | null;
  /** The verdicts the agent picks from at the end. What the breakdown on the page counts. */
  readonly outcomes: readonly string[];
  /**
   * The facts each contact should carry for the placeholders to fill. Shown on the create
   * page so somebody sees "this needs {amount} on every row" before they import a list
   * without it.
   */
  readonly facts: readonly { readonly key: string; readonly example: string }[];
  /** What to do when a machine answers. Silence is the safer default for anything private. */
  readonly voicemail: "hang_up" | "leave_message";
  readonly maxAttempts: number;
  readonly retryAfterMinutes: number;
  /** Null takes the default 08:00–20:00 bound; a window narrows it for the subject. */
  readonly callingWindow: CampaignWindow | null;
  /**
   * What the call has to collect when the person says something back, or null when the
   * campaign only confirms. Same shape as an agent template's, and drawn the same way.
   */
  readonly conversation: {
    readonly fields: readonly CapturedField[];
    readonly branch?: TemplateBranch;
    readonly closing?: string;
  } | null;
  /**
   * Why this template is shaped the way it is: the retry choice, the voicemail choice, the
   * one thing people get wrong. Shown on the card's detail so the template teaches rather
   * than merely fills.
   */
  readonly rationale: string;
}

export const WEEKDAYS = [1, 2, 3, 4, 5];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** Office hours, for subjects that want a person at their desk on the other end. */
export const OFFICE_HOURS: CampaignWindow = { startHour: 9, endHour: 17, weekdays: WEEKDAYS };

/** Mid-morning to early evening, for reaching people at home without ringing at breakfast. */
export const HOME_HOURS: CampaignWindow = { startHour: 10, endHour: 19, weekdays: EVERY_DAY };

/** Confirm, move, or cancel — the shape every reminder shares, parameterised by the thing booked. */
export const confirmOrMove = (whatIsBooked: string): CampaignTemplate["conversation"] => ({
  fields: [
    field("attending", "choice", `Are you still able to make the ${whatIsBooked}?`, {
      options: ["yes", "need to change it", "cancel"],
      required: true,
    }),
  ],
  branch: {
    on: "attending",
    arms: {
      yes: { fields: [], closing: "Thank them, confirm the time once more, and say goodbye." },
      "need to change it": {
        fields: [
          field("preferredDay", "text", "What day would suit you better?", { required: true }),
          field("preferredTime", "text", "And roughly what time of day?", { required: false }),
        ],
        closing:
          "Say that somebody will call back to confirm the new time, and that nothing changes until they do.",
      },
      cancel: {
        fields: [field("reason", "text", "May I ask why, so we can note it?", { required: false })],
        closing:
          "Say that it has been noted, that there is nothing else they need to do, and say goodbye.",
      },
    },
  },
});

