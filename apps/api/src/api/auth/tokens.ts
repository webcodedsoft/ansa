import { createHash, randomBytes } from "node:crypto";

import { asTenantId, type TenantId } from "@ansa/shared";

/**
 * Bearer tokens for sessions and invitations.
 *
 * Both are 256 bits of `randomBytes` and are stored as a SHA-256 digest, never in the
 * clear: a database dump is then a list of digests rather than a list of live logins.
 * SHA-256 and not a KDF, deliberately — a KDF exists to make guessing a low-entropy secret
 * expensive, and there is nothing to guess in 256 random bits. Putting scrypt on this path
 * would add a hundred milliseconds to every authenticated request and buy nothing.
 *
 * The session token carries its organisation, and that is the design decision this whole
 * layer rests on:
 *
 *   ansa_s.<tenant uuid>.<secret>
 *
 * The tenant in there is an unverified claim, and it is safe to act on before it is
 * verified because of what acting on it means: the request opens a transaction scoped to
 * the claimed tenant and looks the session up *inside* it. RLS then filters. A token that
 * claims someone else's organisation finds no session row and is rejected — the lie is
 * what makes it fail. Nothing has to remember to check it.
 *
 * The consequence for the rest of the API is the point: there is no request-level tenant
 * header, query parameter or path segment anywhere, so there is nothing for a handler to
 * read the wrong one from.
 */

const SESSION_PREFIX = "ansa_s";
const INVITATION_PREFIX = "ansa_inv";
const SECRET_BYTES = 32;

export const hashSecret = (secret: string): Buffer =>
  createHash("sha256").update(secret, "utf8").digest();

const mintSecret = (): string => randomBytes(SECRET_BYTES).toString("base64url");

export interface MintedToken {
  /** Shown to the caller once. Never stored, never logged. */
  readonly token: string;
  readonly hash: Buffer;
}

export const mintSessionToken = (tenantId: TenantId): MintedToken => {
  const secret = mintSecret();
  return { token: `${SESSION_PREFIX}.${tenantId}.${secret}`, hash: hashSecret(secret) };
};

export interface SessionToken {
  /** Claimed, not proven. Proving it is what looking the session up inside its scope does. */
  readonly claimedTenantId: TenantId;
  readonly hash: Buffer;
}

export const readSessionToken = (raw: string): SessionToken | null => {
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_PREFIX) return null;
  const [, tenant, secret] = parts as [string, string, string];
  if (secret.length === 0) return null;
  try {
    // asTenantId rejects a malformed uuid here rather than letting it reach the cast
    // inside app.current_tenant(), where it would abort the transaction instead.
    return { claimedTenantId: asTenantId(tenant), hash: hashSecret(secret) };
  } catch {
    return null;
  }
};

/**
 * Invitation tokens carry no organisation.
 *
 * They do not need one: redemption reads the organisation off the invitation row, so
 * putting it in the token would create a second, weaker answer to the same question.
 */
export const mintInvitationToken = (): MintedToken => {
  const secret = mintSecret();
  return { token: `${INVITATION_PREFIX}.${secret}`, hash: hashSecret(secret) };
};

export const readInvitationToken = (raw: string): Buffer | null => {
  const parts = raw.split(".");
  if (parts.length !== 2 || parts[0] !== INVITATION_PREFIX) return null;
  const secret = parts[1] ?? "";
  return secret.length === 0 ? null : hashSecret(secret);
};

/** `Authorization: Bearer …`, or null. Nothing here reads a token from a cookie or a query string. */
export const bearerToken = (header: string | string[] | undefined): string | null => {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return null;
  const match = /^Bearer (.+)$/.exec(value.trim());
  return match?.[1] ?? null;
};
