import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonClass, PageHeader, Pagination, Panel, PanelBody, SectionHead, Stat } from "@/components/ui";
import { currentPrincipal } from "@/features/auth/auth.service";
import { listAgents } from "@/features/agents/agents.service";
import { listContacts } from "@/features/contacts/contacts.service";
import { AddContactsButton } from "@/features/campaigns/components/add-contacts-button";
import { CampaignStatusControl } from "@/features/campaigns/components/campaign-status-control";
import { ScheduledCallsTable } from "@/features/campaigns/components/scheduled-calls-table";
import { windowSummary } from "@/features/campaigns/campaigns.display";
import { listCampaignCalls, readCampaign } from "@/features/campaigns/campaigns.service";
import { refusedWith } from "@/lib/api/server";
import { readPaging } from "@/lib/paging";

export const metadata: Metadata = { title: "Campaign · Ansa" };
export const dynamic = "force-dynamic";

/**
 * One campaign: where it has got to, who is on it, and the control that moves it.
 *
 * The status control is the point of the page — a campaign that never leaves draft never
 * dials. Beside it sit the counts and the calling window, and below it the scheduled calls
 * themselves, paged. Adding contacts and moving the status both need `campaigns:write`, so
 * the contact list is only fetched when the caller could act on it.
 */
const CampaignPage = async ({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly campaignId: string }>;
  readonly searchParams: Promise<{ readonly page?: string; readonly perPage?: string }>;
}) => {
  const { campaignId } = await params;
  const requested = readPaging(await searchParams);

  const campaign = await readCampaign(campaignId).catch((error: unknown) => {
    // Another organisation's campaign is a 404 here too, deliberately — it looks exactly like
    // one that does not exist, which is what the API intends.
    if (refusedWith(error, 404)) return null;
    throw error;
  });
  if (campaign === null) notFound();

  const [principal, calls, agentList] = await Promise.all([
    currentPrincipal(),
    listCampaignCalls(campaignId, requested),
    listAgents(),
  ]);
  const canWrite = principal.capabilities.includes("campaigns:write");

  const agentName =
    agentList.items.find((agent) => agent.agentId === campaign.agentId)?.name ?? "Unknown agent";

  // Only fetched when it can be acted on — the picker is the only thing that reads it.
  const contacts = canWrite
    ? (await listContacts(undefined, { perPage: 100 })).page.items.map((person) => ({
        id: person.id,
        displayName: person.displayName,
        phone: person.phone,
      }))
    : [];

  return (
    <>
      <PageHeader
        eyebrow="Outbound"
        title={campaign.name}
        meta={`${agentName} · ${windowSummary(campaign.callingWindow)}`}
        actions={
          <Link href="/campaigns" className={buttonClass()}>
            All campaigns
          </Link>
        }
      />

      <div className="grid gap-3.5 sm:grid-cols-3">
        <Stat label="Pending" value={campaign.pending} unit="calls" />
        <Stat label="Answered" value={campaign.answered} unit="calls" />
        <Stat label="On the campaign" value={campaign.total} unit="contacts" />
      </div>

      <Panel className="mt-[26px]">
        <PanelBody className="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
          <CampaignStatusControl
            campaignId={campaign.id}
            status={campaign.status}
            canWrite={canWrite}
          />
          {canWrite && <AddContactsButton campaignId={campaign.id} contacts={contacts} />}
        </PanelBody>
      </Panel>

      <SectionHead>Scheduled calls</SectionHead>
      <ScheduledCallsTable calls={calls.items} />

      <Pagination
        basePath={`/campaigns/${campaign.id}`}
        page={calls.page}
        perPage={calls.perPage}
        totalPages={calls.totalPages}
        total={calls.total}
        unit="calls"
      />
    </>
  );
};

export default CampaignPage;
