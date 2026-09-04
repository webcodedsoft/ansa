import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/ui";
import { CreateAgent } from "@/features/agents/components/create-agent";

export const metadata: Metadata = { title: "Flow Builder · Ansa" };

/**
 * The flow builder's front door: a name and a starting point, then the canvas.
 *
 * The template's questions are drawn as the flow's first steps, so Create lands on a canvas
 * with a conversation already on it rather than an empty one beside a list to retype.
 */
const NewFlowAgentPage = () => (
  <>
    <PageHeader
      eyebrow="Flow Builder"
      title="New flow agent"
      meta="Steps wired together on a canvas, so the call can branch on what the caller says and skip what does not apply. Pick a starting point and give it a name; you take it from there on the canvas."
      actions={
        <Link href="/agents/new" className="text-sm text-[var(--ink-3)] hover:underline">
          Back
        </Link>
      }
    />

    <CreateAgent mode="flow" />
  </>
);

export default NewFlowAgentPage;
