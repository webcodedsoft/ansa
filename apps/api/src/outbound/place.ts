import { loadConsentFacts, type Db } from "@ansa/db";
import type { Logger, TenantId } from "@ansa/shared";
import type { PlacedCall, TelephonyProvider } from "@ansa/telephony";

import { mayCall } from "./consent";

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

  const facts = await loadConsentFacts(deps.dataSource, request.tenantId, request.to);
  const verdict = mayCall({
    ...facts,
    now: deps.now?.() ?? new Date(),
    ...(request.earliestHour === undefined ? {} : { earliestHour: request.earliestHour }),
    ...(request.latestHour === undefined ? {} : { latestHour: request.latestHour }),
  });

  if (!verdict.allowed) {
    // Logged at warn with the tenant attached: a tenant repeatedly attempting calls it is
    // not allowed to make is a thing worth noticing, not just refusing.
    deps.log.warn("refused an outbound call", {
      tenantId: request.tenantId,
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
