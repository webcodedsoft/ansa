import type { TenantScope } from "@ansa/db";
import { Inject, Injectable, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";

import { principalOf, type Principal } from "../auth/principal";
import type { ApiRequest } from "../http/request";
import { TenantGateway } from "./tenant-gateway";

/**
 * The database, as a handler is allowed to see it.
 *
 * ```ts
 * const members = await this.db.tx((scope) => listMembers(scope, page));
 * ```
 *
 * There is no tenant id in that line, and there is nowhere to put one. The scope arrives
 * already bound to the caller's organisation, and every query function in `@ansa/db` that
 * this surface uses takes a scope rather than a `(Db, tenantId)` pair — so the two ways a
 * tenant-scoped query normally goes wrong (forgetting the scope, passing the wrong id)
 * are both unrepresentable.
 *
 * Request-scoped, so it can read the principal the guard put on the request. If the guard
 * did not run — a route the prefix does not cover, or a controller wired outside
 * `ApiModule` — `tx` throws before it opens anything. It never falls back to an unscoped
 * connection, which would present as "the organisation has no data" and be a silent
 * isolation failure rather than a loud wiring one.
 */
@Injectable({ scope: Scope.REQUEST })
export class TenantContext {
  constructor(
    @Inject(REQUEST) private readonly request: ApiRequest,
    @Inject(TenantGateway) private readonly gateway: TenantGateway,
  ) {}

  get caller(): Principal {
    const principal = principalOf(this.request);
    if (principal === null) {
      throw new Error("TenantContext used on a request that was never authenticated");
    }
    return principal;
  }

  async tx<T>(work: (scope: TenantScope) => Promise<T>): Promise<T> {
    return this.gateway.run(this.caller, work);
  }
}
