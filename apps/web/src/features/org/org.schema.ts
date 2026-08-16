import { z } from "zod";

import { emailAddress } from "@/lib/patterns";

/**
 * What this app is allowed to submit for organisation membership and invitations.
 *
 * As with every other schema here, this is not a second copy of the API's rules. The
 * database is what actually enforces "not the last owner" and "not your own role" — this
 * only catches the shapes that are obviously wrong before a round trip, and gives the API's
 * own refusal a field to land on when it says no anyway.
 */

export const roleSchema = z.enum(["owner", "admin", "member"]);
export type Role = z.infer<typeof roleSchema>;

export const setRoleSchema = z.object({
  userId: z.uuid(),
  role: roleSchema,
});
export type SetRoleInput = z.infer<typeof setRoleSchema>;

export const removeMemberSchema = z.object({
  userId: z.uuid(),
});
export type RemoveMemberInput = z.infer<typeof removeMemberSchema>;

export const inviteSchema = z.object({
  email: emailAddress,
  role: roleSchema,
});
export type InviteInput = z.infer<typeof inviteSchema>;

export const revokeInvitationSchema = z.object({
  id: z.uuid(),
});
export type RevokeInvitationInput = z.infer<typeof revokeInvitationSchema>;
