/**
 * Patterns shared by more than one feature's schema.
 *
 * Only things the API itself defines belong here, copied from its spec rather than invented.
 * A validation rule this app made up would reject submissions the API would have accepted,
 * and nobody debugging that would think to look in the frontend.
 */

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
