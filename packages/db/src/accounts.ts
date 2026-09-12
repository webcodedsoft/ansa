import type { OrganizationId } from "@ansa/shared";

import type { Db } from "./data-source";
import {
  TOTAL_COLUMN,
  pageOrder,
  pageParams,
  toSlice,
  type PageRequest,
  type PageSlice,
  type WithTotal,
} from "./paging";
import { recordAuditEvent } from "./audit";
import type { OrganizationScope } from "./organization-scope";

/**
 * People, organisations, sessions and invitations — the dashboard's half of the schema.
 *
 * **Every function that reads or writes a organization's data takes a `OrganizationScope` and does
 * not take a organization id.** That is not a style preference. A `OrganizationScope` can only come
 * out of `withOrganization`, which means the transaction has already done
 * `set_config('app.organization_id', …)` and RLS is filtering; and because there is no organization
 * id parameter, there is no organization id to pass the wrong value for. The two ways a
 * organization-scoped query normally goes wrong are both absent from the signature.
 *
 * The three functions at the bottom are the exception, and they are the only exception:
 * signing in cannot happen inside a organization scope because which organization is the answer, not
 * the question. They take a `Db` and are named for exactly what they do.
 */

export type MemberRole = "owner" | "admin" | "member";

export const MEMBER_ROLES: readonly MemberRole[] = ["owner", "admin", "member"];

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Everything a request needs to know about who is making it. */
export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: MemberRole;
}

interface SessionRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly role: MemberRole;
}

/**
 * Resolves a presented token to the person behind it, or null.
 *
 * Null covers every failure the same way — unknown token, expired, revoked, membership
 * withdrawn, or a token for a different organisation than the one this scope opened.
 * That last case is what makes the organization id inside the token safe to act on before it
 * has been verified: the scope was opened with the claimed organization, so a session
 * belonging to anyone else is simply not visible here.
 */
export const findSessionByToken = async (
  scope: OrganizationScope,
  tokenHash: Buffer,
  now: Date,
): Promise<AuthenticatedSession | null> => {
  const rows = await scope.query<SessionRow>(
    `select s.id as session_id, u.id as user_id, u.email, u.display_name, m.role
       from sessions s
       join users u on u.id = s.user_id
       join memberships m on m.user_id = s.user_id and m.organization_id = s.organization_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > $2
        -- Both, and this is the point of the whole column. A session outlives the
        -- membership that justified it, so removing somebody from an organisation has to
        -- end their access here rather than only hiding them from a list.
        and u.deleted_at is null
        and m.deleted_at is null
        -- Revoked access is the same answer as no membership: the row stands, the session
        -- does not. See migration 0083.
        and m.suspended_at is null
      limit 1`,
    [tokenHash, now],
  );

  const row = rows[0];
  if (row === undefined) return null;
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
  };
};

/**
 * Records that the session was used, at most once a minute.
 *
 * Rate-limited in SQL rather than skipped: `last_seen_at` is what makes "revoke the
 * session I do not recognise" a decision someone can actually make, and writing it on
 * every request would make each read a write.
 */
export const touchSession = async (
  scope: OrganizationScope,
  sessionId: string,
  now: Date,
): Promise<void> => {
  await scope.query(
    // $2 is cast explicitly: without it Postgres infers the parameter's type from
    // `$2 - interval`, decides it is an interval, and fails at runtime rather than in
    // review — "operator does not exist: timestamp with time zone < interval".
    `update sessions set last_seen_at = $2::timestamptz
      where id = $1 and last_seen_at < $2::timestamptz - interval '1 minute'`,
    [sessionId, now],
  );
};

export interface NewSession {
  readonly userId: string;
  readonly tokenHash: Buffer;
  readonly userAgent: string | null;
  readonly expiresAt: Date;
}

