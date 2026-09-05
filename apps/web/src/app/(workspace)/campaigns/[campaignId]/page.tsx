import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonClass, Card, PageHeader, Pagination, Tabs } from "@/components/ui";
import { currentPrincipal } from "@/features/auth/auth.service";
import { listAgents } from "@/features/agents/agents.service";
import { listContacts } from "@/features/contacts/contacts.service";
import { AddContactsButton } from "@/features/campaigns/components/add-contacts-button";
import { readTools } from "@/features/agents/agents.service";
import { CampaignBrief } from "@/features/campaigns/components/campaign-brief";
import { CampaignConversation } from "@/features/campaigns/components/campaign-conversation";
import { CampaignProgress } from "@/features/campaigns/components/campaign-progress";
import { CampaignStatusControl } from "@/features/campaigns/components/campaign-status-control";
import { ScheduledCallsTable } from "@/features/campaigns/components/scheduled-calls-table";
import { windowSummary } from "@/features/campaigns/campaigns.display";
import { listCampaignCalls, readCampaign } from "@/features/campaigns/campaigns.service";
import { refusedWith } from "@/lib/api/server";
import { readPaging } from "@/lib/paging";

export const metadata: Metadata = { title: "Campaign · Ansa" };
export const dynamic = "force-dynamic";

const Figure = ({ label, value }: { readonly label: string; readonly value: number }) => (
  <div>
    <div className="text-[19px] leading-none font-medium tabular-nums text-[var(--ink)]">
      {value}
    </div>
    <div className="mt-1 text-[11px] tracking-[0.06em] text-[var(--ink-3)] uppercase">{label}</div>
  </div>
);

/**
 * One campaign: where it has got to, and the three things you came to change.
 *
 * The page used to be one scroll holding everything — three stat boxes, a control strip, a
 * long brief form, a full flow canvas, and the call list underneath all of it. Two problems
 * with that. The canvas is a work surface and wants the width, which it did not get at the
 * bottom of a column; and the call list, the thing you check while a campaign is running, sat
 * below a form you had already finished with.
 *
 * So: one panel for the state, and tabs for the work. The panel is what is true right now —
 * status, progress, counts, and the two controls that change any of it, which now sit beside
 * the word they act on rather than a row away from it. The tabs are the three separate jobs,
 * each of which wants the whole width while it is the one being done.
 *
 * Progress is drawn by the component the list card uses, so a campaign reads the same way in
 * both places rather than being described twice.
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

  const [principal, calls, agentList, tools] = await Promise.all([
    currentPrincipal(),
    listCampaignCalls(campaignId, requested),
    listAgents(),
    /* The organisation's tools, so a tool step can name one that exists. A campaign
       enables nothing of its own — the tools belong to the agent it uses. */
    readTools(),
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

  /* Which tab opens depends on what the campaign is for at this moment, and its status is the
     honest signal. A draft is being written, so the brief is the work; anything that has been
     started is being watched, so the calls are. Guessing wrong costs one click; a fixed tab
     costs one on every visit for whichever half is the more common. */
  const initialTab = campaign.status === "draft" ? "brief" : "calls";

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

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-[240px] flex-1">
            {/* No status tag here: `CampaignStatusControl` renders its own, beside the button
                that moves it, and two of them a column apart is the same word twice. */}
            <CampaignProgress
              pending={campaign.pending}
              total={campaign.total}
              empty="Nobody on it yet. Add contacts and each one becomes a pending call."
            />

            <div className="mt-4 flex gap-7">
              <Figure label="Pending" value={campaign.pending} />
              <Figure label="Answered" value={campaign.answered} />
              <Figure label="On the campaign" value={campaign.total} />
            </div>
          </div>

          <div className="flex flex-col items-start gap-2.5">
            <CampaignStatusControl
              campaignId={campaign.id}
              status={campaign.status}
              canWrite={canWrite}
            />
            {canWrite && <AddContactsButton campaignId={campaign.id} contacts={contacts} />}
          </div>
        </div>
      </Card>

      <div className="mt-[26px]">
        <Tabs
          initial={initialTab}
          tabs={[
            {
              id: "calls",
              label: "Calls",
              panel: (
                <>
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
              ),
            },
            {
              id: "brief",
              label: "Brief",
              panel: (
                <CampaignBrief
                  campaignId={campaign.id}
                  editable={campaign.briefEditable}
                  canWrite={canWrite}
                  values={{
                    purpose: campaign.purpose,
                    opening: campaign.opening,
                    outcomes: campaign.outcomes,
                    voicemail: campaign.voicemail,
                    maxAttempts: campaign.maxAttempts,
                    retryAfterMinutes: campaign.retryAfterMinutes,
                  }}
                />
              ),
            },
            {
              id: "conversation",
              label: "Conversation",
              panel: (
                <CampaignConversation
                  campaignId={campaign.id}
                  flow={campaign.flow}
                  editable={campaign.briefEditable}
                  canWrite={canWrite}
                  tools={tools}
                  transferNumber={null}
                />
              ),
            },
          ]}
        />
      </div>
    </>
  );
};

export default CampaignPage;
