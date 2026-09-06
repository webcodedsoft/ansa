"use client";

import { useActionState, useState } from "react";

import { Button, Notice, Stack } from "@/components/ui";
import { cn } from "@/lib/cn";
import { idleForm } from "@/lib/form-state";

import { setPaceAction, type PaceState } from "../campaigns.actions";

const START: PaceState = idleForm();

/** The pace as one sentence, so the number is read back as what it means. */
export const paceSummary = (concurrent: number | null, perHour: number | null): string => {
  if (concurrent === null && perHour === null) return "As fast as the dialler goes.";
  const parts: string[] = [];
  if (concurrent !== null) parts.push(concurrent === 1 ? "one call at a time" : `${concurrent} calls at once`);
  if (perHour !== null) parts.push(`at most ${perHour} an hour`);
  const joined = parts.join(", ");
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
};

/**
 * The choices offered, as chips. A saved value that is not one of these is shown as its own
 * chip, so the page tells the truth about a cap the API accepted from elsewhere.
 */
const AT_ONCE: readonly number[] = [1, 2, 3, 5, 10];
const AN_HOUR: readonly number[] = [10, 20, 30, 60, 120, 300];

const Choice = ({
  legend,
  hint,
  name,
  presets,
  value,
  disabled,
  onChange,
}: {
  readonly legend: string;
  readonly hint: string;
  readonly name: string;
  readonly presets: readonly number[];
  readonly value: number | null;
  readonly disabled: boolean;
  readonly onChange: (next: number | null) => void;
}) => {
  const options: readonly (number | null)[] = [
    null,
    ...(value !== null && !presets.includes(value) ? [...presets, value].sort((a, b) => a - b) : presets),
  ];
  return (
    <fieldset>
      <legend className="mb-1.5 text-[11px] font-semibold tracking-[0.11em] text-[var(--ink-3)] uppercase">
        {legend}
      </legend>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={legend}>
        {options.map((option) => {
          const on = option === value;
          return (
            <button
              key={option ?? "none"}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => onChange(option)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-[12.5px] tabular-nums transition-colors disabled:opacity-60",
                on
                  ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-on)]"
                  : "border-[var(--hairline)] text-[var(--ink-2)] hover:border-[var(--ink-3)]",
              )}
            >
              {option === null ? "No cap" : option}
            </button>
          );
        })}
      </div>
      {/* The chips are the control; this carries the choice under the name the action reads. */}
      <input type="hidden" name={name} value={value ?? ""} />
      <p className="mt-1.5 text-[11.5px] text-[var(--ink-3)]">{hint}</p>
    </fieldset>
  );
};

/**
 * How fast a campaign dials.
 *
 * Two choices, both enforced where the dialler picks its batch rather than anywhere it could
 * skip. "At once" is for the people who take the transfers: an office of two cannot have
 * five callers on hold. "An hour" is for the carrier and the bill: a number that bursts
 * eighteen hundred calls an hour is a robodialler and gets treated as one.
 *
 * Chips rather than number boxes, and "No cap" is a chip like the others. A blank box that
 * silently meant "unlimited" was the kind of default somebody discovers from a phone bill;
 * a chip that says so is a choice they made. The sentence above the chips reads the choice
 * back as what it means. Settable while running — that is the moment anybody reaches for it.
 */
export const CampaignPace = ({
  campaignId,
  maxConcurrentCalls,
  maxCallsPerHour,
  canWrite,
}: {
  readonly campaignId: string;
  readonly maxConcurrentCalls: number | null;
  readonly maxCallsPerHour: number | null;
  readonly canWrite: boolean;
}) => {
  const [state, action, pending] = useActionState(setPaceAction, START);
  const [atOnce, setAtOnce] = useState<number | null>(maxConcurrentCalls);
  const [anHour, setAnHour] = useState<number | null>(maxCallsPerHour);
  const disabled = !canWrite || pending;
  const saved =
    state.status === "succeeded" && state.data !== null
      ? state.data
      : { maxConcurrentCalls, maxCallsPerHour };
  const dirty = atOnce !== saved.maxConcurrentCalls || anHour !== saved.maxCallsPerHour;

  return (
    <form action={action}>
      <input type="hidden" name="campaignId" value={campaignId} />
      <Stack gap="sm">
        <p className="text-[13px] text-[var(--ink)]">{paceSummary(atOnce, anHour)}</p>

        {(state.status === "failed" || state.status === "invalid") && (
          <Notice tone="error">{state.message}</Notice>
        )}
        {state.status === "succeeded" && !dirty && (
          <Notice tone="ok">Saved. It takes effect on the next sweep.</Notice>
        )}

        <Choice
          legend="At once"
          hint="Calls in progress at the same time."
          name="maxConcurrentCalls"
          presets={AT_ONCE}
          value={atOnce}
          disabled={disabled}
          onChange={setAtOnce}
        />
        <Choice
          legend="An hour"
          hint="Placed in any rolling hour."
          name="maxCallsPerHour"
          presets={AN_HOUR}
          value={anHour}
          disabled={disabled}
          onChange={setAnHour}
        />

        {canWrite && (
          <div>
            <Button type="submit" size="sm" variant="primary" disabled={disabled || !dirty}>
              {pending ? "Saving…" : "Save pace"}
            </Button>
          </div>
        )}

        <p className="border-t border-[var(--hairline)] pt-3 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
          The retry policy on the brief decides how often one person is rung; this decides how
          many people at a time.
        </p>
      </Stack>
    </form>
  );
};