export const createSession = async (scope: OrganizationScope, session: NewSession): Promise<string> => {
  const rows = await scope.query<{ id: string }>(
    `insert into sessions (organization_id, user_id, token_hash, user_agent, expires_at)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [scope.organizationId, session.userId, session.tokenHash, session.userAgent, session.expiresAt],
  );
  const id = rows[0]?.id;
  // The insert either returns a row or raises; a silent undefined here would mean the
  // caller hands out a token for a session nobody can revoke.
  if (id === undefined) throw new Error("session insert returned no row");
  /* Recorded here rather than in a controller: every sign-in path — password, invitation,
     sign-up — makes its session through this one function, so this is the one place that
     cannot be skipped. */
  await recordAuditEvent(scope, {
    actorUserId: session.userId,
    actorName: await displayNameOf(scope, session.userId),
    action: "signed_in",
    subjectKind: "account",
    subjectId: session.userId,
    detail: { userAgent: session.userAgent },
  });
  return id;
};

/** A member's name as it is now, for writing on an audit row before they are gone from the join. */
export const displayNameOf = async (scope: OrganizationScope, userId: string): Promise<string | null> => {
  const rows = await scope.query<{ display_name: string }>(
    `select display_name from users where id = $1`,
    [userId],
  );
  return rows[0]?.display_name ?? null;
};

/** An invitation's address, for the audit row of its revocation. */
export const invitationEmailOf = async (scope: OrganizationScope, invitationId: string): Promise<string | null> => {
  const rows = await scope.query<{ email: string }>(`select email from invitations where id = $1`, [invitationId]);
  return rows[0]?.email ?? null;
};

/** Idempotent: signing out twice is not an error, and neither is a session already expired. */
export const revokeSession = async (
  scope: OrganizationScope,
  sessionId: string,
  now: Date,
): Promise<void> => {
  await scope.query(`update sessions set revoked_at = $2 where id = $1 and revoked_at is null`, [
    sessionId,
    now,
  ]);
};

// ---------------------------------------------------------------------------
// The signed-in person's own account
// ---------------------------------------------------------------------------

/**
 * What a person may change about themselves, and only themselves: the name they are shown
 * as. The email is the sign-in identity and is not changed here — a new address is a new
 * invitation, so the organisation's owners see it happen.
 *
 * `users` is reachable through a live membership in the current organisation, which the
 * caller has by definition. `mutate`, for the reason every update in this package says.
 */
export const renameUser = async (
  scope: OrganizationScope,
  userId: string,
  displayName: string,
): Promise<boolean> => {
  const rows = await scope.mutate<{ id: string }>(
    `update users set display_name = $2 where id = $1 and deleted_at is null returning id`,
    [userId, displayName],
  );
  return rows.length > 0;
};

/** For verifying the current password before it is replaced. Null when the row is not visible. */
export const passwordHashOf = async (scope: OrganizationScope, userId: string): Promise<string | null> => {
  const rows = await scope.query<{ password_hash: string }>(
    `select password_hash from users where id = $1 and deleted_at is null`,
    [userId],
  );
  return rows[0]?.password_hash ?? null;
};

export const setPasswordHash = async (
  scope: OrganizationScope,
  userId: string,
  passwordHash: string,
): Promise<boolean> => {
  const rows = await scope.mutate<{ id: string }>(
    `update users set password_hash = $2 where id = $1 and deleted_at is null returning id`,
    [userId, passwordHash],
  );
  return rows.length > 0;
};

/**
 * Every session this person holds, in every organisation, except the one making the
 * request. Crosses organisations through `app.end_other_sessions` (migration 0084), which
 * insists the kept session belongs to them. Returns how many it ended.
 */
export const endOtherSessions = async (
  scope: OrganizationScope,
  userId: string,
  keepSessionId: string,
): Promise<number> => {
  const rows = await scope.query<{ ended: number }>(
    `select app.end_other_sessions($1, $2) as ended`,
    [userId, keepSessionId],
  );
  return Number(rows[0]?.ended ?? 0);
};

/**
 * Close the caller's own account (migration 0085).
 *
 * Returns the names of the organisations they are the only owner of, in which case nothing
 * was written and they have to hand ownership on first. Empty means it is done: every
 * membership ended, every session revoked — this one included — and the address freed.
 */
export const closeAccount = async (
  scope: OrganizationScope,
  userId: string,
  keepSessionId: string,
): Promise<readonly string[]> => {
  const rows = await scope.query<{ sole_owner_of: string[] }>(
    `select app.close_account($1, $2) as sole_owner_of`,
    [userId, keepSessionId],
  );
  return rows[0]?.sole_owner_of ?? [];
};

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export interface Member {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: MemberRole;
  readonly createdAt: string;
  /** Set while their access is revoked (migration 0083). Null is the ordinary state. */
  readonly suspendedAt: string | null;
}

interface MemberRow {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly role: MemberRole;
  readonly created_at: Date;
  readonly suspended_at: Date | null;
}

export const listMembers = async (
  scope: OrganizationScope,
  page: PageRequest,
): Promise<PageSlice<Member>> => {
  const rows = await scope.query<MemberRow & WithTotal>(
    `select m.user_id, u.email, u.display_name, m.role, m.created_at, m.suspended_at, ${TOTAL_COLUMN}
       from memberships m
       join users u on u.id = m.user_id
      where m.deleted_at is null and u.deleted_at is null
      ${pageOrder("m.created_at", "m.user_id")}`,
    pageParams(page),
  );

  return toSlice(
    rows,
    (row): Member => ({
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      createdAt: row.created_at.toISOString(),
      suspendedAt: row.suspended_at?.toISOString() ?? null,
    }),
  );
};

/**
 * Returns false when there is no such member — which, under RLS, is also what "that
 * person belongs to a different organisation" looks like. The two are deliberately
 * indistinguishable to the caller for the same reason the call viewer 404s rather than
 * 403s: telling you a user id exists somewhere is telling you something.
 *
 * Demoting the last owner raises, from the deferred constraint trigger in migration 0016.
 */
export const setMemberRole = async (
  scope: OrganizationScope,
  userId: string,
  role: MemberRole,
): Promise<boolean> => {
  const rows = await scope.mutate<{ user_id: string }>(
    `update memberships set role = $2 where user_id = $1 returning user_id`,
    [userId, role],
  );
  return rows.length > 0;
};

/**
 * Remove somebody from an organisation, without losing that they were in it.
 *
 * A soft delete since 0032. The row is what a call log, an invitation trail and an audit
 * question all point back at, and hard-deleting it made "who published version 4" unanswerable
 * the moment that person left. Access ends immediately regardless: `authenticateSession`
 * requires a live membership, so an existing session stops working on its next request.
 *
 * Already-removed returns false rather than true, so a second call is not reported as having
 * done something.
 */
export const removeMember = async (scope: OrganizationScope, userId: string): Promise<boolean> => {
  const rows = await scope.mutate<{ user_id: string }>(
    `update memberships set deleted_at = now()
      where user_id = $1 and deleted_at is null
      returning user_id`,
    [userId],
  );
  if (rows.length === 0) return false;
  await endSessionsOf(scope, userId);
  return true;
};

/**
 * Every session this person holds in this organisation, ended.
 *
 * The membership checks in `findSessionByToken` already make those sessions inert, so this is
 * hygiene rather than the gate: a revoked row says plainly in the sessions table that access
 * ended, and when, rather than leaving a live-looking row that happens not to join.
 */
const endSessionsOf = async (scope: OrganizationScope, userId: string): Promise<void> => {
  await scope.mutate(
    `update sessions set revoked_at = now()
      where user_id = $1 and organization_id = app.current_organization() and revoked_at is null`,
    [userId],
  );
};

/**
 * Revoke somebody's access without removing them.
 *
 * The membership stands — role and joined date kept, still listed — but nothing
 * authenticates through it: their open sessions end here, and `organisations_for_user`
 * stops offering this organisation at sign-in. For a person who may be back; removal is for
 * a person who has left. Suspending the last owner raises from the constraint trigger, the
 * same way demoting them does. Already suspended returns false.
 */
export const suspendMember = async (scope: OrganizationScope, userId: string): Promise<boolean> => {
  const rows = await scope.mutate<{ user_id: string }>(
    `update memberships set suspended_at = now()
      where user_id = $1 and deleted_at is null and suspended_at is null
      returning user_id`,
    [userId],
  );
  if (rows.length === 0) return false;
  await endSessionsOf(scope, userId);
  return true;
};

/** The reverse. They sign in as before, with the role they had. Not suspended returns false. */
export const restoreMember = async (scope: OrganizationScope, userId: string): Promise<boolean> => {
  const rows = await scope.mutate<{ user_id: string }>(
    `update memberships set suspended_at = null
      where user_id = $1 and deleted_at is null and suspended_at is not null
      returning user_id`,
    [userId],
  );
  return rows.length > 0;
};

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly role: MemberRole;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly role: MemberRole;
  readonly expires_at: Date;
  readonly accepted_at: Date | null;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
}

const toInvitation = (row: InvitationRow): Invitation => ({
  id: row.id,
  email: row.email,
  role: row.role,
  expiresAt: row.expires_at.toISOString(),
  acceptedAt: row.accepted_at?.toISOString() ?? null,
  revokedAt: row.revoked_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
});

const INVITATION_COLUMNS = "id, email, role, expires_at, accepted_at, revoked_at, created_at";

export interface NewInvitation {
  readonly email: string;
  readonly role: MemberRole;
  readonly tokenHash: Buffer;
  readonly invitedBy: string;
  readonly expiresAt: Date;
}

/**
 * Issues an invitation, superseding any live one for the same address.
 *
 * The revoke and the insert are one call because they are one intention. There is a
 * partial unique index on `(organization_id, email) where accepted_at is null and revoked_at is
 * null`, so skipping the revoke would not produce two live tokens — it would produce a
 * constraint violation and an owner who cannot re-send an invitation that went to spam.
 */
export const createInvitation = async (
  scope: OrganizationScope,
  invitation: NewInvitation,
  now: Date,
): Promise<Invitation> => {
  await scope.query(
    `update invitations set revoked_at = $2
      where email = $1 and accepted_at is null and revoked_at is null`,
    [invitation.email, now],
  );

  const rows = await scope.query<InvitationRow>(
    `insert into invitations (organization_id, email, role, token_hash, invited_by, expires_at)
     values ($1, $2, $3, $4, $5, $6)
     returning ${INVITATION_COLUMNS}`,
    [
      scope.organizationId,
      invitation.email,
      invitation.role,
      invitation.tokenHash,
      invitation.invitedBy,
      invitation.expiresAt,
    ],
  );

  const row = rows[0];
  if (row === undefined) throw new Error("invitation insert returned no row");
  return toInvitation(row);
};

export const listInvitations = async (
  scope: OrganizationScope,
  page: PageRequest,
): Promise<PageSlice<Invitation>> => {
  const rows = await scope.query<InvitationRow & WithTotal>(
    `select ${INVITATION_COLUMNS}, ${TOTAL_COLUMN} from invitations
      ${pageOrder("created_at", "id")}`,
    pageParams(page),
  );
  return toSlice(rows, toInvitation);
};

export const revokeInvitation = async (
  scope: OrganizationScope,
  invitationId: string,
  now: Date,
): Promise<boolean> => {
  const rows = await scope.mutate<{ id: string }>(
    `update invitations set revoked_at = $2
      where id = $1 and accepted_at is null and revoked_at is null
      returning id`,
    [invitationId, now],
  );
  return rows.length > 0;
};

// ---------------------------------------------------------------------------
// The sign-in door
// ---------------------------------------------------------------------------
//
// Three functions, all wrapping a `security definer` routine from migration 0016, all
// taking a `Db` rather than a `OrganizationScope` because there is no organization yet. This is the
// entire unscoped surface of the API. Nothing else in `apps/api/src/api` may hold a `Db`
// — see the eslint rule in apps/api/eslint.config.mjs.

export interface StoredCredentials {
  readonly userId: string;
  readonly passwordHash: string;
}

/**
 * Null for an address with no account.
 *
 * The caller must still spend the cost of a password verification on null, or the
 * response time answers "does this person have an account here" for anyone who asks.
 */
export const credentialsForEmail = async (
  db: Db,
  email: string,
): Promise<StoredCredentials | null> => {
  const rows = (await db.query("select user_id, password_hash from app.credentials_for_email($1)", [
    email.toLowerCase(),
  ])) as { user_id: string; password_hash: string }[];
  const row = rows[0];
  return row === undefined ? null : { userId: row.user_id, passwordHash: row.password_hash };
};

export interface UserOrganisation {
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly role: MemberRole;
}

/** Called only once the password has verified, so it cannot be used to enumerate anything. */
export const organisationsForUser = async (
  db: Db,
  userId: string,
): Promise<readonly UserOrganisation[]> => {
  const rows = (await db.query("select organization_id, name, role from app.organisations_for_user($1)", [
    userId,
  ])) as { organization_id: OrganizationId; name: string; role: MemberRole }[];
  return rows.map((row) => ({ organizationId: row.organization_id, name: row.name, role: row.role }));
};

export interface CreatedOrganisation {
  readonly organizationId: OrganizationId;
  readonly userId: string;
  /** False when the address already had an account and the supplied password was ignored. */
  readonly createdUser: boolean;
}

/**
 * Creates an organisation and makes the caller its owner.
 *
 * **This performs no authentication and the caller must have done it.** When the address
 * already has an account, its password has to have been verified first — otherwise anyone
 * could name a stranger's address and attach that account to an organisation they control.
 * `AuthService.signUp` is the only caller and does exactly that check; see the comment on
 * `app.create_organisation` in migration 0017 for the full reasoning.
 *
 * `passwordHash` is used only for an address that is genuinely new. For one that exists it
 * is ignored, in the same way and for the same reason as in `acceptInvitation`: being able
 * to overwrite a password by naming an address would be a takeover.
 */
export const createOrganisation = async (
  db: Db,
  organisation: {
    readonly name: string;
    readonly email: string;
    readonly passwordHash: string;
    readonly displayName: string;
  },
  now: Date,
): Promise<CreatedOrganisation> => {
  const rows = (await db.query(
    `select out_organization_id as organization_id, out_user_id as user_id,
            out_created_user as created_user
       from app.create_organisation($1, $2, $3, $4, $5)`,
    [
      organisation.name,
      organisation.email,
      organisation.passwordHash,
      organisation.displayName,
      now,
    ],
  )) as { organization_id: OrganizationId; user_id: string; created_user: boolean }[];

  const row = rows[0];
  // Unlike redeeming an invitation there is no "it did not apply" case: the function either
  // inserts or raises. No row back means it changed under us, and treating that as an
  // ordinary refusal would report a broken deployment as a rejected sign-up.
  if (row === undefined) throw new Error("app.create_organisation returned no row");

  return { organizationId: row.organization_id, userId: row.user_id, createdUser: row.created_user };
};

export interface AcceptedInvitation {
  readonly organizationId: OrganizationId;
  readonly userId: string;
  readonly role: MemberRole;
  /** False when the address already had an account and the supplied password was ignored. */
  readonly createdUser: boolean;
}

/**
 * Redeems an invitation token. Null means it was unknown, expired, already used or
 * revoked — the four are one answer, because distinguishing them tells a guesser which
 * of their guesses was close.
 *
 * The organisation comes back from the invitation row. It is never an argument, so
 * holding a token cannot be turned into joining an organisation the token was not for.
 */
export const acceptInvitation = async (
  db: Db,
  invitation: {
    readonly tokenHash: Buffer;
    readonly passwordHash: string;
    readonly displayName: string;
  },
  now: Date,
): Promise<AcceptedInvitation | null> => {
  const rows = (await db.query(
    `select out_organization_id as organization_id, out_user_id as user_id,
            out_role as role, out_created_user as created_user
       from app.accept_invitation($1, $2, $3, $4)`,
    [invitation.tokenHash, invitation.passwordHash, invitation.displayName, now],
  )) as { organization_id: OrganizationId; user_id: string; role: MemberRole; created_user: boolean }[];

  const row = rows[0];
  if (row === undefined) return null;
  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.role,
    createdUser: row.created_user,
  };
};
