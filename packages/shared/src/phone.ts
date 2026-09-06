/**
 * One spelling of a number, for everything that stores or dials one.
 *
 * There are two right answers about a Nigerian phone number and this file is only one of
 * them. **E.164 (`+2348030000001`) is the storage and dialling form** — what the carrier
 * gives, what `contacts.phone` holds, what migration 0015's CHECK constraint enforces, what
 * `phoneNumber()` validates. **National (`08030000001`) is the spoken form** — what a caller
 * says when they give a callback number, and what `packages/normalizer`'s `canonicalPhone`
 * produces so a readback sounds like a person reading it out.
 *
 * Both are correct. What was missing is anything that converts between them, and anything
 * guarding the door a carrier's caller ID comes through: the console normalised on add and
 * import, and the call path stored whatever arrived. Every caller ID on record today is
 * already E.164, so this is a guard rather than a repair — but a carrier that ever presented
 * `08030000001` would otherwise mint a second person for a number we already know, with no
 * way back.
 */

/**
 * E.164, as migration 0015's CHECK constraint spells it.
 *
 * Exported so the copies that used to spell it themselves — the API's `phoneNumber()`, the
 * handoff destination, the number readiness and environment checks, the console's own
 * pattern — agree with the constraint by construction rather than by review.
 */
export const E164_PATTERN = "^\\+[1-9][0-9]{6,14}$";

const E164 = new RegExp(E164_PATTERN);

/** `0`, then 7, 8 or 9, then nine digits: every Nigerian mobile, and no landline. */
const NIGERIAN_NATIONAL = /^0[789]\d{9}$/;

/** The same number with its country code and no plus, which is how a spreadsheet often holds it. */
const NIGERIAN_BARE = /^234[789]\d{9}$/;

/**
 * A number as it will be stored and dialled, or null when it is not one.
 *
 * Null rather than a throw, and null rather than a guess: a malformed spreadsheet cell
 * becomes a skipped row with a count, and an unrecognisable caller ID stays as the carrier
 * gave it rather than being mangled into a number belonging to somebody else. Only the
 * separators people actually type are stripped — a string of letters is not a phone number
 * with punctuation in it.
 */
export const toE164 = (raw: string): string | null => {
  const trimmed = raw.replace(/[\s()\-.]/g, "");
  if (E164.test(trimmed)) return trimmed;
  if (NIGERIAN_NATIONAL.test(trimmed)) return `+234${trimmed.slice(1)}`;
  if (NIGERIAN_BARE.test(trimmed)) return `+${trimmed}`;
  return null;
};

/**
 * The storage form of what a carrier said, keeping the original when it makes no sense.
 *
 * The call path uses this rather than `toE164` directly, because a caller ID is evidence: a
 * shape nothing recognises is worth recording exactly as it arrived, so somebody can see what
 * the carrier actually sent. Withheld numbers arrive as null and stay null — there is nothing
 * to file them under, which is the existing design.
 */
export const asDialled = (raw: string | null): string | null =>
  raw === null || raw.trim() === "" ? null : (toE164(raw) ?? raw);

/**
 * Whether two spellings mean the same number.
 *
 * Both are reduced to E.164 first, so `08030000001`, `+234 803 000 0001` and `2348030000001`
 * are one person. Two strings neither of which is a number are never "the same", however
 * equal they look — that way a pair of empty or malformed values cannot merge two records.
 */
export const sameNumber = (a: string | null, b: string | null): boolean => {
  if (a === null || b === null) return false;
  const left = toE164(a);
  const right = toE164(b);
  return left !== null && right !== null && left === right;
};
