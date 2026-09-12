"use client";

import { ShieldOff } from "lucide-react";
import { startTransition, useActionState, useEffect, useState } from "react";

import { Button, ConfirmDialog, Notice, Row, SelectField, SubmitButton, Tag, Td, Tr } from "@/components/ui";
import { cn } from "@/lib/cn";
import { dayLabel } from "@/lib/format";
import { idleForm } from "@/lib/form-state";

import {
  changeRole,
  removeMemberAction,
  restoreAccessAction,
  revokeAccessAction,
  type AccessState,
  type ChangeRoleState,
  type RemoveMemberState,
} from "../org.actions";
import { initials } from "../invitations.display";
import type { MemberSummary } from "../org.service";
import type { Role } from "../org.schema";

const ROLE_START: ChangeRoleState = idleForm();
const REMOVE_START: RemoveMemberState = idleForm();
const ACCESS_START: AccessState = idleForm();

const ROLE_TONE: Record<Role, "accent" | "neutral"> = {
  owner: "accent",
  admin: "neutral",
  member: "neutral",
};

/**
 * One row of the members table.
 *
 * `locked` covers both rules the UI is asked to enforce: this is the caller's own row, or
 * this is the organisation's only owner. Either way the role select and the remove button
 * stay disabled with a reason attached, rather than letting the click go through and
 * reporting the database's refusal after the fact — the outcome is certain before the
 * request, so there is nothing to be gained by waiting for the 409 to say so.
 *
 * Two ways out, and they mean different things. Revoke access keeps the membership — role,
 * joined date, name on the audit trail — and ends every session; it is for somebody who
 * may be back, and Restore undoes it in one click. Remove is for somebody who has left.
 * `suspended` follows the last successful action rather than the prop alone, so the row
 * flips without waiting for the page to revalidate.
 */
export const MemberRow = ({
  member,
  isSelf,
  isLastOwner,
  canWrite,
}: {
  readonly member: MemberSummary;
  readonly isSelf: boolean;
  readonly isLastOwner: boolean;
  readonly canWrite: boolean;
}) => {
  const [roleState, roleAction, rolePending] = useActionState(changeRole, ROLE_START);
  const [removeState, removeAction, removePending] = useActionState(removeMemberAction, REMOVE_START);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [revokeState, revokeAction, revokePending] = useActionState(revokeAccessAction, ACCESS_START);
  const [restoreState, restoreAction, restorePending] = useActionState(restoreAccessAction, ACCESS_START);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  const roleLocked = isSelf || isLastOwner;
  const removed = removeState.status === "succeeded";
  /* The most recent outcome wins, whichever action produced it. Both states keep their
     last result, so reading "the succeeded one" would report a revoke that has since been
     undone; each result overwrites the row's own answer as it arrives instead. */
  const [suspended, setSuspended] = useState(member.suspendedAt !== null);
  useEffect(() => {
    if (revokeState.status === "succeeded") setSuspended(true);
  }, [revokeState]);
  useEffect(() => {
    if (restoreState.status === "succeeded") setSuspended(false);
  }, [restoreState]);
  const accessError =
    revokeState.status === "failed"
      ? revokeState.message
      : restoreState.status === "failed"
        ? restoreState.message
        : null;
  const withUser = (action: (form: FormData) => void) => {
    const form = new FormData();
    form.set("userId", member.userId);
    startTransition(() => action(form));
  };

  if (removed) return null;

  return (
    <Tr>
      <Td>
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="grid size-[30px] flex-none place-items-center rounded-full border border-[var(--hairline)] bg-[var(--surface-2)] font-mono text-[11px] font-semibold text-[var(--ink-2)]"
          >
            {initials(member.displayName, member.email)}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={cn("truncate font-medium", suspended && "text-[var(--ink-3)]")}>{member.displayName}</span>
              {isSelf && <Tag>you</Tag>}
              {suspended && (
                <Tag tone="warn">
                  <ShieldOff aria-hidden className="size-3" />
                  access revoked
                </Tag>
              )}
            </div>
            <div className="truncate font-mono text-[12px] text-[var(--ink-3)]">{member.email}</div>
          </div>
        </div>
      </Td>
      <Td>
        {canWrite && !roleLocked ? (
          <form action={roleAction}>
            <input type="hidden" name="userId" value={member.userId} />
            <Row className="flex-nowrap">
              <SelectField
                label="Role"
                hideLabel
                name="role"
                defaultValue={member.role}
                className="min-w-32"
              >
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="member">Member</option>
              </SelectField>
              <SubmitButton pending={rolePending} idle="Save" size="sm" />
            </Row>
            {(roleState.status === "failed" || roleState.status === "invalid") && (
              <Notice tone="error" className="mt-2">
                {roleState.fieldErrors["role"] ?? roleState.message}
              </Notice>
            )}
          </form>
        ) : (
          <div>
            <Tag tone={ROLE_TONE[member.role]}>{member.role}</Tag>
            {roleLocked && (
              <p className="mt-1 text-[11.5px] text-[var(--ink-3)]">
                {isSelf ? "You cannot change your own role." : "The last owner cannot be demoted."}
              </p>
            )}
          </div>
        )}
      </Td>
      <Td className="text-[12.5px] whitespace-nowrap text-[var(--ink-3)]">{dayLabel(member.createdAt)}</Td>
      <Td>
        {canWrite && (
          <>
            {isLastOwner ? (
              <p className="text-[11.5px] text-[var(--ink-3)]">The last owner cannot be removed.</p>
            ) : (
              <Row className="flex-nowrap justify-end gap-1">
                {isSelf ? null : suspended ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => withUser(restoreAction)}
                    pending={restorePending}
                  >
                    Restore access
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmingRevoke(true)}
                    pending={revokePending}
                  >
                    Revoke access
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(true)} pending={removePending}>
                  Remove
                </Button>
              </Row>
            )}
            <ConfirmDialog
              open={confirmingRevoke}
              onClose={() => setConfirmingRevoke(false)}
              onConfirm={() => {
                setConfirmingRevoke(false);
                withUser(revokeAction);
              }}
              title={`Revoke ${member.displayName}'s access?`}
              confirmLabel="Revoke access"
              pending={revokePending}
            >
              They are signed out everywhere the moment this is confirmed, and signing in no
              longer offers this organisation. They stay listed here with their role, and
              Restore access puts everything back — no new invitation needed.
            </ConfirmDialog>
            {accessError !== null && (
              <Notice tone="error" className="mt-2">
                {accessError}
              </Notice>
            )}
            <ConfirmDialog
              open={confirmingRemove}
              onClose={() => setConfirmingRemove(false)}
              onConfirm={() => {
                setConfirmingRemove(false);
                const form = new FormData();
                form.set("userId", member.userId);
                startTransition(() => removeAction(form));
              }}
              title={`Remove ${member.displayName}?`}
              confirmLabel={`Remove ${member.displayName}`}
              pending={removePending}
            >
              They lose access to this organisation the moment this is confirmed. Calls they
              reviewed and values they corrected keep their name. They can be invited again.
            </ConfirmDialog>
            {removeState.status === "failed" && (
              <Notice tone="error" className="mt-2">
                {removeState.message}
              </Notice>
            )}
          </>
        )}
      </Td>
    </Tr>
  );
};
