import { redirect } from "next/navigation";

/**
 * The builder lived here for an afternoon. A flow agent's workspace is the builder now —
 * the canvas is the page and the rest of the agent is a drawer beside it — so the address
 * still resolves, to the agent.
 */
const FlowBuilderPage = async ({
  params,
}: {
  readonly params: Promise<{ readonly agentId: string }>;
}) => {
  const { agentId } = await params;
  redirect(`/agents/${agentId}`);
};

export default FlowBuilderPage;
