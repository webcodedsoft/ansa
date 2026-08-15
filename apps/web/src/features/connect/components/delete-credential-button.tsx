"use client";

import { useActionState } from "react";

import { Notice, SubmitButton } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import { deleteCredential, type DeleteCredentialState } from "../connect.actions";

const START: DeleteCredentialState = idleForm();

/**
 * Remove a credential, with the one confirmation this screen needs — there is no undo, and
 * a credential in use is still deletable here, just refused by the API with a 409 that names
 * what still holds it.
 */
export const DeleteCredentialButton = ({
  credentialRef,
  inUse,
}: {
  readonly credentialRef: string;
  readonly inUse: boolean;
}) => {
  const [state, action, pending] = useActionState(deleteCredential, START);

  useFormToast(state, () => `Deleted ${credentialRef}.`);

  return (
    <form
      action={action}
      onSubmit={(event) => {
        const message = inUse
          ? `${credentialRef} is currently in use by a tool or an event subscription. Delete it anyway?`
          : `Delete ${credentialRef}? This cannot be undone.`;
        if (!window.confirm(message)) event.preventDefault();
      }}
    >
      <input type="hidden" name="ref" value={credentialRef} />
      <div className="flex justify-end">
        <SubmitButton pending={pending} variant="danger" size="sm" idle="Delete" busy="Deleting…" />
      </div>
      {state.status === "failed" && (
        <Notice tone="error" className="mt-1.5 max-w-64 text-xs">
          {state.message}
        </Notice>
      )}
    </form>
  );
};
