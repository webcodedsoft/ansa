"use client";

import { useActionState, useState } from "react";

import { Button, CONTROL, Notice, Row, SubmitButton, Tag, Td, Tr } from "@/components/ui";
import { when } from "@/lib/format";
import { idleForm } from "@/lib/form-state";

import { changeRole, removeMemberAction, type ChangeRoleState, type RemoveMemberState } from "../org.actions";
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
        <div className="font-medium">{member.displayName}</div>
        <div className="font-mono text-[12px] text-[var(--ink-3)]">{member.email}</div>
      </Td>
      <Td>
        {canWrite && !roleLocked ? (
          <form action={roleAction}>
            <input type="hidden" name="userId" value={member.userId} />
            <Row className="flex-nowrap">
              <label className="sr-only" htmlFor={`role-${member.userId}`}>
                Role
              </label>
              <select
                id={`role-${member.userId}`}
                name="role"
                defaultValue={member.role}
                className={CONTROL}
              >
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="member">Member</option>
              </select>
              <SubmitButton pending={rolePending} idle="Save" busy="Saving…" size="sm" />
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
      <Td className="text-[var(--ink-3)]">{when(member.createdAt)}</Td>
      <Td>
        {canWrite && (
          <form action={removeAction}>
            <input type="hidden" name="userId" value={member.userId} />
            {isLastOwner ? (
              <p className="text-[11.5px] text-[var(--ink-3)]">The last owner cannot be removed.</p>
            ) : confirmingRemove ? (
              <Row>
                <SubmitButton
                  pending={removePending}
                  idle="Confirm remove"
                  busy="Removing…"
                  variant="danger"
                  size="sm"
                />
                <Button size="sm" onClick={() => setConfirmingRemove(false)} disabled={removePending}>
                  Cancel
                </Button>
              </Row>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(true)}>
                Remove
              </Button>
            )}
            {removeState.status === "failed" && (
              <Notice tone="error" className="mt-2">
                {removeState.message}
              </Notice>
            )}
          </form>
        )}
      </Td>
    </Tr>
  );
};
