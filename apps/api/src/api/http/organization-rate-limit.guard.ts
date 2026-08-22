import {
  HttpException,
  HttpStatus,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";

import { principalOf } from "../auth/principal";
import { specOf } from "./endpoint";
import { createRateLimiter, type RateLimiter } from "./rate-limit";
import { isApiPath, type ApiRequest } from "./request";

/**
 * R7.4. What one organisation may do to this deployment in a minute.
 *
 * A second guard rather than a branch in `RateLimitGuard`, because the two limits run at
 * different times and the ordering is the whole point. That one is registered before
 * `ApiGuard` so a password-guessing attack is refused before the process spends a hundred
 * milliseconds of scrypt; it therefore cannot know who is calling. This one is registered
 * after, where the principal exists, and it is not about attack at all — it is about one
 * signed-in organisation calling a vendor on a loop and spending everybody's capacity.
 *
 * Keyed on the organisation and the route together. A quota on the organisation alone would
 * mean a busy tool sandbox exhausting the budget for reading a call log, which is the kind of
 * coupling that gets discovered during an incident.
 *
 * Its own limiter instance, so these windows never share keys with the anti-abuse ones. Two
 * maps of a few thousand entries is not the cost worth optimising; a shared store where an
 * organisation's quota could be spent by an address would be.
 *
 * The two limitations `rate-limit.ts` states apply here and are worth restating: it is per
 * process, so two API instances allow twice the rate, and a window boundary allows a short
 * burst of up to twice the limit. That is the right shape for "stop one organisation running
 * away with the process" and the wrong shape for billing. A quota anybody is charged against
 * belongs in the database, counted per call, not in a map a restart empties.
 */
@Injectable()
export class OrganizationRateLimitGuard implements CanActivate {
  private readonly limiter: RateLimiter = createRateLimiter();

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") return true;

    const request = context.switchToHttp().getRequest<ApiRequest>();
    if (!isApiPath(request.originalUrl)) return true;

    const rule = specOf(context.getHandler())?.rateLimit;
    if (rule === undefined || rule.by !== "organization") return true;

    /* No principal means `ApiGuard` let this through as a public route. There is no
       organisation to charge it to, and refusing here would turn a missing quota key into a
       429 on a route somebody is entitled to call. A public route declaring an organisation
       quota is a mistake in the declaration rather than something to enforce at runtime. */
    const principal = principalOf(request);
    if (principal === null) return true;

    const route = `${request.method} ${request.originalUrl.split("?")[0] ?? ""}`;
    const verdict = this.limiter.check(`${route}|${principal.organizationId}`, rule);
    if (verdict.allowed) return true;

    throw new HttpException(
      {
        type: "urn:ansa:problem:rate-limited",
        title: "Too many requests",
        status: HttpStatus.TOO_MANY_REQUESTS,
        detail:
          "This organisation has made too many requests to this endpoint. The limit is per organisation rather than per person, so a colleague may have spent it.",
      },
      HttpStatus.TOO_MANY_REQUESTS,
      { cause: { retryAfterSeconds: verdict.retryAfterSeconds } },
    );
  }
}
