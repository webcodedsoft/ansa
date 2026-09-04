import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { validateFlow } from "@ansa/shared/flow-validate";

import { Notice, Panel, Tag, buttonClass } from "@/components/ui";

import type { Flow } from "../flow.schema";
import { flowStatusLine } from "../flow-problems";

/**
 * What the Flow tab shows now that the canvas has a page of its own.
 *
 * Enough to know whether to go there: whether the flow conducts calls, whether what is
 * drawn is publishable, and the one sentence the status line puts under the canvas. The
 * drawing itself is one click away, at the width it needs.
 */
export const FlowSummary = ({
  agentId,
  flow,
  authoringMode,
  hasUnpublishedGraph,
}: {
  readonly agentId: string;
  /** The staged graph, parsed, or null when it could not be read. */
  readonly flow: Flow | null;
  readonly authoringMode: "form" | "flow";
  readonly hasUnpublishedGraph: boolean;
}) => {
  const problems = flow === null ? [] : validateFlow(flow);
  const status = flow === null ? null : flowStatusLine(flow.nodes, problems);

  return (
    <div className="flex flex-col gap-3.5">
      <div>
        <h2 className="text-[17px] font-semibold tracking-[-0.018em]">The conversation, drawn</h2>
        <p className="mt-1 max-w-[62ch] text-[13.5px] text-[var(--ink-3)]">
          Steps wired together on a canvas, so the call can branch on what the caller says.
          The canvas has a page of its own, at the width a drawing needs.
        </p>
      </div>

      {flow === null && (
        <Notice tone="error">
          The stored flow could not be read by this console. Open the builder to see what it
          holds before saving anything over it.
        </Notice>
      )}

      <Panel>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1.5">
            <span className="flex flex-wrap items-center gap-2">
              <Tag tone={authoringMode === "flow" ? "accent" : "neutral"}>
                {authoringMode === "flow" ? "conducts the call" : "drawn, but the agent runs as a form"}
              </Tag>
              {hasUnpublishedGraph && <Tag tone="warn">unpublished changes</Tag>}
            </span>
            {status !== null && (
              <span className="text-[13px] text-[var(--ink-2)]">
                {status.label} · {status.summary}
              </span>
            )}
          </div>
          <Link href={`/agents/${agentId}/flow`} className={buttonClass("primary", "md")}>
            Open the flow builder
            <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </Panel>
    </div>
  );
};
