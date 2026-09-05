import {
  claimScheduledCall,
  readDueScheduledCalls,
  recordAttempt,
  withOrganization,
  type Db,
  type DueCall,
} from "@ansa/db";
import type { Logger, OrganizationId } from "@ansa/shared";

import { ConsentError } from "./place";

/**
 * The thing that actually rings people.
 *
 * `scheduled_calls` filled up and nothing drained it: `readDueScheduledCalls`,
 * `claimScheduledCall` and `recordAttempt` each had exactly one caller and it was a test. Every
 * guarantee the outbound slice makes — consent, the do-not-call list, the calling window,
 * answering-machine detection, a retry that is not harassment — was therefore untested in
 * practice, because there was no path from a row to a dial for any of them to sit on.
 *
 * This is that path, and it is deliberately the *only* one. It calls `placeOutboundCall` and
 * nothing else, for the reason that file gives about itself: a second origination path is how
 * the consent check ends up on one route and not the other, and the route without it would be
 * the one with a button on it.
 *
 * **What it will not do**, and each of these is a decision rather than an omission:
 *
 * - It never dials for a campaign that is not `running`. That is in the query, so pausing a
 *   campaign stops it at the source rather than by this remembering to look.
 * - It never dials a row past its campaign's attempt ceiling, and the ceiling is checked in
 *   two places on purpose: the query keeps a spent row out of every sweep, and the retry
 *   decision below is what refuses to grant another.
 * - It never retries a refusal. A number on the do-not-call list is not a transient failure,
 *   and "try again in four hours" applied to a suppression is the exact behaviour the
 *   suppression exists to prevent.
 * - It claims before it dials, and the claim is a conditional update. Two processes sweeping
 *   the same row cannot both place a call: the second claim matches nothing.
 */

/** Often enough that a campaign feels live, rarely enough to be invisible in the logs. */
const SWEEP_EVERY_MS = 10_000;

/** How many calls one pass will place. Bounded so a list of five thousand drains steadily. */
const BATCH = 5;

export interface DialerDeps {
  readonly dataSource: Db | null;
  readonly log: Logger;
  /** Places the call. The one door; see `place.ts`. */
  readonly place: (
    organizationId: OrganizationId,
    due: DueCall,
  ) => Promise<{ readonly callId: string | null }>;
  /** Which organisations have work. Injected so a sweep does not scan every tenant blindly. */
  readonly organizationsWithWork: () => Promise<readonly OrganizationId[]>;
  readonly now?: () => Date;
}

export interface SweepReport {
  readonly considered: number;
  readonly placed: number;
  readonly suppressed: number;
  readonly failed: number;
}

/**
 * When to try again, or null when there will not be a next time.
 *
 * `attempts` has already been incremented by the claim, so it is the count including the one
 * that just happened. A row that has used its last attempt gets null, which `recordAttempt`
 * writes as a terminal status rather than as a row that sits pending forever.
 */
const nextAttempt = (due: DueCall, from: Date): Date | null =>
  due.attempts + 1 >= due.maxAttempts
    ? null
    : new Date(from.getTime() + due.retryAfterMinutes * 60_000);

/**
 * One pass over one organisation's due calls.
 *
 * Never throws. This runs beside live calls, and one number that cannot be dialled at four in
 * the morning is not worth taking the process down for — or worth abandoning the rest of the
 * batch over, which is why each row is handled on its own.
 */
export const sweepOrganization = async (
  deps: DialerDeps,
  organizationId: OrganizationId,
): Promise<SweepReport> => {
  const now = deps.now ?? ((): Date => new Date());
  const dataSource = deps.dataSource;
  if (dataSource === null) return { considered: 0, placed: 0, suppressed: 0, failed: 0 };

  const due = await withOrganization(dataSource, organizationId, (scope) =>
    readDueScheduledCalls(scope, now(), BATCH),
  );

  let placed = 0;
  let suppressed = 0;
  let failed = 0;

  for (const row of due) {
    /* Claimed first, and in its own transaction. Between reading the batch and reaching this
       row another sweep may have taken it; the conditional update is what says so. */
    const mine = await withOrganization(dataSource, organizationId, (scope) =>
      claimScheduledCall(scope, row.id),
    );
    if (!mine) continue;

    /* A campaign whose agent has no number cannot dial. The caller ID has to be a number the
       person can ring back — a call from a number that goes nowhere is the shape of a nuisance
       call whatever is said on it. Terminal rather than retried: no amount of waiting gives an
       agent a number. */
    if (row.fromNumber === null) {
      suppressed += 1;
      await withOrganization(dataSource, organizationId, (scope) =>
        recordAttempt(scope, row.id, {
          status: "suppressed",
          outcome: "this campaign's agent has no number to call from",
          nextAttemptAt: null,
        }),
      );
      continue;
    }

    try {
      const outcome = await deps.place(organizationId, row);
      placed += 1;
      await withOrganization(dataSource, organizationId, (scope) =>
        recordAttempt(scope, row.id, {
          status: "answered",
          outcome: "placed",
          callId: outcome.callId,
          nextAttemptAt: null,
        }),
      );
    } catch (error) {
      const at = now();
      /* A refusal is terminal and a failure is not, and telling them apart is the whole point
         of this branch. `placeOutboundCall` throws `ConsentError` when the gate said no —
         suppression, withdrawn consent, outside the calling window — and retrying any of those
         is the behaviour the gate exists to prevent. Everything else is the carrier or the
         network, which is worth another go. */
      const refused = error instanceof ConsentError;
      const reason = error instanceof Error ? error.message : String(error);

      if (refused) {
        suppressed += 1;
        await withOrganization(dataSource, organizationId, (scope) =>
          recordAttempt(scope, row.id, {
            status: "suppressed",
            outcome: reason,
            nextAttemptAt: null,
          }),
        );
        continue;
      }

      failed += 1;
      const retryAt = nextAttempt(row, at);
      deps.log.warn("outbound attempt failed", { scheduledCallId: row.id, reason });
      await withOrganization(dataSource, organizationId, (scope) =>
        recordAttempt(scope, row.id, {
          status: "failed",
          outcome: reason,
          nextAttemptAt: retryAt,
        }),
      );
    }
  }

  return { considered: due.length, placed, suppressed, failed };
};

/**
 * One pass over every organisation with work.
 *
 * Organisations are swept one after another rather than together: the carrier is the
 * bottleneck, and twenty tenants dialling at once would produce a burst that looks like an
 * attack rather than a campaign.
 */
export const sweepOnce = async (deps: DialerDeps): Promise<SweepReport> => {
  const organizations = await deps.organizationsWithWork();
  let total: SweepReport = { considered: 0, placed: 0, suppressed: 0, failed: 0 };

  for (const organizationId of organizations) {
    try {
      const report = await sweepOrganization(deps, organizationId);
      total = {
        considered: total.considered + report.considered,
        placed: total.placed + report.placed,
        suppressed: total.suppressed + report.suppressed,
        failed: total.failed + report.failed,
      };
    } catch (error) {
      // One tenant's database trouble is not the others' problem.
      deps.log.warn("outbound sweep failed for an organisation", {
        organizationId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return total;
};

export const DIALER_SWEEP_MS = SWEEP_EVERY_MS;
