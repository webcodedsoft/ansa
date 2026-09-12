"use client";

import { startTransition, useActionState, useState } from "react";

import { Button, ConfirmDialog, Tag, Td, Tr } from "@/components/ui";
import { dayLabel } from "@/lib/format";
import { idleForm } from "@/lib/form-state";

import { useFailureToast } from "@/stores/toast.store";
import { revokeInvitationAction, type RevokeInvitationState } from "../org.actions";
import { STATUS_TONE, expiry, initials, statusOf } from "../invitations.display";
import type { InvitationSummary } from "../org.service";

const START: RevokeInvitationState = idleForm();

export const InvitationRow = ({
  invitation,
  canWrite,
}: {
  readonly invitation: InvitationSummary;
  readonly canWrite: boolean;
}) => {
  const [state, action, pending] = useActionState(revokeInvitationAction, START);
  useFailureToast(state);
  const [asking, setAsking] = useState(false);
  const status = statusOf(invitation);
  const revocable = canWrite && status === "pending";

  if (state.status === "succeeded") return null;

  return (
    <Tr>
      <Td>
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="grid size-[30px] flex-none place-items-center rounded-full border border-dashed border-[var(--hairline)] font-mono text-[11px] font-semibold text-[var(--ink-3)]"
          >
            {initials(null, invitation.email)}
          </span>
          <span className="truncate font-mono text-[13px]">{invitation.email}</span>
        </div>
      </Td>
      <Td>
        <Tag tone={invitation.role === "owner" ? "accent" : "neutral"}>{invitation.role}</Tag>
      </Td>
      <Td>
        <Tag tone={STATUS_TONE[status]}>{status}</Tag>
      </Td>
      <Td className="text-[12.5px] whitespace-nowrap text-[var(--ink-3)]">
        {status === "pending" || status === "expired" ? expiry(invitation.expiresAt) : dayLabel(invitation.createdAt)}
      </Td>
      <Td>
        {revocable && (
          <>
            <Button variant="ghost" size="sm" onClick={() => setAsking(true)} pending={pending}>
              Revoke
            </Button>
            <ConfirmDialog
              open={asking}
              onClose={() => setAsking(false)}
              onConfirm={() => {
                setAsking(false);
                const form = new FormData();
                form.set("id", invitation.id);
                startTransition(() => action(form));
              }}
              title={`Revoke the invitation to ${invitation.email}?`}
              confirmLabel="Revoke it"
              pending={pending}
            >
              The link they were sent stops working. To have them join later, send a new
              invitation.
            </ConfirmDialog>
          </>
        )}
      </Td>
    </Tr>
  );
};
