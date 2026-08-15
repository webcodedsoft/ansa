"use server";

import { revalidatePath } from "next/cache";

import { failureMessage } from "@/lib/api/server";
import { failedForm, invalidForm, succeededForm, type FormState } from "@/lib/form-state";

import {
  inviteSchema,
  removeMemberSchema,
  revokeInvitationSchema,
  setRoleSchema,
  type Role,
} from "./org.schema";
import { inviteMember, removeMember, revokeInvitation, setMemberRole } from "./org.service";

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export interface RoleChanged {
  readonly userId: string;
  readonly role: Role;
}

export type ChangeRoleState = FormState<RoleChanged>;

/**
 * Change one member's role.
 *
 * "Cannot change your own role" and "cannot demote the last owner" are enforced by the
 * database, not invented here — this only sends what was submitted and surfaces whatever the
 * API says back. The UI disables the control for those two cases so the refusal is rare
 * rather than the normal path, but it is not the thing doing the enforcing.
 */
export const changeRole = async (
  _previous: ChangeRoleState,
  form: FormData,
): Promise<ChangeRoleState> => {
  const parsed = setRoleSchema.safeParse({
    userId: form.get("userId") ?? "",
    role: form.get("role") ?? "",
  });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const result = await setMemberRole(parsed.data);
    revalidatePath("/members");
    return succeededForm({ userId: result.userId, role: result.role }, "Role updated.");
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

export type RemoveMemberState = FormState<{ readonly userId: string }>;

/** Remove someone from the organisation. Their account survives; only the membership goes. */
export const removeMemberAction = async (
  _previous: RemoveMemberState,
  form: FormData,
): Promise<RemoveMemberState> => {
  const parsed = removeMemberSchema.safeParse({ userId: form.get("userId") ?? "" });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    await removeMember(parsed.data);
    revalidatePath("/members");
    return succeededForm({ userId: parsed.data.userId }, "Removed.");
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export interface Invited {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly expiresAt: string;
  /**
   * The redemption token, exactly as the API returned it on this response. There is no
   * second endpoint that can produce it again, so once this state is gone — a refresh, a
   * navigation, a second invite — so is the token.
   */
  readonly token: string;
}

export type InviteState = FormState<Invited>;

export const invite = async (_previous: InviteState, form: FormData): Promise<InviteState> => {
  const parsed = inviteSchema.safeParse({
    email: form.get("email") ?? "",
    role: form.get("role") ?? "",
  });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const result = await inviteMember(parsed.data);
    revalidatePath("/invitations");
    return succeededForm({
      id: result.invitation.id,
      email: result.invitation.email,
      role: result.invitation.role,
      expiresAt: result.invitation.expiresAt,
      token: result.token,
    });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

export type RevokeInvitationState = FormState<{ readonly id: string }>;

export const revokeInvitationAction = async (
  _previous: RevokeInvitationState,
  form: FormData,
): Promise<RevokeInvitationState> => {
  const parsed = revokeInvitationSchema.safeParse({ id: form.get("id") ?? "" });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    await revokeInvitation(parsed.data);
    revalidatePath("/invitations");
    return succeededForm({ id: parsed.data.id }, "Revoked.");
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};
