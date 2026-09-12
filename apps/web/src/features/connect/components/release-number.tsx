"use client";

import { startTransition, useActionState, useState } from "react";

import { Button, ConfirmDialog } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { useFailureToast } from "@/stores/toast.store";
import { releaseNumberAction, type ReleaseNumberState } from "../connect.actions";

const START: ReleaseNumberState = idleForm();

/** Release a number bought here. It goes back to the carrier and stops counting against the plan; there is no undo. */
export const ReleaseNumber = ({ number, agentName }: { readonly number: string; readonly agentName: string | null }) => {
  const [state, action, pending] = useActionState(releaseNumberAction, START);
  useFailureToast(state);
  const [confirming, setConfirming] = useState(false);
  if (state.status === "succeeded") return <span className="text-[12.5px] text-[var(--ink-3)]">released</span>;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} pending={pending}>
        Release
      </Button>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          const form = new FormData();
          form.set("number", number);
          startTransition(() => action(form));
        }}
        title={`Release ${number}?`}
        confirmLabel="Release it"
        pending={pending}
      >
        The number goes back to the carrier and stops counting against your plan. Callers who
        ring it after this reach nobody, and the carrier may sell it to somebody else.
        {agentName !== null && ` ${agentName} stops answering it and is left with no number.`}
      </ConfirmDialog>
    </>
  );
};
