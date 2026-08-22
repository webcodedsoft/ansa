import { api } from "@/lib/api/server";
import { DEFAULT_PAGE_SIZE } from "@/lib/paging";

import type { InviteInput, RemoveMemberInput, RevokeInvitationInput, SetRoleInput } from "./org.schema";

/**
 * Everything this app does with membership, invitations and the operator-managed
 * configuration the consent screen reads. The pages and actions call these; nothing else in
 * `features/org` constructs an API client.
 */

/** One page of members, newest first. `page` is 1-based, as the API counts them. */
export const listMembers = async (page?: number, perPage = DEFAULT_PAGE_SIZE) =>
  (await api()).members.list({
    query: { perPage, ...(page === undefined ? {} : { page }) },
  });

/** Change someone's role. The API refuses with 409 if it would leave no owner. */
export const setMemberRole = async (input: SetRoleInput) =>
  (await api()).members.setRole({ path: { userId: input.userId }, body: { role: input.role } });

/** Remove someone from the organisation. The API refuses to remove the last owner. */
export const removeMember = async (input: RemoveMemberInput) =>
  (await api()).members.remove({ path: { userId: input.userId } });

/** One page of invitations, newest first, including spent and revoked ones. */
export const listInvitations = async (page?: number, perPage = DEFAULT_PAGE_SIZE) =>
  (await api()).invitations.list({
    query: { perPage, ...(page === undefined ? {} : { page }) },
  });

/**
 * Invite someone. The API hands back the redemption token exactly once, on this response —
 * it is not stored anywhere this app can read it again, including on the invitation row
 * `listInvitations` returns.
 */
export const inviteMember = async (input: InviteInput) =>
  (await api()).invitations.invite({ body: { email: input.email, role: input.role } });

export const revokeInvitation = async (input: RevokeInvitationInput) =>
  (await api()).invitations.revoke({ path: { id: input.id } });

/**
 * The live configuration, read here only for `operatorManaged.consent` — the legal basis and
 * calling-hour window the platform operator set. Everything else on this document belongs to
 * the agent-configuration feature, not this one.
 */
/**
 * The organisation itself: its name, its retention windows and the consent posture the
 * outbound gate enforces.
 *
 * `GET /organization` rather than an agent's configuration document, which is where this used
 * to read from. That was a detour through an agent to fetch organisation data, invisible while
 * configuration had no agent in its route and plainly wrong once it did — the page had to pick
 * an agent to ask about facts that belong to none of them. The endpoint has carried `consent`
 * and the retention windows all along.
 */
export const organisation = async () => (await api()).organization.read();

export type Organisation = Awaited<ReturnType<typeof organisation>>;

/** When this organisation counts as open. Null is always open — a setting, not an absence. */
export const setOrganizationHours = async (
  businessHours: { readonly opensAtHour: number; readonly closesAtHour: number; readonly openDays: readonly number[] } | null,
) =>
  (await api()).organization.setHours({
    body: { businessHours: businessHours === null ? null : { ...businessHours, openDays: [...businessHours.openDays] } },
  });

export type MemberPage = Awaited<ReturnType<typeof listMembers>>;
export type MemberSummary = MemberPage["items"][number];
export type InvitationPage = Awaited<ReturnType<typeof listInvitations>>;
export type InvitationSummary = InvitationPage["items"][number];
/** The consent posture, off the organisation rather than off one of its agents. */
export type ConsentPolicy = Organisation["consent"];
