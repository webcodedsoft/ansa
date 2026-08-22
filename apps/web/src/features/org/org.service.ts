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
export const currentConfiguration = async () => {
  /* This screen wants `operatorManaged.consent` — the legal basis and calling-hour window,
     both of which belong to the organisation rather than to any agent. It reads them off an
     agent's configuration document because that is where the API exposes them, which was
     invisible while configuration had no agent in its route and is now plainly a seam in the
     wrong place. Resolved here rather than hidden in a query, and worth moving to an
     organisation endpoint the next time this document is touched. */
  const client = await api();
  const { items } = await client.agents.list();
  const agentId = items.find((agent) => agent.deletedAt === null)?.agentId;
  /* Throws rather than returning null, so callers keep one shape. An organisation with no
     live agent cannot show a consent window either, and a page that renders half of one is
     worse than a page that says it could not load. */
  if (agentId === undefined) throw new Error("this organisation has no live agent");
  return client.config.current({ path: { agentId } });
};

export type MemberPage = Awaited<ReturnType<typeof listMembers>>;
export type MemberSummary = MemberPage["items"][number];
export type InvitationPage = Awaited<ReturnType<typeof listInvitations>>;
export type InvitationSummary = InvitationPage["items"][number];
export type LiveConfiguration = Awaited<ReturnType<typeof currentConfiguration>>;
export type ConsentPolicy = LiveConfiguration["operatorManaged"]["consent"];
