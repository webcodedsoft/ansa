/**
 * Whether a number may lawfully be called right now.
 *
 * Pure: facts in, verdict out. It performs no lookups of its own, so the decision can be
 * tested exhaustively without a database and cannot quietly depend on anything it was
 * not given.
 *
 * In the dispatch path rather than in configuration, for the reason CLAUDE.md gives about
 * risk tiers: a tenant configuring "call these numbers" must not be able to configure the
 * check away. Consent is evidence a tenant records; whether it is sufficient is ours.
 */

/** Nigeria is UTC+1 year-round, with no daylight saving. */
const WAT_OFFSET_MINUTES = 60;

export interface ConsentFacts {
  /** Most recent consent record for this tenant and number, if any. */
  readonly consent: { readonly grantedAt: Date; readonly revokedAt: Date | null } | null;
  /** Any suppression, this tenant's or global. */
  readonly suppressed: boolean;
  readonly now: Date;
  /** Local hour, inclusive, that calling may begin. */
  readonly earliestHour?: number;
  /** Local hour, exclusive, after which calling must stop. */
  readonly latestHour?: number;
}

export type ConsentVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * 08:00–20:00 WAT. Deliberately narrower than the day: a call at 21:00 is legal in some
 * readings and is still the kind of thing that produces complaints, and the cost of
 * waiting until morning is nothing.
 */
const DEFAULT_EARLIEST = 8;
const DEFAULT_LATEST = 20;

const hourInWat = (now: Date): number =>
  new Date(now.getTime() + WAT_OFFSET_MINUTES * 60_000).getUTCHours();

export const mayCall = (facts: ConsentFacts): ConsentVerdict => {
  // Suppression first. It outranks consent, because withdrawing by asking not to be
  // called is the most explicit signal a person can give and must not be overridden by
  // an older record saying they once agreed.
  if (facts.suppressed) return { allowed: false, reason: "number is on the do-not-call list" };

  if (facts.consent === null) {
    // Fails closed. The absence of a record is precisely what an unlawful call looks
    // like from the outside, so it cannot be treated as permission.
    return { allowed: false, reason: "no consent on record for this number" };
  }

  if (facts.consent.revokedAt !== null && facts.consent.revokedAt <= facts.now) {
    return { allowed: false, reason: "consent was withdrawn" };
  }

  if (facts.consent.grantedAt > facts.now) {
    // A future-dated grant is a data error, not permission.
    return { allowed: false, reason: "consent is dated in the future" };
  }

  const hour = hourInWat(facts.now);
  const earliest = facts.earliestHour ?? DEFAULT_EARLIEST;
  const latest = facts.latestHour ?? DEFAULT_LATEST;
  if (hour < earliest || hour >= latest) {
    return {
      allowed: false,
      reason: `outside calling hours (${String(hour).padStart(2, "0")}:00 WAT, allowed ${earliest}-${latest})`,
    };
  }

  return { allowed: true };
};
