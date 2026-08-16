import { z } from "zod";

/**
 * Patterns shared by more than one feature's schema.
 *
 * Only things the API itself defines belong here, copied from its spec rather than invented.
 * A validation rule this app made up would reject submissions the API would have accepted,
 * and nobody debugging that would think to look in the frontend.
 */

/**
 * An email address, on three forms: sign in, sign up, and inviting a colleague.
 *
 * Blank and malformed are separate mistakes and get separate messages. That distinction used
 * to be the browser's — a `required` attribute caught the empty box before zod ever saw it —
 * and these fields no longer carry one, because a form spanning tabs cannot use native
 * validation and two kinds of form behaving differently is worse than neither. So the rule
 * makes the distinction itself. Without the `min`, an empty field is told it does not look
 * like an email address, which reads as a bug.
 */
export const emailAddress = z
  .string()
  .trim()
  .min(1, "Enter your email address.")
  .pipe(z.email("That does not look like an email address."));

/**
 * E.164, exactly as `openapi.json` states it for every phone number field.
 *
 * A plus, a non-zero leading digit, then seven to fifteen digits in total. Deliberately not
 * Nigeria-specific: the escalation destination and the test-call target are ordinary
 * international numbers and the product is not restricted to one country's format.
 */
export const E164 = /^\+[1-9][0-9]{6,14}$/;

/** What to tell somebody who typed a number in the wrong shape. */
export const E164_MESSAGE = "Use the full international form, starting with a plus.";
