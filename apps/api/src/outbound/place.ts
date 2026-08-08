import { loadConsentFacts, loadOutboundPolicy, type Db } from "@ansa/db";
import type { Logger, TenantId } from "@ansa/shared";
import type { PlacedCall, TelephonyProvider } from "@ansa/telephony";

import { mayCall, type ConsentPolicy } from "./consent";

/**
 * The only way a call gets placed.
 *
 * The consent check is here rather than beside the caller, so there is one door and not
 * one per caller. When outbound gets an API, a campaign runner or a tool, each of them
 * goes through this — the same argument CLAUDE.md makes about a single tool dispatch
 * path, and for the same reason: a second route is how the check ends up on one path and
 * not the other.
 */
export interface OutboundRequest {
  readonly tenantId: TenantId;
  readonly to: string;
  readonly from: string;
  readonly mediaStreamUrl: string;
  readonly statusCallbackUrl?: string;
  readonly amdCallbackUrl?: string;
  readonly earliestHour?: number;
  readonly latestHour?: number;
}

export class ConsentError extends Error {}

export const placeOutboundCall = async (deps: {
  readonly dataSource: Db | null;
  readonly telephony: TelephonyProvider;
  readonly log: Logger;
  readonly now?: () => Date;
}, request: OutboundRequest): Promise<PlacedCall> => {
  if (deps.dataSource === null) {
    // Without a database there is no way to know whether consent exists, and "cannot
    // check" is not "may proceed".
    throw new ConsentError("Cannot verify consent without a database");
  }

  const [facts, settings] = await Promise.all([
    loadConsentFacts(deps.dataSource, request.tenantId, request.to),
    loadOutboundPolicy(deps.dataSource, request.tenantId),
  ]);

  // An unrecognised policy is treated as the strictest rather than trusted or thrown on.
  // The database constrains the column too; two independent refusals are cheaper than
  // one missed one.
  const stored = settings?.policy;
  const policy: ConsentPolicy = stored === "existing_relationship" ? stored : "per_number";
  if (stored !== undefined && stored !== policy) {
    deps.log.error("tenant has an unrecognised consent policy, treating as strictest", {
      tenantId: request.tenantId,
      stored,
    });
  }

  // The request may narrow the tenant's window further; neither can widen the outer
  // bound, which mayCall clamps.
  const earliest = request.earliestHour ?? settings?.earliestHour ?? undefined;
  const latest = request.latestHour ?? settings?.latestHour ?? undefined;

  const verdict = mayCall({
    ...facts,
    policy,
    now: deps.now?.() ?? new Date(),
    ...(earliest === undefined || earliest === null ? {} : { earliestHour: earliest }),
    ...(latest === undefined || latest === null ? {} : { latestHour: latest }),
  });

  if (!verdict.allowed) {
    // Logged at warn with the tenant attached: a tenant repeatedly attempting calls it is
    // not allowed to make is a thing worth noticing, not just refusing.
    deps.log.warn("refused an outbound call", {
      tenantId: request.tenantId,
      policy,
      reason: verdict.reason,
    });
    throw new ConsentError(verdict.reason);
  }

  return deps.telephony.placeCall({
    to: request.to,
    from: request.from,
    mediaStreamUrl: request.mediaStreamUrl,
    parameters: { tenantId: request.tenantId },
    ...(request.statusCallbackUrl === undefined ? {} : { statusCallbackUrl: request.statusCallbackUrl }),
    ...(request.amdCallbackUrl === undefined ? {} : { amdCallbackUrl: request.amdCallbackUrl }),
  });
};
