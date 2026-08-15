import type { MemberRole, UserOrganisation } from "@ansa/db";
import { Inject, Injectable } from "@nestjs/common";

import { OrganizationGateway } from "../tenancy/organization-gateway";
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

export interface SignedUp extends SignedIn {
  /** False when the address already had an account and simply gained an organisation. */
  readonly createdUser: boolean;
}

export interface AcceptedInvite {
  readonly organisationId: string;
  readonly role: MemberRole;
  readonly createdUser: boolean;
}

@Injectable()
export class AuthService {
  constructor(@Inject(OrganizationGateway) private readonly gateway: OrganizationGateway) {}

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
   * Creates an organisation with this person as its owner, and signs them into it.
   *
   * An address that already has an account may create another organisation, and does it
   * with the password it already has — which is why the password is verified first and a
   * wrong one is refused. Without that check, anyone could type a stranger's address into
   * the sign-up form; they would gain nothing of the stranger's, but the stranger would find
   * an organisation they never joined in their sign-in list, owned by somebody else.
   *
   * Null means the address exists and the password was wrong. That is the same answer, and
   * the same shape, as a failed sign-in, and deliberately does not distinguish itself from
   * one — a sign-up form that said "that password is wrong" would confirm the address has an
   * account, which is precisely what `organisationsFor` spends a full scrypt to avoid
   * revealing.
   *
   * It signs them in rather than making them sign in again. The alternative asks somebody
   * who just typed their password to type it a second time, on a screen that already knows
   * who they are.
   */
  async signUp(
    organisationName: string,
    email: string,
    password: string,
    displayName: string,
    userAgent: string | null,
    now: Date,
  ): Promise<SignedUp | null> {
    const credentials = await this.gateway.credentialsFor(email);

    // Spent whether or not there is an account, as everywhere else here: skipping it for an
    // unknown address makes response time the answer to "is this person registered".
    const verified = await verifyPassword(credentials?.passwordHash ?? null, password);
    if (credentials !== null && !verified) return null;

    // Hashed even when the address already exists, where the value is ignored by the
    // function. It keeps the two paths the same length, and the cost is one scrypt on a
    // request that is creating an organisation anyway.
    const passwordHash = await hashPassword(password);

    const created = await this.gateway.createOrganisation(
      { name: organisationName, email, passwordHash, displayName },
      now,
    );

    const minted = mintSessionToken(created.organizationId);
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.gateway.openSession(created.organizationId, {
      userId: created.userId,
      tokenHash: minted.hash,
      userAgent,
      expiresAt,
    });

    return {
      token: minted.token,
      expiresAt,
      // The name is the one just supplied rather than a re-read: the row was written in this
      // request and reading it back through a scope that did not exist a moment ago buys a
      // round trip and no extra truth.
      organisation: { organizationId: created.organizationId, name: organisationName, role: "owner" },
      createdUser: created.createdUser,
    };
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
    const organisation = organisations.find((candidate) => candidate.organizationId === organisationId);
    if (organisation === undefined) return null;

    const minted = mintSessionToken(organisation.organizationId);
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.gateway.openSession(organisation.organizationId, {
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
      organisationId: accepted.organizationId,
      role: accepted.role,
      createdUser: accepted.createdUser,
    };
  }
}
