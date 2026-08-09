import type { TenantId } from "@ansa/shared";

import type { Db } from "./data-source";
import { keysetOrder, keysetParams, keysetWhere, toSlice, type PageRequest, type PageSlice } from "./paging";
import type { TenantScope } from "./tenant-scope";

/**
 * People, organisations, sessions and invitations — the dashboard's half of the schema.
 *
 * **Every function that reads or writes a tenant's data takes a `TenantScope` and does
 * not take a tenant id.** That is not a style preference. A `TenantScope` can only come
 * out of `withTenant`, which means the transaction has already done
 * `set_config('app.tenant_id', …)` and RLS is filtering; and because there is no tenant
 * id parameter, there is no tenant id to pass the wrong value for. The two ways a
 * tenant-scoped query normally goes wrong are both absent from the signature.
 *
 * The three functions at the bottom are the exception, and they are the only exception:
 * signing in cannot happen inside a tenant scope because which tenant is the answer, not
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
 * That last case is what makes the tenant id inside the token safe to act on before it
 * has been verified: the scope was opened with the claimed tenant, so a session
 * belonging to anyone else is simply not visible here.
 */
export const findSessionByToken = async (
  scope: TenantScope,
  tokenHash: Buffer,
  now: Date,
): Promise<AuthenticatedSession | null> => {
  const rows = await scope.query<SessionRow>(
    `select s.id as session_id, u.id as user_id, u.email, u.display_name, m.role
       from sessions s
       join users u on u.id = s.user_id
       join memberships m on m.user_id = s.user_id and m.tenant_id = s.tenant_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > $2
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
  scope: TenantScope,
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

export const createSession = async (scope: TenantScope, session: NewSession): Promise<string> => {
  const rows = await scope.query<{ id: string }>(
    `insert into sessions (tenant_id, user_id, token_hash, user_agent, expires_at)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [scope.tenantId, session.userId, session.tokenHash, session.userAgent, session.expiresAt],
  );
  const id = rows[0]?.id;
  // The insert either returns a row or raises; a silent undefined here would mean the
  // caller hands out a token for a session nobody can revoke.
  if (id === undefined) throw new Error("session insert returned no row");
  return id;
};

/** Idempotent: signing out twice is not an error, and neither is a session already expired. */
export const revokeSession = async (
  scope: TenantScope,
  sessionId: string,
  now: Date,
): Promise<void> => {
  await scope.query(`update sessions set revoked_at = $2 where id = $1 and revoked_at is null`, [
    sessionId,
    now,
  ]);
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
}

interface MemberRow {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly role: MemberRole;
  readonly created_at: Date;
}

export const listMembers = async (
  scope: TenantScope,
  page: PageRequest,
): Promise<PageSlice<Member>> => {
  const rows = await scope.query<MemberRow>(
    `select m.user_id, u.email, u.display_name, m.role, m.created_at
       from memberships m
       join users u on u.id = m.user_id
      where ${keysetWhere("m.created_at", "m.user_id")}
      ${keysetOrder("m.created_at", "m.user_id")}`,
    keysetParams(page),
  );

  const members = rows.map(
    (row): Member => ({
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      createdAt: row.created_at.toISOString(),
    }),
  );
  return toSlice(members, page, (member) => ({ createdAt: member.createdAt, id: member.userId }));
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
  scope: TenantScope,
  userId: string,
  role: MemberRole,
): Promise<boolean> => {
  const rows = await scope.mutate<{ user_id: string }>(
    `update memberships set role = $2 where user_id = $1 returning user_id`,
    [userId, role],
  );
  return rows.length > 0;
};

export const removeMember = async (scope: TenantScope, userId: string): Promise<boolean> => {
  const rows = await scope.mutate<{ user_id: string }>(
    `delete from memberships where user_id = $1 returning user_id`,
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
 * partial unique index on `(tenant_id, email) where accepted_at is null and revoked_at is
 * null`, so skipping the revoke would not produce two live tokens — it would produce a
 * constraint violation and an owner who cannot re-send an invitation that went to spam.
 */
export const createInvitation = async (
  scope: TenantScope,
  invitation: NewInvitation,
  now: Date,
): Promise<Invitation> => {
  await scope.query(
    `update invitations set revoked_at = $2
      where email = $1 and accepted_at is null and revoked_at is null`,
    [invitation.email, now],
  );

  const rows = await scope.query<InvitationRow>(
    `insert into invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
     values ($1, $2, $3, $4, $5, $6)
     returning ${INVITATION_COLUMNS}`,
    [
      scope.tenantId,
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
  scope: TenantScope,
  page: PageRequest,
): Promise<PageSlice<Invitation>> => {
  const rows = await scope.query<InvitationRow>(
    `select ${INVITATION_COLUMNS} from invitations
      where ${keysetWhere("created_at", "id")}
      ${keysetOrder("created_at", "id")}`,
    keysetParams(page),
  );
  const invitations = rows.map(toInvitation);
  return toSlice(invitations, page, (invitation) => ({
    createdAt: invitation.createdAt,
    id: invitation.id,
  }));
};

export const revokeInvitation = async (
  scope: TenantScope,
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
// taking a `Db` rather than a `TenantScope` because there is no tenant yet. This is the
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
  readonly tenantId: TenantId;
  readonly name: string;
  readonly role: MemberRole;
}

/** Called only once the password has verified, so it cannot be used to enumerate anything. */
export const organisationsForUser = async (
  db: Db,
  userId: string,
): Promise<readonly UserOrganisation[]> => {
  const rows = (await db.query("select tenant_id, name, role from app.organisations_for_user($1)", [
    userId,
  ])) as { tenant_id: TenantId; name: string; role: MemberRole }[];
  return rows.map((row) => ({ tenantId: row.tenant_id, name: row.name, role: row.role }));
};

export interface AcceptedInvitation {
  readonly tenantId: TenantId;
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
    `select out_tenant_id as tenant_id, out_user_id as user_id,
            out_role as role, out_created_user as created_user
       from app.accept_invitation($1, $2, $3, $4)`,
    [invitation.tokenHash, invitation.passwordHash, invitation.displayName, now],
  )) as { tenant_id: TenantId; user_id: string; role: MemberRole; created_user: boolean }[];

  const row = rows[0];
  if (row === undefined) return null;
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    role: row.role,
    createdUser: row.created_user,
  };
};
