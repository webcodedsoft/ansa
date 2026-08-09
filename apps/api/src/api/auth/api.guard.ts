import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";

import { specOf } from "../http/endpoint";
import { isApiPath, type ApiRequest } from "../http/request";
import { TenantGateway } from "../tenancy/tenant-gateway";
import { can } from "./capability";
import { rememberPrincipal } from "./principal";
import { bearerToken } from "./tokens";

/**
 * Authentication and authorisation for every route under `/api/v1`, applied globally.
 *
 * Global, and not `@UseGuards` on each controller, because a decorator on each controller
 * is a decorator that can be left off the fifth one. This is registered once as an
 * `APP_GUARD` and every route under the prefix inherits it the moment it exists. The three
 * things it can do:
 *
 *   - not an API path        → defer. The carrier webhooks authenticate by signature and
 *                              the media socket is not HTTP at all; neither has a session.
 *   - API path, no @Endpoint → **refuse**, 500. A route on this surface with no declared
 *                              capability is a route whose access control was forgotten,
 *                              and the safe reading of that is "nobody", not "everybody".
 *                              `routes.test.ts` catches it before it ships; this catches
 *                              it if the test is ever deleted.
 *   - API path with a spec   → require a session unless the spec says `"public"`, then
 *                              require the capability the spec names.
 *
 * The deferral on non-API paths is the one soft edge, and `routes.test.ts` closes it from
 * the other side: it fails if any controller in `ApiModule` declares a route outside the
 * prefix. So a dashboard route is either guarded or it does not build.
 */
@Injectable()
export class ApiGuard implements CanActivate {
  constructor(@Inject(TenantGateway) private readonly gateway: TenantGateway) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;

    const request = context.switchToHttp().getRequest<ApiRequest>();
    if (!isApiPath(request.originalUrl)) return true;

    const spec = specOf(context.getHandler());
    if (spec === undefined) {
      throw new InternalServerErrorException(
        "this route declares no @Endpoint, so its access control is undefined",
      );
    }
    if (spec.capability === "public") return true;

    const raw = bearerToken(request.headers["authorization"]);
    if (raw === null) throw new UnauthorizedException("a bearer token is required");

    const principal = await this.gateway.authenticate(raw, new Date());
    // One answer for an unknown token, an expired one, a revoked one, and one belonging to
    // a different organisation. Distinguishing them tells a holder of a stolen token which
    // part of their guess was right.
    if (principal === null) throw new UnauthorizedException("that session is not valid");

    // Before the capability check, so that a 403 is still attributable in the logs.
    rememberPrincipal(request, principal);

    if (spec.capability === "authenticated") return true;
    if (!can(principal.role, spec.capability)) {
      throw new ForbiddenException(`this needs the ${spec.capability} capability`);
    }
    return true;
  }
}
