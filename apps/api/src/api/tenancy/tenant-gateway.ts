import {
  acceptInvitation,
  createSession,
  credentialsForEmail,
  findSessionByToken,
  organisationsForUser,
  touchSession,
  withTenant,
  type AcceptedInvitation,
  type Db,
  type NewSession,
  type StoredCredentials,
  type TenantScope,
  type UserOrganisation,
} from "@ansa/db";
import type { TenantId } from "@ansa/shared";
import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";

import type { Principal } from "../auth/principal";
import { readSessionToken } from "../auth/tokens";
import { API_DATA_SOURCE } from "./tokens";

/**
 * The only thing in the API that holds a database handle.
 *
 * Everything else — every controller, every service the next four agents write — reaches
 * the database through `TenantContext.tx()`, which needs a `Principal`, which only
 * `authenticate()` below can produce. That is the structural half of tenant isolation on
 * this surface: a handler cannot obtain an unscoped connection because there is no method
 * that returns one.
 *
 * The class deliberately has no `query()` and no `run(tenantId, work)`. The five methods
 * that are not `run` are each one named operation with a fixed statement, and four of
 * them exist only because sign-in has to happen before a tenant is known. If a sixth is
 * ever needed, the question to answer first is why it cannot be written against a scope.
 *
 * `apps/api/eslint.config.mjs` refuses to let anything under `src/api/` outside this
 * folder import `API_DATA_SOURCE`, `withTenant` or `Db`, so the rule above is a lint
 * failure and not a review comment.
 */
@Injectable()
export class TenantGateway {
  constructor(@Inject(API_DATA_SOURCE) private readonly dataSource: Db | null) {}

  /**
   * 503 rather than a null check at every call site.
   *
   * The dashboard has no useful degraded mode: every page is somebody's own data, and
   * showing them an empty one would be a false answer to a true question.
   */
  private get db(): Db {
    if (this.dataSource === null) {
      throw new ServiceUnavailableException("the dashboard is not available without a database");
    }
    return this.dataSource;
  }

  /**
   * Resolves a bearer token to a caller, or null.
   *
   * The tenant in the token is a claim. It is used to open the scope, and the session
   * lookup then happens under RLS inside that scope — so a token that names an
   * organisation its session does not belong to matches nothing. The claim validates
   * itself; there is no comparison here that could be left out.
   */
  async authenticate(raw: string, now: Date): Promise<Principal | null> {
    const token = readSessionToken(raw);
    if (token === null) return null;

    return withTenant(this.db, token.claimedTenantId, async (scope) => {
      const session = await findSessionByToken(scope, token.hash, now);
      if (session === null) return null;
      await touchSession(scope, session.sessionId, now);
      return { tenantId: scope.tenantId, ...session };
    });
  }

  /**
   * Runs `work` in a transaction scoped to the caller's organisation.
   *
   * The tenant comes off the principal and cannot be passed in. That is the difference
   * between this and `withTenant`, and it is the whole point: there is no argument here
   * for a handler to get wrong, and no way to reach this without having authenticated.
   */
  async run<T>(principal: Principal, work: (scope: TenantScope) => Promise<T>): Promise<T> {
    return withTenant(this.db, principal.tenantId, work);
  }

  // -------------------------------------------------------------------------
  // The sign-in door. Four named operations, no generic query.
  // -------------------------------------------------------------------------

  async credentialsFor(email: string): Promise<StoredCredentials | null> {
    return credentialsForEmail(this.db, email);
  }

  async organisationsFor(userId: string): Promise<readonly UserOrganisation[]> {
    return organisationsForUser(this.db, userId);
  }

  /**
   * Creates a session in an organisation the user has been proven to belong to.
   *
   * `tenantId` is an argument here and nowhere else, and it is only ever one of the values
   * `organisationsFor` returned for this user — which is a membership query, so the
   * proof is the same one RLS would apply.
   */
  async openSession(tenantId: TenantId, session: NewSession): Promise<string> {
    return withTenant(this.db, tenantId, async (scope) => createSession(scope, session));
  }

  async redeemInvitation(
    invitation: { readonly tokenHash: Buffer; readonly passwordHash: string; readonly displayName: string },
    now: Date,
  ): Promise<AcceptedInvitation | null> {
    return acceptInvitation(this.db, invitation, now);
  }
}
