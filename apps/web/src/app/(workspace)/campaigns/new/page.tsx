import type { Metadata } from "next";

import { PageHeader } from "@/components/ui";
import { listAgents } from "@/features/agents/agents.service";
import { NewCampaignForm } from "@/features/campaigns/components/new-campaign-form";

export const metadata: Metadata = { title: "New campaign · Ansa" };
export const dynamic = "force-dynamic";

/**
 * Starting a campaign.
 *
 * Its own page rather than the dialog it used to be. The calling window is the decision
 * operators get wrong, and it needs room: two hour pickers, seven days, and a sentence
 * saying what the combination means. A modal had space for the controls and none for the
 * answer.
 *
 * Only live agents are offered. A retired agent still exists so old calls can name it, and
 * offering one here would let somebody build a campaign that cannot dial.
 */
const NewCampaignPage = async () => {
  const agents = await listAgents();
  const live = agents.items
    .filter((agent) => agent.deletedAt === null)
    .map((agent) => ({ agentId: agent.agentId, name: agent.name }));

  return (
    <>
      <PageHeader
        eyebrow="Outbound"
        title="New campaign"
        meta="An agent, and the hours it may ring. It begins as a draft with nobody on it — nothing is dialled until you add people and start it."
      />
      <NewCampaignForm agents={live} />
    </>
  );
};

export default NewCampaignPage;
