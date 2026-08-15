"use client";

import { useActionState } from "react";

import { Notice, SubmitButton, Tag, Td, Tr } from "@/components/ui";
import { when } from "@/lib/format";
import { idleForm } from "@/lib/form-state";

import { revokeInvitationAction, type RevokeInvitationState } from "../org.actions";
import type { InvitationSummary } from "../org.service";

const START: RevokeInvitationState = idleForm();

const statusOf = (invitation: InvitationSummary): { readonly label: string; readonly tone: "ok" | "bad" | "warn" | "neutral" } => {
  if (invitation.revokedAt !== null) return { label: "revoked", tone: "bad" };
  if (invitation.acceptedAt !== null) return { label: "accepted", tone: "ok" };
  if (new Date(invitation.expiresAt).getTime() < Date.now()) return { label: "expired", tone: "warn" };
  return { label: "pending", tone: "neutral" };
};

export const InvitationRow = ({
  invitation,
  canWrite,
}: {
  readonly invitation: InvitationSummary;
  readonly canWrite: boolean;
}) => {
  const [state, action, pending] = useActionState(revokeInvitationAction, START);
  const status = statusOf(invitation);
  const revocable = canWrite && status.label === "pending";

  if (state.status === "succeeded") return null;

  return (
    <Tr>
      <Td className="font-mono text-[13px]">{invitation.email}</Td>
      <Td>
        <Tag tone={invitation.role === "owner" ? "accent" : "neutral"}>{invitation.role}</Tag>
      </Td>
      <Td>
        <Tag tone={status.tone}>{status.label}</Tag>
      </Td>
      <Td className="text-[var(--ink-3)]">{when(invitation.expiresAt)}</Td>
      <Td>
        {revocable && (
          <form action={action}>
            <input type="hidden" name="id" value={invitation.id} />
            <SubmitButton pending={pending} idle="Revoke" busy="Revoking…" variant="danger" size="sm" />
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
