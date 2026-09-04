import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/ui";
import { CreateAgent } from "@/features/agents/components/create-agent";

export const metadata: Metadata = { title: "Form Builder · Ansa" };

/**
 * The form builder's front door: a name and a starting point, then the agent's tabs.
 *
 * Reads nothing — a new row from a template, so there is nothing to load before somebody
 * can pick a card. Also the first-run screen for an organisation that has no agent yet.
 */
const NewFormAgentPage = () => (
  <>
    <PageHeader
      eyebrow="Form Builder"
      title="New form agent"
      meta="The agent asks its questions in one order, top to bottom, and every caller is asked the same ones. Pick a starting point and give it a name; every word is editable afterwards."
      actions={
        <Link href="/agents/new" className="text-sm text-[var(--ink-3)] hover:underline">
          Back
        </Link>
      }
    />

    <CreateAgent mode="form" />
  </>
);

export default NewFormAgentPage;
