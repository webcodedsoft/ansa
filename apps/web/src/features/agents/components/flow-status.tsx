import { Button, Tag } from "@/components/ui";
import { cn } from "@/lib/cn";

import { flowStatusLine, orderProblems, plural, stepLabel, type FlowProblemLike, type FlowStepLike } from "../flow-problems";

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
 * When something is wrong, the line becomes the dock: the verdict, the *first* problem's
 * sentence with the step it names, and a button that goes there. One problem rather than the
 * list, because the list is below for whoever wants it and one sentence is what a person acts
 * on. The worst problem comes first — `orderProblems` puts blocking ahead of warnings — so the
 * sentence in the dock is always the one standing between this flow and a phone.
 *
 * `role="status"` so a screen reader hears the verdict change as the graph is edited. Not an
 * alert: the operator is the one editing, and interrupting them mid-drag to announce a
 * problem they are halfway through creating is noise.
 */
export const FlowStatus = ({
  steps,
  problems,
  onFocusNode,
  className,
}: {
  /** The graph's nodes. Counted, not drawn. */
  readonly steps: readonly FlowStepLike[];
  readonly problems: readonly FlowProblemLike[];
  /** Select the step the first problem names and bring it into view. */
  readonly onFocusNode?: (nodeId: string) => void;
  readonly className?: string;
}) => {
  const { tone, label, summary } = flowStatusLine(steps, problems);
  const first = orderProblems(problems, steps)[0];
  const blocking = problems.filter((problem) => problem.blocking).length;
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-2.5 border-t border-[var(--hairline)] px-4 py-2.5 text-[12.5px]",
        className,
      )}
    >
      <Tag tone={tone}>{blocking > 0 ? `${blocking === 1 ? "1 stops" : `${blocking} stop`} publishing` : label}</Tag>
      {first === undefined ? (
        <span className="tabular-nums text-[var(--ink-3)]">{summary}</span>
      ) : (
        <>
          <span className={cn("min-w-0 flex-1", first.problem.blocking ? "text-[var(--bad)]" : "text-[var(--warn)]")}>
            {first.step === null ? "" : `“${stepLabel(first.step)}” — `}
            {first.problem.message}
            {problems.length > 1 && <span className="text-[var(--ink-3)]"> · and {plural(problems.length - 1, "more")}</span>}
          </span>
          {first.step !== null && onFocusNode !== undefined && (
            <Button size="sm" variant="secondary" onClick={() => onFocusNode(first.step?.id ?? "")}>
              Show me
            </Button>
          )}
        </>
      )}
    </div>
  );
};
