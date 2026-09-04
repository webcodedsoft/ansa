import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/ui";
import { ChooseBuilder } from "@/features/agents/components/choose-builder";

export const metadata: Metadata = { title: "New agent · Ansa" };

/**
 * The one decision before an agent exists: which builder.
 *
 * Two boxes and nothing else. A form builder and a flow builder are two complete ways of
 * building an agent, each standing on its own, and this is the door between them. Naming,
 * templates and everything after belong to whichever builder is chosen — asking for a name
 * here would be asking for it before the person knows what kind of thing they are naming.
 */
const NewAgentPage = () => (
  <>
    <PageHeader
      eyebrow="Agents"
      title="New agent"
      meta="Two ways to build one. Pick the shape of the conversation first; everything else follows from it."
      actions={
        <Link href="/agents" className="text-sm text-[var(--ink-3)] hover:underline">
          Cancel
        </Link>
      }
    />

    <ChooseBuilder />
  </>
);

export default NewAgentPage;
