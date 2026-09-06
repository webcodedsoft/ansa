"use client";

import { useActionState, useState } from "react";

import { Button, ChoiceChips, Notice, Stack } from "@/components/ui";
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

/** The choices offered. `ChoiceChips` shows a saved value outside these as its own chip. */
const AT_ONCE: readonly number[] = [1, 2, 3, 5, 10];
const AN_HOUR: readonly number[] = [10, 20, 30, 60, 120, 300];

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

        <ChoiceChips
          label="At once"
          hint="Calls in progress at the same time."
          name="maxConcurrentCalls"
          presets={AT_ONCE}
          none="No cap"
          value={atOnce}
          disabled={disabled}
          onChange={setAtOnce}
        />
        <ChoiceChips
          label="An hour"
          hint="Placed in any rolling hour."
          name="maxCallsPerHour"
          presets={AN_HOUR}
          none="No cap"
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
