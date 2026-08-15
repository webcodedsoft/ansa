import { loadConsentFacts, loadOutboundPolicy, loadAgentForOrganization, type Db } from "@ansa/db";
import type { Logger, OrganizationId } from "@ansa/shared";
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
  readonly organizationId: OrganizationId;
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

  const [facts, settings, config] = await Promise.all([
    loadConsentFacts(deps.dataSource, request.organizationId, request.to),
    loadOutboundPolicy(deps.dataSource, request.organizationId),
    // Alongside the other two rather than after them: the agent's own switches are needed
    // before origination, and placing a call is not the answer path, but a third round
    // trip in series would still be a third round trip.
    loadAgentForOrganization(deps.dataSource, request.organizationId),
  ]);

  // An unrecognised policy is treated as the strictest rather than trusted or thrown on.
  // The database constrains the column too; two independent refusals are cheaper than
  // one missed one.
  const stored = settings?.policy;
  const policy: ConsentPolicy = stored === "existing_relationship" ? stored : "per_number";
  if (stored !== undefined && stored !== policy) {
    deps.log.error("organization has an unrecognised consent policy, treating as strictest", {
      organizationId: request.organizationId,
      stored,
    });
  }

  // The request may narrow the organization's window further; neither can widen the outer
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
    // Logged at warn with the organization attached: a organization repeatedly attempting calls it is
    // not allowed to make is a thing worth noticing, not just refusing.
    deps.log.warn("refused an outbound call", {
      organizationId: request.organizationId,
      policy,
      reason: verdict.reason,
    });
    throw new ConsentError(verdict.reason);
  }

  return deps.telephony.placeCall({
    to: request.to,
    from: request.from,
    mediaStreamUrl: request.mediaStreamUrl,
    parameters: {
      organizationId: request.organizationId,
      direction: "outbound",
      // The number we dialled and the number we dialled from, so the call record does
      // not have to reconstruct either from a socket that knows neither.
      dialled: request.to,
      caller: request.from,
    },
    ...(request.statusCallbackUrl === undefined ? {} : { statusCallbackUrl: request.statusCallbackUrl }),
    /* Answering-machine detection is the agent's choice (migration 0020), and it is
       expressed by withholding the callback rather than by a flag the carrier ignores:
       Twilio only runs detection when it has somewhere to report it. Off means the call
       connects the moment it is answered, voicemail included — which is what an agent
       that never dials a mobile wants, and a second of answer latency saved. */
    ...(request.amdCallbackUrl === undefined || config?.answeringMachineDetection !== true
      ? {}
      : { amdCallbackUrl: request.amdCallbackUrl }),
  });
};
