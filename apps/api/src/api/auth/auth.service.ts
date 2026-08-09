import type { MemberRole, UserOrganisation } from "@ansa/db";
import { Inject, Injectable } from "@nestjs/common";

import { TenantGateway } from "../tenancy/tenant-gateway";
import { hashPassword, verifyPassword } from "./password";
import { mintSessionToken, readInvitationToken } from "./tokens";

/**
 * Sign-in, sign-out and invitation redemption.
 *
 * Absolute rather than sliding: seven days from issue, and then sign in again. A sliding
 * window means a stolen token stays alive as long as the thief keeps using it, which
 * inverts what an expiry is for.
 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Long enough to survive a weekend and a spam folder, short enough to be worth expiring. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SignedIn {
  readonly token: string;
  readonly expiresAt: Date;
  readonly organisation: UserOrganisation;
}

export interface AcceptedInvite {
  readonly organisationId: string;
  readonly role: MemberRole;
  readonly createdUser: boolean;
}

@Injectable()
export class AuthService {
  constructor(@Inject(TenantGateway) private readonly gateway: TenantGateway) {}

  /**
   * The organisations an address may sign in to, or an empty list.
   *
   * Empty covers a wrong password and an address with no account, and it costs the same
   * either way — `verifyPassword(null, …)` spends a full scrypt against a throwaway hash.
   * Without that, response time answers "does this person have an account" for anyone who
   * cares to time it, and the list of an organisation's staff is not public information.
   */
  async organisationsFor(email: string, password: string): Promise<readonly UserOrganisation[]> {
    const credentials = await this.gateway.credentialsFor(email);
    const verified = await verifyPassword(credentials?.passwordHash ?? null, password);
    if (!verified || credentials === null) return [];
    return this.gateway.organisationsFor(credentials.userId);
  }

  /**
   * Null for a wrong password, an unknown address, or an organisation this person is not
   * a member of. One answer, because separating them would let anyone with one valid
   * account discover which organisations exist.
   */
  async signIn(
    email: string,
    password: string,
    organisationId: string,
    userAgent: string | null,
    now: Date,
  ): Promise<SignedIn | null> {
    const credentials = await this.gateway.credentialsFor(email);
    const verified = await verifyPassword(credentials?.passwordHash ?? null, password);
    if (!verified || credentials === null) return null;

    const organisations = await this.gateway.organisationsFor(credentials.userId);
    const organisation = organisations.find((candidate) => candidate.tenantId === organisationId);
    if (organisation === undefined) return null;

    const minted = mintSessionToken(organisation.tenantId);
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.gateway.openSession(organisation.tenantId, {
      userId: credentials.userId,
      tokenHash: minted.hash,
      userAgent,
      expiresAt,
    });

    return { token: minted.token, expiresAt, organisation };
  }

  /**
   * Redeems an invitation. Null for anything wrong with the token — unknown, expired,
   * already used, revoked.
   *
   * The password is hashed before the token is checked, so a bad token costs the same as
   * a good one. The same reasoning as sign-in: timing is an answer.
   */
  async acceptInvitation(
    rawToken: string,
    password: string,
    displayName: string,
    now: Date,
  ): Promise<AcceptedInvite | null> {
    const passwordHash = await hashPassword(password);
    const tokenHash = readInvitationToken(rawToken);
    if (tokenHash === null) return null;

    const accepted = await this.gateway.redeemInvitation(
      { tokenHash, passwordHash, displayName },
      now,
    );
    if (accepted === null) return null;
    return {
      organisationId: accepted.tenantId,
      role: accepted.role,
      createdUser: accepted.createdUser,
    };
  }
}
