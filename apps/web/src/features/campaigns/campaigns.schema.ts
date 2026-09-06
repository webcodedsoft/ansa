import { CAMPAIGN_LIMITS, VOICEMAIL_MODES } from "@ansa/shared/campaign";
import { z } from "zod";

/**
 * What this app is allowed to submit for a campaign.
 *
 * As with every schema here, this is not a second copy of the API's rules. The API clamps
 * the calling window to the 08:00–20:00 WAT bound the consent gate enforces and refuses an
 * agent this organisation does not own; this only catches the shapes that are obviously wrong
 * before a round trip and gives the API's refusal a field to land on when it says no anyway.
 */

export const statusSchema = z.enum(["draft", "scheduled", "running", "paused", "done"]);
export type Status = z.infer<typeof statusSchema>;

/**
 * The calling window: which hours, which days.
 *
 * `endHour` is exclusive and runs to 24, so "up to and including 8pm" is `endHour: 20`. The
 * end must come after the start — a window that closes before it opens rings nobody — and at
 * least one weekday must be chosen, since a window with no days is the same mistake spelled
 * differently.
 */
export const callingWindowSchema = z
  .object({
    startHour: z.coerce.number().int().min(0, "The start hour is 0–23.").max(23, "The start hour is 0–23."),
    endHour: z.coerce.number().int().min(1, "The end hour is 1–24.").max(24, "The end hour is 1–24."),
    weekdays: z
      .array(z.coerce.number().int().min(0).max(6))
      .min(1, "Choose at least one day.")
      .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
  })
  .refine((w) => w.endHour > w.startHour, {
    message: "The window must end after it starts.",
    path: ["endHour"],
  });
export type CallingWindow = z.infer<typeof callingWindowSchema>;

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1, "Give the campaign a name.").max(120, "That name is too long."),
  agentId: z.uuid("Choose an agent to place the calls."),
  callingWindow: callingWindowSchema.optional(),
});
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export const enqueueSchema = z.object({
  contactIds: z.array(z.uuid()).min(1, "Choose at least one contact."),
});
export type EnqueueInput = z.infer<typeof enqueueSchema>;

export const setStatusSchema = z.object({
  campaignId: z.uuid(),
  status: statusSchema,
});

/**
 * What an operator writes about a campaign.
 *
 * Bounded to the same figures the API applies, from the one shared object, so a brief that
 * draws fine here is a brief the API accepts. The purpose is the field that matters: without
 * it the agent has nothing to say it is calling about, and `prompts/outbound.ts` requires a
 * reason. It is optional here and required at Start, which is where the API checks it — a
 * half-written brief should save.
 */
export const campaignBriefSchema = z.object({
  purpose: z
    .string()
    .trim()
    .max(CAMPAIGN_LIMITS.purposeLength, "That is too long for one line.")
    .optional(),
  opening: z
    .string()
    .trim()
    .max(CAMPAIGN_LIMITS.openingLength, "That opening is too long.")
    .optional(),
  outcomes: z
    .array(z.string().trim().min(1).max(CAMPAIGN_LIMITS.outcomeLength))
    .max(CAMPAIGN_LIMITS.outcomes, "That is more outcomes than anyone chooses between.")
    .optional(),
  voicemailMode: z.enum(VOICEMAIL_MODES),
  maxAttempts: z
    .number()
    .int()
    .min(CAMPAIGN_LIMITS.attempts.min)
    .max(CAMPAIGN_LIMITS.attempts.max, "Ringing somebody more than ten times is not diligence."),
  retryAfterMinutes: z
    .number()
    .int()
    .min(CAMPAIGN_LIMITS.retryMinutes.min, "Leave at least a quarter of an hour between tries.")
    .max(CAMPAIGN_LIMITS.retryMinutes.max),
});
export type CampaignBriefInput = z.infer<typeof campaignBriefSchema>;

/**
 * How fast a campaign dials. Empty means no cap, which is what the API's null means and what
 * every campaign did before the pace existed — so an empty box is a choice, not a mistake.
 */
const cap = (min: number, max: number, tooMany: string) =>
  z.preprocess(
    (raw) => (raw === "" || raw === null || raw === undefined ? null : raw),
    z.coerce.number().int().min(min, "At least one.").max(max, tooMany).nullable(),
  );

export const paceSchema = z.object({
  campaignId: z.uuid(),
  maxConcurrentCalls: cap(
    CAMPAIGN_LIMITS.concurrentCalls.min,
    CAMPAIGN_LIMITS.concurrentCalls.max,
    "Nobody can take that many at once.",
  ),
  maxCallsPerHour: cap(
    CAMPAIGN_LIMITS.callsPerHour.min,
    CAMPAIGN_LIMITS.callsPerHour.max,
    "That is faster than the dialler goes.",
  ),
});
export type PaceInput = z.infer<typeof paceSchema>;
