import { api } from "@/lib/api/server";

/**
 * Everything this app does with outbound campaigns.
 *
 * A campaign is an agent, an optional calling window, and a list of people to ring. This
 * file is the only place that talks to the `campaigns.*` client — pages read through it and
 * actions write through it, which is what keeps an endpoint rename a one-file change.
 *
 * The agent picker and the contact picker read through the agents and contacts features'
 * own services rather than reaching for their clients here; those seams belong to them.
 */

export const listCampaigns = async (
  paging: { readonly page?: number; readonly perPage?: number } = {},
) => (await api()).campaigns.list({ query: paging });

export const readCampaign = async (campaignId: string) =>
  (await api()).campaigns.detail({ path: { campaignId } });

export interface CampaignWindow {
  readonly startHour: number;
  readonly endHour: number;
  readonly weekdays: readonly number[];
}

export const createCampaign = async (body: {
  readonly name: string;
  readonly agentId: string;
  readonly callingWindow?: CampaignWindow;
}) => (await api()).campaigns.create({ body });

export const editCampaign = async (
  campaignId: string,
  body: {
    readonly name?: string;
    readonly callingWindow?: CampaignWindow | null;
    /** ISO-8601. Null clears it back to starting by hand. */
    readonly startsAt?: string | null;
    /** ISO-8601. Null clears it back to running until the list is exhausted. */
    readonly endsAt?: string | null;
    /** The pace. Null lifts a cap. */
    readonly maxConcurrentCalls?: number | null;
    readonly maxCallsPerHour?: number | null;
  },
) => (await api()).campaigns.edit({ path: { campaignId }, body });

/** How a campaign turned out: what the dialler did, and what the calls came to. */
export const readCampaignBreakdown = async (campaignId: string) =>
  (await api()).campaigns.breakdown({ path: { campaignId } });

/** The last few calls that happened, newest first. What a running campaign's page polls. */
export const readRecentCalls = async (campaignId: string) =>
  (await api()).campaigns.recent({ path: { campaignId } });

/** Put the numbers that did not connect back in the queue. Returns how many. */
export const retryUnreached = async (campaignId: string) =>
  (await api()).campaigns.retry({ path: { campaignId } });

/** The brief and the flow onto a fresh draft. Nobody comes with it. */
export const duplicateCampaign = async (campaignId: string, name: string) =>
  (await api()).campaigns.duplicate({ path: { campaignId }, body: { name } });

export const listCampaignCalls = async (
  campaignId: string,
  paging: {
    readonly page?: number;
    readonly perPage?: number;
    /** One status, or omitted for all of them. The total narrows with it. */
    readonly status?: ScheduledCallStatus;
  } = {},
) => (await api()).campaigns.calls({ path: { campaignId }, query: paging });

export const enqueueContacts = async (campaignId: string, contactIds: readonly string[]) =>
  (await api()).campaigns.enqueue({ path: { campaignId }, body: { contactIds } });

export const setCampaignStatus = async (
  campaignId: string,
  status: CampaignStatus,
  /** Read only on a move to paused. */
  reason: string | null = null,
) => (await api()).campaigns.setStatus({ path: { campaignId }, body: { status, reason } });

export type CampaignSummary = Awaited<ReturnType<typeof listCampaigns>>["items"][number];
export type CampaignDetail = Awaited<ReturnType<typeof readCampaign>>;
export type CampaignStatus = CampaignSummary["status"];
export type ScheduledCall = Awaited<ReturnType<typeof listCampaignCalls>>["items"][number];

/**
 * The status a scheduled call can be in, written out rather than derived.
 *
 * It used to be `ScheduledCall["status"]`, which was tidy until `listCampaignCalls` gained a
 * `status` filter: the alias came from the function's return type and the function's
 * parameter came from the alias, and TypeScript refuses that circle. Writing the set here
 * breaks it, and the list is wanted in its own right — the filter control on the calls tab
 * renders exactly these, in this order.
 *
 * Drift is caught rather than hoped against: `callTone` and `callStatusLabel` in
 * `campaigns.display` are `Record<ScheduledCallStatus, …>`, so a status the API adds and this
 * misses fails to compile there.
 */
export const SCHEDULED_STATUSES = [
  "pending",
  "placing",
  "answered",
  "no_answer",
  "busy",
  "voicemail",
  "failed",
  "suppressed",
] as const;

export type ScheduledCallStatus = (typeof SCHEDULED_STATUSES)[number];

/**
 * Write what this campaign is about.
 *
 * Absent fields are left alone, null clears one. Refused with a 409 once the campaign is
 * running — the brief is fixed from the moment calls can be in flight, so nobody's purpose
 * changes underneath them halfway down a list.
 */
export const saveBrief = async (
  campaignId: string,
  brief: {
    readonly purpose: string | null;
    readonly opening: string | null;
    readonly outcomes: readonly string[] | null;
    readonly voicemail: { readonly mode: "hang_up" | "leave_message" } | null;
    readonly maxAttempts: number;
    readonly retryAfterMinutes: number;
  },
) => (await api()).campaigns.setBrief({ path: { campaignId }, body: brief });

/** The conversation, drawn on the canvas. Separate call so the graph is saved on its own. */
export const saveCampaignFlow = async (campaignId: string, flow: unknown) =>
  (await api()).campaigns.setBrief({
    path: { campaignId },
    body: { flow: flow as never },
  });
