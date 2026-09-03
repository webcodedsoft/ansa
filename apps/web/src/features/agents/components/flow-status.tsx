import { Tag } from "@/components/ui";
import { cn } from "@/lib/cn";

import { flowStatusLine, type FlowProblemLike, type FlowStepLike } from "../flow-problems";

/**
 * One line under the canvas: could this graph answer a phone?
 *
 * Always there, not raised by a failed publish. A validation surface that only appears after
 * a rejection teaches an operator to draw for a while and then find out — which puts the
 * discovery of "there is no way out of the branch" twenty minutes after the mistake instead
 * of at the moment it was made. So the line renders on an empty canvas, on a finished one,
 * and on every state between, and the only thing that changes is what it says.
 *
 * It carries the verdict *and* the summary rather than swapping between them. "2 problems"
 * alone says to look but not at how much; "6 steps · 4 questions" alone says nothing about
 * whether it works. Together they are the two facts somebody reading a canvas wants, and the
 * second costs no extra line.
 *
 * `role="status"` so a screen reader hears the verdict change as the graph is edited. Not an
 * alert: the operator is the one editing, and interrupting them mid-drag to announce a
 * problem they are halfway through creating is noise.
 */
export const FlowStatus = ({
  steps,
  problems,
  className,
}: {
  /** The graph's nodes. Counted, not drawn. */
  readonly steps: readonly FlowStepLike[];
  readonly problems: readonly FlowProblemLike[];
  readonly className?: string;
}) => {
  const { tone, label, summary } = flowStatusLine(steps, problems);
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-2.5 border-t border-[var(--hairline)] px-4 py-2.5 text-[12.5px]",
        className,
      )}
    >
      <Tag tone={tone}>{label}</Tag>
      <span className="tabular-nums text-[var(--ink-3)]">{summary}</span>
    </div>
  );
};
