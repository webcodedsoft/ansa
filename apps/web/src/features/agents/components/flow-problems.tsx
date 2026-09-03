import { CircleAlert, TriangleAlert, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";

import {
  WHOLE_FLOW_LABEL,
  orderProblems,
  stepLabel,
  type FlowProblemLike,
  type FlowStepLike,
} from "../flow-problems";

/**
 * The strip under the canvas listing what is wrong.
 *
 * Every row is a step and a consequence, in that order, because the two halves answer
 * different questions: which card do I go to, and what happens to the caller if I do not.
 * The ordering, the naming and the fallbacks all live in `../flow-problems.ts` — this file
 * is only the shape they take on screen.
 *
 * No `"use client"`, for the reason at the top of `components/ui/button.tsx`: nothing here
 * holds state or reaches for the DOM, so the file renders wherever it is imported. Taking
 * `onFocusNode` means the *caller* has to be a Client Component, which the canvas already
 * is — a constraint React enforces on its own and that a directive here would not add.
 */

/**
 * The two groups, and everything that separates them.
 *
 * Colour is the least of it. A blocking row is a circle, a warning is a triangle, the headings
 * say different words, and blocking always sits above — so the distinction survives a
 * monochrome screen and a reader who cannot tell the red from the amber.
 */
const GROUPS = [
  {
    blocking: true,
    heading: "Must fix",
    Icon: CircleAlert,
    rule: "border-l-[var(--bad)]",
    ink: "text-[var(--bad)]",
  },
  {
    blocking: false,
    heading: "Worth checking",
    Icon: TriangleAlert,
    rule: "border-l-[var(--warn)]",
    ink: "text-[var(--warn)]",
  },
] as const;

/** The small-caps band over a run of rows, borrowed from the call table's `GroupRow`. */
const Band = ({ label, count }: { readonly label: string; readonly count: number }) => (
  <div className="flex items-center gap-3 border-y border-[var(--hairline)] bg-[var(--surface-2)] px-4 py-2 first:border-t-0">
    <span className="flex-none font-mono text-[10px] font-semibold tracking-[0.11em] text-[var(--ink-2)] uppercase">
      {label}
    </span>
    <span aria-hidden className="h-px flex-1 bg-[var(--hairline)]" />
    <span className="flex-none text-xs tabular-nums text-[var(--ink-3)]">{count}</span>
  </div>
);

const ROW = "flex w-full gap-2.5 border-l-2 px-4 py-2.5 text-left text-[13px] leading-relaxed";

const RowBody = ({
  Icon,
  ink,
  name,
  message,
}: {
  readonly Icon: LucideIcon;
  readonly ink: string;
  readonly name: string;
  readonly message: string;
}) => (
  // Spans rather than divs: half of these rows are the content of a `<button>`, and a div in
  // there is invalid markup that browsers repair in ways that break the layout.
  <>
    <Icon aria-hidden className={cn("mt-[3px] size-3.5 shrink-0", ink)} />
    <span className="min-w-0">
      <span className="block font-medium text-[var(--ink)]">{name}</span>
      <span className="block text-[var(--ink-2)]">{message}</span>
    </span>
  </>
);

/**
 * Renders nothing when nothing is wrong.
 *
 * `FlowStatus` is the line that is always there; an empty panel saying "no problems" would
 * push the canvas up a notch and carry no information back for the space.
 */
export const FlowProblems = ({
  problems,
  steps,
  onFocusNode,
  className,
}: {
  readonly problems: readonly FlowProblemLike[];
  /** The graph's nodes, in canvas order. Used to name each step and to sort the list. */
  readonly steps: readonly FlowStepLike[];
  /** Select the step and bring it into view. Rows with no step of their own are not clickable. */
  readonly onFocusNode: (nodeId: string) => void;
  readonly className?: string;
}) => {
  const entries = orderProblems(problems, steps);
  if (entries.length === 0) return null;

  return (
    <section aria-label="Problems with this flow" className={cn("border-t border-[var(--hairline)]", className)}>
      {GROUPS.map(({ blocking, heading, Icon, rule, ink }) => {
        const group = entries.filter((entry) => entry.problem.blocking === blocking);
        if (group.length === 0) return null;
        return (
          <div key={heading}>
            <Band label={heading} count={group.length} />
            <ul>
              {group.map(({ problem, step }, index) => (
                <li key={`${problem.code}:${problem.nodeId ?? "flow"}:${index}`}>
                  {/* A plain row, not a dead button: a control that selects nothing teaches
                      the operator that none of these rows are worth clicking. */}
                  {step === null ? (
                    <div className={cn(ROW, rule)}>
                      <RowBody Icon={Icon} ink={ink} name={WHOLE_FLOW_LABEL} message={problem.message} />
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onFocusNode(step.id)}
                      className={cn(ROW, rule, "cursor-pointer transition-colors hover:bg-[var(--surface-2)]")}
                    >
                      <RowBody Icon={Icon} ink={ink} name={stepLabel(step)} message={problem.message} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
};
