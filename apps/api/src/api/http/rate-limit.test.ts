import { describe, expect, it } from "vitest";

import { createRateLimiter } from "./rate-limit";

const RULE = { limit: 3, windowMs: 1000, by: "ip" } as const;

describe("the rate limiter", () => {
  it("allows up to the limit and refuses the next", () => {
    const limiter = createRateLimiter(() => 0);
    expect([1, 2, 3].map(() => limiter.check("a", RULE).allowed)).toEqual([true, true, true]);
    expect(limiter.check("a", RULE).allowed).toBe(false);
  });

  it("counts each key separately, so one caller cannot exhaust another's quota", () => {
    const limiter = createRateLimiter(() => 0);
    for (const _ of [1, 2, 3, 4]) limiter.check("a", RULE);
    expect(limiter.check("b", RULE).allowed).toBe(true);
  });

  it("reopens when the window passes", () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);
    for (const _ of [1, 2, 3, 4]) limiter.check("a", RULE);
    now = 1001;
    expect(limiter.check("a", RULE).allowed).toBe(true);
  });

  it("says how long to wait, rounded up to whole seconds", () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);
    for (const _ of [1, 2, 3]) limiter.check("a", RULE);
    now = 400;
    expect(limiter.check("a", RULE).retryAfterSeconds).toBe(1);
  });
});
