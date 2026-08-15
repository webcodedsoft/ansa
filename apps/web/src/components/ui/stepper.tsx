"use client";

import { useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Button } from "./button";

/**
 * A long form as a sequence.
 *
 * The steps stay clickable. A strict wizard is right when you are creating
 * something once and the order matters; it is wrong for settings, where
 * somebody arrives wanting to change the seventh field and should not have to
 * walk past six others. The rail shows position and progress and still lets
 * you jump.
 */
export interface StepDef {
  readonly id: string;
  readonly title: string;
  readonly hint?: string;
  readonly panel: ReactNode;
}

export const Stepper = ({
  steps,
  finishLabel = "Finish",
  onFinish,
}: {
  readonly steps: readonly StepDef[];
  readonly finishLabel?: string;
  readonly onFinish?: () => void;
}) => {
  const [at, setAt] = useState(0);
  const last = steps.length - 1;
  const here = steps[at];

  if (here === undefined) return null;

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[218px_minmax(0,1fr)]">
      <nav aria-label="Steps" className="flex gap-1.5 overflow-x-auto lg:sticky lg:top-6 lg:flex-col lg:gap-0.5">
        {steps.map((step, i) => {
          const done = i < at;
          const current = i === at;
          return (
            <div key={step.id} className="contents lg:block">
              <button
                type="button"
                aria-current={current ? "step" : undefined}
                onClick={() => setAt(i)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl border p-2.5 text-left transition-colors",
                  current
                    ? "glass border-[var(--hairline)]"
                    : "border-transparent hover:bg-[var(--glass)]",
                )}
              >
                <span
                  className={cn(
                    "grid size-[22px] flex-none place-items-center rounded-full border-[1.5px] text-[11px] font-semibold tabular-nums transition-colors",
                    done && "border-transparent bg-[var(--accent)] text-[var(--accent-on)]",
                    current && !done && "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]",
                    !done && !current && "border-[var(--hairline)] bg-[var(--surface-2)] text-[var(--ink-3)]",
                  )}
                >
                  {done ? "✓" : i + 1}
                </span>
                <span className="min-w-0 pt-px">
                  <span className={cn("block text-[13.5px] font-medium", current ? "text-[var(--ink)]" : "text-[var(--ink-2)]")}>
                    {step.title}
                  </span>
                  {step.hint !== undefined && (
                    <span className="mt-px hidden text-[11.5px] text-[var(--ink-3)] lg:block">{step.hint}</span>
                  )}
                </span>
              </button>
              {i < last && (
                <span
                  aria-hidden
                  className={cn("ml-[22px] hidden h-3 w-[1.5px] lg:block", done ? "bg-[var(--accent)]" : "bg-[var(--hairline)]")}
                />
              )}
            </div>
          );
        })}
      </nav>

      <div>
        <div key={here.id} className="ansa-enter">
          {here.panel}
        </div>

        <div className="glass sticky bottom-4 mt-4 flex items-center gap-2.5 rounded-[18px] px-4 py-3.5">
          <span className="text-[12.5px] tabular-nums text-[var(--ink-3)]">
            Step {at + 1} of {steps.length} · {here.title}
          </span>
          <span className="flex-1" />
          <Button disabled={at === 0} onClick={() => setAt((n) => Math.max(0, n - 1))}>
            Back
          </Button>
          <Button
            variant="primary"
            onClick={() => (at === last ? onFinish?.() : setAt((n) => Math.min(last, n + 1)))}
          >
            {at === last ? finishLabel : "Continue"}
          </Button>
        </div>
      </div>
    </div>
  );
};
