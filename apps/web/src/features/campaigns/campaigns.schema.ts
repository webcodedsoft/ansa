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
