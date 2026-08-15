import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/ui";
import { CreateAgent } from "@/features/agents/components/create-agent";

export const metadata: Metadata = { title: "New agent · Ansa" };

/**
 * Creating an agent.
 *
 * Reads nothing. The old wizard loaded the live configuration and the tool registry because
 * it was really an edit form for the organisation's single configuration — it had to show
 * you what was already there. This creates a new row from a template, so there is nothing
 * to load and no reason to make somebody wait for two requests before they can pick a card.
 *
 * Also the first-run screen: migration 0025 stopped creating an agent automatically, so a
 * new organisation arrives here from the empty state on `/agents` with nothing at all.
 */
const NewAgentPage = () => (
  <>
    <PageHeader
      eyebrow="Agents"
      title="New agent"
      meta="Pick a starting point and give it a name. Everything it says is editable afterwards — the template is there so the first draft is a working conversation rather than a blank page."
      actions={
        <Link href="/agents" className="text-sm text-[var(--ink-3)] hover:underline">
          Cancel
        </Link>
      }
    />

    <CreateAgent />
  </>
);

export default NewAgentPage;
