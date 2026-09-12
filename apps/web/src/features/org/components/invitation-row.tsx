"use client";

import { useActionState } from "react";

import { Notice, SubmitButton, Tag, Td, Tr } from "@/components/ui";
import { dayLabel } from "@/lib/format";
import { idleForm } from "@/lib/form-state";

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
          <form action={action}>
            <input type="hidden" name="id" value={invitation.id} />
            <SubmitButton pending={pending} idle="Revoke" variant="danger" size="sm" />
            {state.status === "failed" && (
              <Notice tone="error" className="mt-2">
                {state.message}
              </Notice>
            )}
          </form>
        )}
      </Td>
    </Tr>
  );
};
