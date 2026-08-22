"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { failureMessage } from "@/lib/api/server";
import { failedForm, invalidForm, succeededForm, type FormState } from "@/lib/form-state";

import {
  inviteSchema,
  removeMemberSchema,
  revokeInvitationSchema,
  setRoleSchema,
  type Role,
} from "./org.schema";
import {
  inviteMember,
  removeMember,
  revokeInvitation,
  setMemberRole,
  setOrganizationHours,
} from "./org.service";

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

// ---------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------

/**
 * When this organisation counts as open.
 *
 * Here rather than on an agent's publish form since migration 0053. They were edited from
 * inside one agent's workspace and written by publishing that agent, so with two agents one
 * agent's form silently moved every other agent's opening times.
 *
 * Applied immediately rather than staged, unlike everything on `/config`. A draft exists so
 * somebody can change what an agent *says* without a caller hearing it half-written; hours
 * have no half-written state and no version to sit in — no configuration snapshot has ever
 * carried them, so there has never been anything to publish or to roll back.
 */
const hoursSchema = z
  .object({
    hoursEnabled: z.boolean(),
    opensAtHour: z.coerce.number().int().min(0).max(23),
    closesAtHour: z.coerce.number().int().min(1).max(24),
    openDays: z.array(z.coerce.number().int().min(1).max(7)),
  })
  .superRefine((value, context) => {
    if (!value.hoursEnabled) return;
    if (value.openDays.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["openDays"],
        message: "Pick at least one day, or turn off the hours restriction.",
      });
    }
    /* Migration 0012 refuses a window that wraps past midnight and is right to — `22 to 2` is
       either a night shift or a typo and the row cannot tell you which. Caught here so the
       answer is a field error rather than a 500 carrying a constraint name. */
    if (value.closesAtHour <= value.opensAtHour) {
      context.addIssue({
        code: "custom",
        path: ["closesAtHour"],
        message:
          "Closing has to be after opening. A window that wraps past midnight is not supported.",
      });
    }
  });

export type HoursState = FormState<{ readonly savedAt: string }>;

export const saveHours = async (_previous: HoursState, form: FormData): Promise<HoursState> => {
  const parsed = hoursSchema.safeParse({
    hoursEnabled: form.get("hoursEnabled") !== null,
    opensAtHour: form.get("opensAtHour") ?? 9,
    closesAtHour: form.get("closesAtHour") ?? 17,
    openDays: form.getAll("openDays"),
  });
  if (!parsed.success) return invalidForm(parsed.error);

  const { hoursEnabled, opensAtHour, closesAtHour, openDays } = parsed.data;

  try {
    // Null for all three is "always open", which is a setting rather than an absence.
    await setOrganizationHours(
      hoursEnabled ? { opensAtHour, closesAtHour, openDays } : null,
    );
    /* The whole workspace tree, not this page. The point of the move is that these hours are
       one organisation's and are read in more than one place — every agent runs on them. */
    revalidatePath("/", "layout");
    return succeededForm({ savedAt: new Date().toISOString() });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};
