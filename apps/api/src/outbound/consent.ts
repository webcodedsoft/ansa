/**
 * Whether a number may lawfully be called right now.
 *
 * Pure: facts in, verdict out. It performs no lookups of its own, so the decision can be
 * tested exhaustively without a database and cannot quietly depend on anything it was
 * not given.
 *
 * In the dispatch path rather than in configuration, for the reason CLAUDE.md gives about
 * risk tiers: a organization configuring "call these numbers" must not be able to configure the
 * check away. Consent is evidence a organization records; whether it is sufficient is ours.
 */

import { hourInWat } from "@ansa/shared";

/**
 * How an organisation establishes it may call someone.
 *
 * Organizations choose their lawful basis. They do not choose whether one is required, and
 * they cannot switch the check off — that is the line CLAUDE.md draws, and it is what
 * stops a configuration mistake becoming an unlawful call.
 *
 * The two are genuinely different situations rather than strict-and-lax. An insurer
 * ringing its own policyholder about their renewal is not relying on marketing consent
 * and should not have to manufacture a per-number record to say so; a company cold-
 * calling a purchased list is, and must.
 */
export type ConsentPolicy =
  /** A recorded, per-number grant. The default, and the only basis for unsolicited calls. */
  | "per_number"
  /**
   * A standing relationship — the organization calling its own customers about their own
   * business with it. The declaration lives on the organization and is versioned, so a call can
   * always be traced to the basis in force when it was placed (R7.5).
   */
  | "existing_relationship";

/**
 * The outer bound on calling hours, which no organization may widen.
 *
 * Narrowing it is a choice an organisation makes about its own customers. Widening it is
 * a choice about someone else's evening, which is not theirs to make.
 */
const OUTER_EARLIEST_HOUR = 8;
const OUTER_LATEST_HOUR = 20;

/**
 * Numbers whose local time this can work out.
 *
 * Nigeria, and nothing else. `hourInWat` is addition against a fixed offset — correct for
 * every +234 number all year, and quietly wrong for any other. A London recipient at the
 * start of our window is being rung at seven in the morning; a New York one at two.
 *
 * There is no timezone table here and there should not be one until somebody actually
 * dials outside Nigeria. What there is instead is a refusal: a number this cannot place in
 * a day is a number it will not clear for calling. Fails closed, like every other arm of
 * this function, and for the same reason — the cost of waiting is nothing and the cost of
 * a two-in-the-morning cold call is a regulator.
 */
const KNOWN_LOCAL_TIME = /^\+?234\d+$/;

/**
 * Nigerian national format, which is what an operator's own list usually holds.
 *
 * `08030000000` is the same person as `+2348030000000` and there is no other country it
 * could be, so refusing it would fail closed on the commonest input rather than on an
 * unusual one.
 */
const NIGERIAN_NATIONAL = /^0[789]\d{9}$/;

export interface ConsentFacts {
  /**
   * The number about to be dialled, as it will be dialled.
   *
   * Here because the calling window is in the recipient's day and not ours, and nothing
   * else in these facts says whose day it is. Absent behaves as unknown, which refuses.
   */
  readonly to?: string;
  /** The organisation's declared basis. Absent behaves as the strictest. */
  readonly policy?: ConsentPolicy;
  /** Most recent consent record for this organization and number, if any. */
  readonly consent: { readonly grantedAt: Date; readonly revokedAt: Date | null } | null;
  /** Any suppression, this organization's or global. */
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

export const mayCall = (facts: ConsentFacts): ConsentVerdict => {
  // Suppression first. It outranks consent, because withdrawing by asking not to be
  // called is the most explicit signal a person can give and must not be overridden by
  // an older record saying they once agreed.
  if (facts.suppressed) return { allowed: false, reason: "number is on the do-not-call list" };

  // Honoured under every policy. Someone who explicitly revoked has said something more
  // specific than any standing basis the organisation asserts, and "we have a
  // relationship" must not quietly outrank "stop calling me".
  if (facts.consent?.revokedAt != null && facts.consent.revokedAt <= facts.now) {
    return { allowed: false, reason: "consent was withdrawn" };
  }

  const policy = facts.policy ?? "per_number";
  if (policy === "per_number") {
    if (facts.consent === null) {
      // Fails closed. The absence of a record is precisely what an unlawful call looks
      // like from the outside, so it cannot be treated as permission.
      return { allowed: false, reason: "no consent on record for this number" };
    }
    if (facts.consent.grantedAt > facts.now) {
      // A future-dated grant is a data error, not permission.
      return { allowed: false, reason: "consent is dated in the future" };
    }
  }

  /* Before the hour is computed, because computing it presumes an answer to this. A number
     whose day we cannot place is not one we can say is inside anybody's calling window. */
  const to = (facts.to ?? "").replace(/[\s()-]/g, "");
  if (!KNOWN_LOCAL_TIME.test(to) && !NIGERIAN_NATIONAL.test(to)) {
    return {
      allowed: false,
      reason:
        "cannot tell the local time for this number, so cannot tell whether it is inside calling hours",
    };
  }

  const hour = hourInWat(facts.now);
  // Clamped, not trusted. A organization may narrow the window; the outer bound is ours.
  const earliest = Math.max(OUTER_EARLIEST_HOUR, facts.earliestHour ?? DEFAULT_EARLIEST);
  const latest = Math.min(OUTER_LATEST_HOUR, facts.latestHour ?? DEFAULT_LATEST);
  if (hour < earliest || hour >= latest) {
    return {
      allowed: false,
      reason: `outside calling hours (${String(hour).padStart(2, "0")}:00 WAT, allowed ${earliest}-${latest})`,
    };
  }

  return { allowed: true };
};
