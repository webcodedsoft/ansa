import { z } from "zod";

import { E164, E164_MESSAGE } from "@/lib/patterns";

/**
 * Placing a test call.
 *
 * The number is checked here so a typo comes back as a field error instead of a 422, but
 * nothing else is: whether the destination may lawfully be called is the consent gate's
 * decision, it lives in the API, and a frontend that tried to anticipate it would either be
 * wrong or would look like a place where the rule could be relaxed.
 */
export const testCallSchema = z.object({
  to: z.string().trim().regex(E164, E164_MESSAGE),
});

/**
 * Recording what the caller actually said.
 *
 * There is no maximum here on purpose. The API has one and it is the authority; guessing at
 * it would either reject something the API accepts or let through something it does not,
 * and the second is harmless while the first is a bug nobody can explain from this side.
 */
export const correctionSchema = z.object({
  callId: z.uuid(),
  transcriptId: z.uuid(),
  correctedText: z.string().trim().min(1, "Write what was actually said."),
});

export type TestCallInput = z.infer<typeof testCallSchema>;
export type CorrectionInput = z.infer<typeof correctionSchema>;
