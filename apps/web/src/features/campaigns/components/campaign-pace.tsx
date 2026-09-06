"use client";

import { CAMPAIGN_LIMITS } from "@ansa/shared/campaign";
import { useActionState } from "react";

import { Notice, NumberField, Stack, SubmitButton } from "@/components/ui";
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
 * How fast a campaign dials.
 *
 * Two numbers, both optional, both enforced where the dialler picks its batch rather than
 * anywhere it could skip. "At once" is for the people who take the transfers: an office of
 * two cannot have five callers on hold. "An hour" is for the carrier and the bill: a number
 * that bursts eighteen hundred calls an hour is a robodialler and gets treated as one.
 *
 * An empty box is no cap, and the hint says so, because a blank that silently means
 * "unlimited" is the kind of default somebody discovers from a phone bill. Settable while
 * running — that is the moment anybody reaches for it.
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
  const saved = state.status === "succeeded" && state.data !== null ? state.data : null;
  const shown = saved ?? { maxConcurrentCalls, maxCallsPerHour };
  const disabled = !canWrite || pending;

  return (
    <form action={action}>
      <input type="hidden" name="campaignId" value={campaignId} />
      <Stack gap="sm">
        <p className="text-[13px] text-[var(--ink)]">
          {paceSummary(shown.maxConcurrentCalls, shown.maxCallsPerHour)}
        </p>

        {(state.status === "failed" || state.status === "invalid") && (
          <Notice tone="error">{state.message}</Notice>
        )}
        {saved !== null && <Notice tone="ok">Saved. It takes effect on the next sweep.</Notice>}

        <div className="flex flex-wrap gap-3">
          <NumberField
            label="At once"
            name="maxConcurrentCalls"
            defaultValue={maxConcurrentCalls ?? ""}
            min={CAMPAIGN_LIMITS.concurrentCalls.min}
            max={CAMPAIGN_LIMITS.concurrentCalls.max}
            placeholder="No cap"
            disabled={disabled}
            error={state.fieldErrors["maxConcurrentCalls"]}
            hint="Calls in progress at the same time."
            className="w-40"
          />
          <NumberField
            label="An hour"
            name="maxCallsPerHour"
            defaultValue={maxCallsPerHour ?? ""}
            min={CAMPAIGN_LIMITS.callsPerHour.min}
            max={CAMPAIGN_LIMITS.callsPerHour.max}
            placeholder="No cap"
            disabled={disabled}
            error={state.fieldErrors["maxCallsPerHour"]}
            hint="Placed in any rolling hour."
            className="w-40"
          />
        </div>

        {canWrite && (
          <div>
            <SubmitButton pending={pending} idle="Save pace" busy="Saving…" size="sm" />
          </div>
        )}

        <p className="border-t border-[var(--hairline)] pt-3 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
          Leave a box empty for no cap. The retry policy on the brief decides how often one
          person is rung; this decides how many people at a time.
        </p>
      </Stack>
    </form>
  );
};
