import {
  HttpException,
  HttpStatus,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";

import { specOf, type RateLimitRule } from "./endpoint";
import { createRateLimiter, type RateLimiter } from "./rate-limit";
import { clientAddress, isApiPath, type ApiRequest } from "./request";

/**
 * Applies the `rateLimit` an endpoint declared, if it declared one.
 *
 * Registered ahead of `ApiGuard` so that the endpoints it protects — sign-in and
 * invitation redemption — are throttled *before* they spend a hundred milliseconds of
 * scrypt. A limiter that runs after the expensive work still lets an attacker consume the
 * process.
 *
 * Most endpoints declare nothing and are not limited here. They are already behind a
 * session, and a signed-in tenant hammering their own call list is a capacity question for
 * a proxy, not a security one.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limiter: RateLimiter = createRateLimiter();

  /**
   * The email is read straight off the unvalidated body, because this runs before
   * validation on purpose — the limit has to apply to malformed attempts too. Anything
   * that is not a short string collapses to the address-only bucket rather than becoming
   * a map key an attacker chooses.
   */
  private keyFor(request: ApiRequest, rule: RateLimitRule, route: string): string {
    const address = clientAddress(request);
    if (rule.by === "ip") return `${route}|${address}`;

    const body: unknown = request.body;
    const email =
      typeof body === "object" && body !== null && "email" in body
        ? (body as { email: unknown }).email
        : undefined;
    const identity = typeof email === "string" && email.length <= 256 ? email.toLowerCase() : "";
    return `${route}|${address}|${identity}`;
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") return true;

    const request = context.switchToHttp().getRequest<ApiRequest>();
    if (!isApiPath(request.originalUrl)) return true;

    const rule = specOf(context.getHandler())?.rateLimit;
    if (rule === undefined) return true;

    const route = `${request.method} ${request.originalUrl.split("?")[0] ?? ""}`;
    const verdict = this.limiter.check(this.keyFor(request, rule, route), rule);
    if (verdict.allowed) return true;

    const response = context.switchToHttp().getResponse<{ setHeader(n: string, v: string): void }>();
    response.setHeader("Retry-After", String(verdict.retryAfterSeconds));
    throw new HttpException("too many attempts, try again shortly", HttpStatus.TOO_MANY_REQUESTS);
  }
}
