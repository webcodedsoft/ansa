import type { Metadata } from "next";

import { PageHeader } from "@/components/ui";
import { readTools } from "@/features/agents/agents.service";
import { ToolRegistry } from "@/features/agents/components/tool-registry";
import { ToolTester } from "@/features/agents/components/tool-tester";

export const metadata: Metadata = { title: "Tools · Ansa" };

/**
 * Always live: the whole point is that a change here is checked with a real test call
 * through `POST /tools/{name}/test`, not with a cached read of what used to be registered.
 */
export const dynamic = "force-dynamic";

const ToolsPage = async () => {
  const document = await readTools();
  const names = [...document.http.map((t) => t.name), ...document.mcp.flatMap((s) => s.tools.map((t) => t.name))];

  return (
    <>
      <PageHeader
        eyebrow="Agents"
        title="Tools"
        meta="What the agent can do besides talk. Organisation-wide: one registry, shared by every agent — today, the one agent this organisation has. Every tool declares a risk tier, and the tier is enforced in code, not here."
      />

      <ToolRegistry document={document} />

      <div className="mt-3.5">
        <ToolTester names={names} />
      </div>
    </>
  );
};

export default ToolsPage;
