import type { Metadata } from "next";
import Link from "next/link";

import { buttonClass, EmptyState, PageHeader, Pagination, Panel } from "@/components/ui";
import { currentPrincipal } from "@/features/auth/auth.service";
import { listAgents } from "@/features/agents/agents.service";
import { CampaignCard } from "@/features/campaigns/components/campaign-card";
import { listCampaigns } from "@/features/campaigns/campaigns.service";
import { readPaging } from "@/lib/paging";

export const metadata: Metadata = { title: "Campaigns · Ansa" };
export const dynamic = "force-dynamic";

type CampaignsSearch = { readonly page?: string; readonly perPage?: string };

/**
 * The organisation's outbound campaigns.
 *
 * A campaign is an agent placing a list of calls within a set of hours. Cards rather than a
 * table, because the question people bring here is "which of these is running, and how far
 * has it got" — a progress bar answers that at a glance and a row of six equal columns does
 * not. The counts behind it are the API's, taken across the scheduled calls under each
 * campaign rather than derived from anything on this page.
 *
 * The agents are still loaded, but only to name the one behind each campaign. Choosing an
 * agent moved to `/campaigns/new` when creating stopped being a dialog.
 */
const CampaignsPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<CampaignsSearch>;
}) => {
  const requested = readPaging(await searchParams);
  const [principal, { items, page, perPage, total, totalPages }, agentList] = await Promise.all([
    currentPrincipal(),
    listCampaigns(requested),
    listAgents(),
  ]);

  const canWrite = principal.capabilities.includes("campaigns:write");
  const agentName = new Map(agentList.items.map((agent) => [agent.agentId, agent.name]));

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Campaigns"
        meta="An agent, a list of people, and the hours it may ring them. Consent and do-not-call are enforced on every call, not configured away here."
        actions={
          canWrite ? (
            <Link href="/campaigns/new" className={buttonClass("primary")}>
              New campaign
            </Link>
          ) : undefined
        }
      />

      {items.length === 0 ? (
        <Panel>
          <EmptyState title="No campaigns yet">
            A campaign rings a list of contacts with one of your agents. It starts as a draft
            with nobody on it — you add people and choose when it may call before anything is
            dialled. {canWrite ? 'Use "New campaign" above to start one.' : ""}
          </EmptyState>
        </Panel>
      ) : (
        <>
          {/* Two up from a tablet, three only on a genuinely wide screen. A campaign card is a
              short paragraph rather than a row — a name, a progress bar and a sentence about
              its calling hours — and it stops reading as one below about 300px, where the
              window summary starts breaking mid-phrase. Three across earns its place only when
              the grid is wide enough to keep each column above that. */}
          <div className="grid gap-3.5 md:grid-cols-2 2xl:grid-cols-3">
            {items.map((campaign) => (
              <CampaignCard
                key={campaign.id}
                campaign={campaign}
                agentName={agentName.get(campaign.agentId) ?? "Unknown agent"}
              />
            ))}
          </div>

          <Pagination
            basePath="/campaigns"
            page={page}
            perPage={perPage}
            totalPages={totalPages}
            total={total}
            unit="campaigns"
          />
        </>
      )}
    </>
  );
};

export default CampaignsPage;
