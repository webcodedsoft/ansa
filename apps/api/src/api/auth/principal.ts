import type { MemberRole } from "@ansa/db";
import type { OrganizationId } from "@ansa/shared";
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

import { stateOf, type ApiRequest } from "../http/request";

/**
 * Who is making this request, and on behalf of which organisation.
 *
 * Produced only by `SessionGuard`, from a session row that RLS agreed to show inside the
 * scope the token claimed. There is no constructor for it anywhere else, which is what
 * makes "holding a Principal" mean "authenticated" rather than "asserted".
 */
export interface Principal {
  readonly organizationId: OrganizationId;
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: MemberRole;
}

const isPrincipal = (value: unknown): value is Principal =>
  typeof value === "object" && value !== null && "sessionId" in value && "organizationId" in value;

export const rememberPrincipal = (request: ApiRequest, principal: Principal): void => {
  stateOf(request).principal = principal;
};

export const principalOf = (request: ApiRequest): Principal | null => {
  const stored = stateOf(request).principal;
  return isPrincipal(stored) ? stored : null;
};

/**
 * The caller, in a handler signature.
 *
 * Throws rather than returning null: every route that can reach this has been through
 * `SessionGuard`, so an absent principal is a wiring failure and not a request to serve
 * anonymously. A public route has no caller and must not ask for one.
 */
export const Caller = createParamDecorator((_data: unknown, context: ExecutionContext): Principal => {
  const principal = principalOf(context.switchToHttp().getRequest<ApiRequest>());
  if (principal === null) throw new Error("no principal on the request: SessionGuard did not run");
  return principal;
});
