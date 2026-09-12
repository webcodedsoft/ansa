import type { Metadata } from "next";

import { liveAgents } from "@/features/agents/agents.service";
import { NumbersBoard } from "@/features/connect/components/numbers-board";
import { claimWebhook, listNumbers, numberCountries, numberProvisioning } from "@/features/connect/connect.service";
import { organisation } from "@/features/org/org.service";

export const metadata: Metadata = { title: "Numbers · Ansa" };

/**
 * Always live: whether a carrier webhook matches is exactly the kind of thing that changes
 * out from under this screen without this app knowing, and a cached "matches" is worse than
 * no answer at all.
 */
export const dynamic = "force-dynamic";

/**
 * Design C: each number is a card, with an add card at the end. The two ways to add — bring
 * your own, or take one from the plan — open under the grid, so the page never leaves what
 * it already holds. Everything the board needs is read here, in parallel, and handed down.
 */
const NumbersPage = async () => {
  const [{ items }, provisioning, agents, org] = await Promise.all([
    listNumbers(),
    numberProvisioning(),
    liveAgents(),
    organisation(),
  ]);

  /* Settled, and not part of the group above. `GET /numbers/webhook` needs `config:write`
     while this page needs only `config:read`, so a member opening it gets a 403 for the
     webhook and nothing else — awaiting it outright meant one refused request took the whole
     numbers list down for exactly the people who cannot act on it anyway. Null hides the
     import panel, which is the right thing to show somebody who could not use it. */
  const webhook = await claimWebhook().catch(() => null);

  /* The catalogue, when the deployment can offer numbers at all. A refusal from the carrier —
     wrong or inactive credentials — is shown in the carrier's words rather than hiding the
     panel, because "not offered" and "the carrier account is not active" are different things
     to fix. */
  const catalogue = provisioning.claim.available
    ? await numberCountries().then(
        (countries) => ({ countries, refusal: null as string | null }),
        (error: unknown) => ({
          countries: null,
          refusal: error instanceof Error ? error.message : "the carrier did not answer",
        }),
      )
    : null;

  return (
    <NumbersBoard
      numbers={items}
      agents={agents.map((agent) => ({ agentId: agent.agentId, name: agent.name, dialledNumber: agent.dialledNumber }))}
      webhook={webhook}
      provisioning={provisioning}
      catalogue={catalogue}
      organisationName={org.name}
    />
  );
};

export default NumbersPage;
