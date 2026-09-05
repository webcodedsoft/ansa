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
  body: { readonly name?: string; readonly callingWindow?: CampaignWindow | null },
) => (await api()).campaigns.edit({ path: { campaignId }, body });

export const listCampaignCalls = async (
  campaignId: string,
  paging: { readonly page?: number; readonly perPage?: number } = {},
) => (await api()).campaigns.calls({ path: { campaignId }, query: paging });

export const enqueueContacts = async (campaignId: string, contactIds: readonly string[]) =>
  (await api()).campaigns.enqueue({ path: { campaignId }, body: { contactIds } });

export const setCampaignStatus = async (campaignId: string, status: CampaignStatus) =>
  (await api()).campaigns.setStatus({ path: { campaignId }, body: { status } });

export type CampaignSummary = Awaited<ReturnType<typeof listCampaigns>>["items"][number];
export type CampaignDetail = Awaited<ReturnType<typeof readCampaign>>;
export type CampaignStatus = CampaignSummary["status"];
export type ScheduledCall = Awaited<ReturnType<typeof listCampaignCalls>>["items"][number];
export type ScheduledCallStatus = ScheduledCall["status"];

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
    readonly voicemail: { readonly mode: "hang_up" | "leave_message"; readonly message?: string } | null;
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
