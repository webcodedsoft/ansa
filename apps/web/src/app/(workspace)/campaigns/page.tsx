import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState, PageHeader, Pagination, Panel, Table, Tag, Td, Th, Tr } from "@/components/ui";
import { currentPrincipal } from "@/features/auth/auth.service";
import { listAgents } from "@/features/agents/agents.service";
import { NewCampaignButton } from "@/features/campaigns/components/new-campaign-button";
import { campaignTone } from "@/features/campaigns/campaigns.display";
import { listCampaigns } from "@/features/campaigns/campaigns.service";
import { when } from "@/lib/format";
import { readPaging } from "@/lib/paging";

export const metadata: Metadata = { title: "Outbound · Ansa" };
export const dynamic = "force-dynamic";

type CampaignsSearch = { readonly page?: string; readonly perPage?: string };

/**
 * The organisation's outbound campaigns.
 *
 * A campaign is an agent placing a list of calls within a set of hours. Each row carries
 * where it has got to — how many are still pending and how many have been answered — counted
 * by the API across the scheduled calls under it, not derived from this page's rows.
 *
 * Creating one needs an agent, so the agents are loaded here and handed to the button: an
 * organisation with none is told it must build one first rather than shown a form that fails.
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
  const liveAgents = agentList.items
    .filter((agent) => agent.deletedAt === null)
    .map((agent) => ({ agentId: agent.agentId, name: agent.name }));

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Outbound"
        meta="Campaigns that place calls: an agent, a list of people, and the hours it may ring them. Consent and do-not-call are enforced on every call, not configured away here."
        actions={canWrite ? <NewCampaignButton agents={liveAgents} /> : undefined}
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
          <div className="surface overflow-hidden rounded-xl">
            <Table>
              <thead>
                <Tr>
                  <Th>Campaign</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Pending</Th>
                  <Th className="text-right">Answered</Th>
                  <Th className="text-right">Total</Th>
                  <Th className="text-right">Created</Th>
                </Tr>
              </thead>
              <tbody>
                {items.map((campaign) => (
                  <Tr key={campaign.id}>
                    <Td>
                      <Link href={`/campaigns/${campaign.id}`} className="block">
                        <span className="block text-[13.5px] font-medium">{campaign.name}</span>
                        <span className="block text-[11.5px] text-[var(--ink-3)]">
                          {agentName.get(campaign.agentId) ?? "Unknown agent"}
                        </span>
                      </Link>
                    </Td>
                    <Td>
                      <Tag tone={campaignTone[campaign.status]}>{campaign.status}</Tag>
                    </Td>
                    <Td className="text-right tabular-nums text-[var(--ink-2)]">
                      {campaign.pending}
                    </Td>
                    <Td className="text-right tabular-nums text-[var(--ink-2)]">
                      {campaign.answered}
                    </Td>
                    <Td className="text-right tabular-nums text-[var(--ink-3)]">
                      {campaign.total}
                    </Td>
                    <Td className="text-right text-[12.5px] whitespace-nowrap text-[var(--ink-3)]">
                      {when(campaign.createdAt)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
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
