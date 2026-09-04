import { notFound } from "next/navigation";

import { findAgent, readAgentFlow } from "@/features/agents/agents.service";
import { FlowBuilder } from "@/features/agents/components/flow-builder";

/**
 * The flow builder, on a page of its own.
 *
 * It was a tab on the agent workspace, and a canvas inside a 1080-pixel column beside nine
 * other tabs is a canvas nobody can see. This page takes the width the shell allows a
 * canvas — see `WorkspaceChrome` — and carries its own Save and Publish, because the
 * workspace's form is not here to ride.
 *
 * Reads the same two things the workspace tab read: the agent, and the graph with its
 * draft. Publishing from here publishes whatever else is staged too, so somebody who edited
 * the greeting on the workspace and then drew here does not lose one by publishing the
 * other.
 */
const FlowBuilderPage = async ({
  params,
}: {
  readonly params: Promise<{ readonly agentId: string }>;
}) => {
  const { agentId } = await params;

  // Null covers both "no such agent" and "another organisation's agent", which under RLS
  // are the same fact. 404 for both; a distinct 403 would confirm the id exists.
  const agent = await findAgent(agentId).catch(() => null);
  if (agent === null) notFound();

  const graph = await readAgentFlow(agentId);

  return (
    <FlowBuilder
      agent={agent}
      flow={graph.draft?.flow ?? graph.flow}
      authoringMode={graph.draft?.authoringMode ?? graph.authoringMode}
      hasUnpublishedGraph={graph.draft?.flow != null}
    />
  );
};

export default FlowBuilderPage;
