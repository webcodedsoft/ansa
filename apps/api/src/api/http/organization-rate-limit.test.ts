import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HttpException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { Endpoint } from "./endpoint";
import { OrganizationRateLimitGuard } from "./organization-rate-limit.guard";

/**
 * One organisation's budget, and whose it is not.
 *
 * The property worth testing is not "a counter counts". It is that the counter is keyed on the
 * organisation and the route together, which is the whole reason this guard exists separately
 * from the anti-abuse one: two colleagues at different desks must share a budget, and two
 * organisations must not — the opposite of what keying on an address gives you.
 */

const ORGANIZATION = "5a1c0000-0000-4000-8000-000000000001";
const OTHER = "5a1c0000-0000-4000-8000-000000000002";

/**
 * A handler carrying a real `@Endpoint` declaration, because that is where the guard reads its
 * rule from. Declaring the metadata by hand would test a shape rather than the decorator every
 * route actually uses.
 */
class Probe {
  @Endpoint({
    summary: "Two a minute",
    capability: "config:write",
    rateLimit: { limit: 2, windowMs: 60_000, by: "organization" },
  })
  limited(): void {}

  @Endpoint({ summary: "Unlimited", capability: "config:write" })
  open(): void {}

  @Endpoint({
    summary: "Guarded before authentication",
    capability: "public",
    rateLimit: { limit: 1, windowMs: 60_000, by: "ip" },
  })
  byAddress(): void {}
}

const probe = new Probe();

const contextFor = (
  handler: () => void,
  principal: { readonly organizationId: string } | null,
  url = "/api/v1/tools/test",
): ExecutionContext =>
  ({
    getType: () => "http",
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => ({
        method: "POST",
        originalUrl: url,
        /* Where `principalOf` reads from. `sessionId` is not decoration: `isPrincipal` checks
           for it, so a fake carrying only an organisation id reads as no principal at all and
           every assertion below passes for the wrong reason. */
        ...(principal === null
          ? {}
          : { ansa: { principal: { ...principal, sessionId: "session-for-a-test" } } }),
      }),
    }),
  }) as unknown as ExecutionContext;

const allow = (guard: OrganizationRateLimitGuard, context: ExecutionContext): boolean => {
  try {
    return guard.canActivate(context);
  } catch (error) {
    if (error instanceof HttpException) return false;
    throw error;
  }
};

describe("one organisation's quota", () => {
  it("spends the budget across everybody in the organisation", () => {
    /* The reason this guard exists. Three requests, one organisation, and it does not matter
       that they might come from three different desks: the load lands on the same vendor. */
    const guard = new OrganizationRateLimitGuard();
    const request = () => allow(guard, contextFor(probe.limited, { organizationId: ORGANIZATION }));

    expect(request()).toBe(true);
    expect(request()).toBe(true);
    expect(request()).toBe(false);
  });

  it("does not spend another organisation's", () => {
    const guard = new OrganizationRateLimitGuard();
    const mine = () => allow(guard, contextFor(probe.limited, { organizationId: ORGANIZATION }));
    const theirs = () => allow(guard, contextFor(probe.limited, { organizationId: OTHER }));

    mine();
    mine();
    expect(mine()).toBe(false);
    /* Exhausting one organisation must leave the next untouched — the failure a single shared
       window would produce, and the one nobody would notice until it bit. */
    expect(theirs()).toBe(true);
  });

  it("keeps one route's budget out of another's", () => {
    /* A quota on the organisation alone would mean a busy sandbox exhausting the budget for
       reading a call log: coupling that only shows up during an incident. */
    const guard = new OrganizationRateLimitGuard();
    const sandbox = () => allow(guard, contextFor(probe.limited, { organizationId: ORGANIZATION }));
    const elsewhere = () =>
      allow(guard, contextFor(probe.limited, { organizationId: ORGANIZATION }, "/api/v1/calls"));

    sandbox();
    sandbox();
    expect(sandbox()).toBe(false);
    expect(elsewhere()).toBe(true);
  });

  it("ignores a route that declared no limit", () => {
    const guard = new OrganizationRateLimitGuard();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(allow(guard, contextFor(probe.open, { organizationId: ORGANIZATION }))).toBe(true);
    }
  });

  it("leaves address-keyed rules to the guard that runs before authentication", () => {
    /* Both guards see every request. If this one also enforced `ip` rules the limit would be
       consumed twice per request and halve without anybody changing a number. */
    const guard = new OrganizationRateLimitGuard();
    const request = () =>
      allow(guard, contextFor(probe.byAddress, { organizationId: ORGANIZATION }));

    expect(request()).toBe(true);
    expect(request()).toBe(true);
  });

  it("lets a request through when there is no principal to charge", () => {
    /* A public route declaring an organisation quota is a mistake in the declaration. Refusing
       here would turn it into a 429 on a route somebody is entitled to call, which is a worse
       failure than the missing key. */
    const guard = new OrganizationRateLimitGuard();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(allow(guard, contextFor(probe.limited, null))).toBe(true);
    }
  });
});

/**
 * The ordering, read off the module rather than argued about.
 *
 * Nothing else here can see it: `canActivate` is correct in isolation whatever order the
 * guards run in, and the failure is silent — put this one before `ApiGuard` and there is no
 * principal yet, so every organisation-keyed limit quietly stops applying. Reading the source
 * is the same trick `environment.test.ts` uses on the voice webhook path, and for the same
 * reason: the fact lives in a list, not in a function anybody can call.
 */
describe("where the guards sit", () => {
  const source = readFileSync(join(__dirname, "..", "api.module.ts"), "utf8");
  const at = (name: string): number => source.indexOf(`useClass: ${name}`);

  it("puts the anti-abuse limiter before authentication and the quota after", () => {
    const abuse = at("RateLimitGuard");
    const auth = at("ApiGuard");
    const quota = at("OrganizationRateLimitGuard");

    expect(abuse, "RateLimitGuard is no longer registered").toBeGreaterThan(-1);
    expect(auth, "ApiGuard is no longer registered").toBeGreaterThan(-1);
    expect(quota, "OrganizationRateLimitGuard is no longer registered").toBeGreaterThan(-1);

    // Before scrypt is spent, so guessing cannot make the process pay for the attempt.
    expect(abuse).toBeLessThan(auth);
    // After the principal exists, because there is nothing to charge a quota to before it.
    expect(quota).toBeGreaterThan(auth);
  });
});
