"use client";

import { startTransition, useActionState } from "react";

import { Button } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { useFailureToast } from "@/stores/toast.store";
import { retryUnreachedAction, type RetryState } from "../campaigns.actions";

const START: RetryState = idleForm();

/**
 * Give the numbers that did not connect another go.
 *
 * A number that rang out three times was dead forever: past the attempt ceiling, out of every
 * sweep, and the only route back was deleting the row and re-adding the person. This resets
 * `no_answer`, `busy` and `failed` — and nothing else, because an answered call is done and a
 * suppressed one would be refused again.
 *
 * Offered only when there is something to reset, and the count is in the label so the button
 * says what it will do before it does it. The notice afterwards says what it did, because
 * "done" is not an answer to "how many".
 */
export const RetryUnreachedButton = ({
  campaignId,
  unreached,
}: {
  readonly campaignId: string;
  /** How many rows are `no_answer`, `busy` or `failed` right now. */
  readonly unreached: number;
}) => {
  const [state, action, pending] = useActionState(retryUnreachedAction, START);

  useFailureToast(state);
  if (unreached === 0 && state.status !== "succeeded") return null;

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {unreached > 0 && (
        <Button
          size="sm"
          pending={pending}
          onClick={() => {
            const form = new FormData();
            form.set("campaignId", campaignId);
            startTransition(() => action(form));
          }}
        >
          {`Try the ${unreached === 1 ? "one" : unreached} that did not connect again`}
        </Button>
      )}
      {state.status === "succeeded" && state.data !== null && (
        <span className="text-[12px] text-[var(--ink-2)]">
          {state.data.reset === 0
            ? "Nothing to retry."
            : `${state.data.reset} back in the queue, due now.`}
        </span>
      )}
    </div>
  );
};
