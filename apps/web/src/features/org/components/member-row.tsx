"use client";

import { startTransition, useActionState, useState } from "react";

import { Button, ConfirmDialog, Notice, Row, SelectField, SubmitButton, Tag, Td, Tr } from "@/components/ui";
import { dayLabel } from "@/lib/format";
import { idleForm } from "@/lib/form-state";

import { changeRole, removeMemberAction, type ChangeRoleState, type RemoveMemberState } from "../org.actions";
import { initials } from "../invitations.display";
import type { MemberSummary } from "../org.service";
import type { Role } from "../org.schema";

const ROLE_START: ChangeRoleState = idleForm();
const REMOVE_START: RemoveMemberState = idleForm();

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

  const roleLocked = isSelf || isLastOwner;
  const removed = removeState.status === "succeeded";

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
              <span className="truncate font-medium">{member.displayName}</span>
              {isSelf && <Tag>you</Tag>}
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
              <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(true)} pending={removePending}>
                Remove
              </Button>
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
