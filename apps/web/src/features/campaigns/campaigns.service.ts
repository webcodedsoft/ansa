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
