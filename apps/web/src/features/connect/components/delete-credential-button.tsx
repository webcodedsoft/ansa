"use client";

import { startTransition, useActionState, useState } from "react";

import { Button, ConfirmDialog } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast, useFailureToast } from "@/stores/toast.store";

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
  useFailureToast(state);
  const [asking, setAsking] = useState(false);

  useFormToast(state, () => `Deleted ${credentialRef}.`);

  return (
    <form action={action}>
      <input type="hidden" name="ref" value={credentialRef} />
      <div className="flex justify-end">
        <Button variant="danger" size="sm" onClick={() => setAsking(true)} pending={pending}>
          Delete
        </Button>
      </div>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          const form = new FormData();
          form.set("ref", credentialRef);
          startTransition(() => action(form));
        }}
        title={`Delete ${credentialRef}?`}
        confirmLabel="Delete the credential"
        pending={pending}
      >
        {inUse
          ? "A tool or an event subscription uses this credential now. Deleting it means the next call that reaches that tool fails until a replacement is set."
          : "This cannot be undone. A tool added later that needs it will have to be given a new one."}
      </ConfirmDialog>
    </form>
  );
};
