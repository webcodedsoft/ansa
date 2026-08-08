import { describe, expect, it } from "vitest";

import { mayCall, type ConsentFacts } from "./consent";

/** 14:00 WAT — comfortably inside any calling window. */
const midday = new Date("2026-08-08T13:00:00Z");
const granted = { grantedAt: new Date("2026-01-01T00:00:00Z"), revokedAt: null };

const facts = (over: Partial<ConsentFacts> = {}): ConsentFacts => ({
  consent: granted,
  suppressed: false,
  now: midday,
  ...over,
});

describe("mayCall", () => {
  it("allows a consented number during the day", () => {
    expect(mayCall(facts())).toEqual({ allowed: true });
  });

  it("refuses when there is no consent on record", () => {
    // Fails closed: the absence of a record is exactly what an unlawful call looks like.
    expect(mayCall(facts({ consent: null }))).toMatchObject({ allowed: false });
  });

  it("lets suppression outrank consent", () => {
    // Asking not to be called is the most explicit signal a person can give, and an
    // older record saying they once agreed must not override it.
    const verdict = mayCall(facts({ suppressed: true }));
    expect(verdict).toMatchObject({ allowed: false });
    expect(verdict.allowed === false && verdict.reason).toContain("do-not-call");
  });

  it("refuses after consent is withdrawn", () => {
    expect(
      mayCall(facts({ consent: { grantedAt: granted.grantedAt, revokedAt: new Date("2026-06-01T00:00:00Z") } })),
    ).toMatchObject({ allowed: false });
  });

  it("honours a withdrawal that has not taken effect yet", () => {
    expect(
      mayCall(facts({ consent: { grantedAt: granted.grantedAt, revokedAt: new Date("2026-12-01T00:00:00Z") } })),
    ).toEqual({ allowed: true });
  });

  it("treats a future-dated grant as a data error, not permission", () => {
    expect(
      mayCall(facts({ consent: { grantedAt: new Date("2027-01-01T00:00:00Z"), revokedAt: null } })),
    ).toMatchObject({ allowed: false });
  });

  it("refuses outside calling hours, in WAT and not UTC", () => {
    // 21:30 WAT is 20:30 UTC. Reading this in UTC would place it inside the window.
    const late = mayCall(facts({ now: new Date("2026-08-08T20:30:00Z") }));
    expect(late).toMatchObject({ allowed: false });
    expect(late.allowed === false && late.reason).toContain("21:00 WAT");

    // 07:30 WAT is 06:30 UTC.
    expect(mayCall(facts({ now: new Date("2026-08-08T06:30:00Z") }))).toMatchObject({ allowed: false });
  });

  it("allows the first and last permitted hours", () => {
    // 08:00 WAT = 07:00 UTC, inclusive. 19:59 WAT = 18:59 UTC, still inside.
    expect(mayCall(facts({ now: new Date("2026-08-08T07:00:00Z") }))).toEqual({ allowed: true });
    expect(mayCall(facts({ now: new Date("2026-08-08T18:59:00Z") }))).toEqual({ allowed: true });
    // 20:00 WAT = 19:00 UTC, exclusive.
    expect(mayCall(facts({ now: new Date("2026-08-08T19:00:00Z") }))).toMatchObject({ allowed: false });
  });

  it("lets a tenant narrow the window but reports the one in force", () => {
    const verdict = mayCall(facts({ now: new Date("2026-08-08T16:30:00Z"), latestHour: 17 }));
    expect(verdict).toMatchObject({ allowed: false });
    expect(verdict.allowed === false && verdict.reason).toContain("allowed 8-17");
  });
});

describe("an organisation's own consent policy", () => {
  it("lets a tenant calling its own customers do so without a per-number record", () => {
    // An insurer ringing a policyholder about their renewal is not relying on marketing
    // consent and should not have to manufacture a record to say so.
    expect(mayCall(facts({ consent: null, policy: "existing_relationship" }))).toEqual({
      allowed: true,
    });
  });

  it("still refuses without a record under the default policy", () => {
    expect(mayCall(facts({ consent: null, policy: "per_number" }))).toMatchObject({
      allowed: false,
    });
    // Absent policy behaves as the strictest, so a missing column cannot loosen anything.
    expect(mayCall(facts({ consent: null }))).toMatchObject({ allowed: false });
  });

  it("never lets any policy override a do-not-call entry", () => {
    // The line that must hold: a tenant chooses its lawful basis, not whether the check
    // applies. Suppression is not theirs to switch off.
    for (const policy of ["per_number", "existing_relationship"] as const) {
      expect(mayCall(facts({ suppressed: true, policy })), policy).toMatchObject({
        allowed: false,
      });
    }
  });

  it("honours an explicit withdrawal even under a standing relationship", () => {
    // "Stop calling me" is more specific than "we have a relationship".
    expect(
      mayCall(
        facts({
          policy: "existing_relationship",
          consent: { grantedAt: granted.grantedAt, revokedAt: new Date("2026-06-01T00:00:00Z") },
        }),
      ),
    ).toMatchObject({ allowed: false });
  });

  it("lets a tenant narrow the calling window", () => {
    // 16:30 WAT, tenant closes at 16:00.
    expect(
      mayCall(facts({ now: new Date("2026-08-08T15:30:00Z"), latestHour: 16 })),
    ).toMatchObject({ allowed: false });
  });

  it("does not let a tenant widen it", () => {
    // 22:00 WAT with a tenant asking to call until midnight, and 06:00 WAT with one
    // asking to start at dawn. Both are choices about someone else's day.
    expect(
      mayCall(facts({ now: new Date("2026-08-08T21:00:00Z"), latestHour: 24, earliestHour: 0 })),
    ).toMatchObject({ allowed: false });
    expect(
      mayCall(facts({ now: new Date("2026-08-08T05:00:00Z"), earliestHour: 0 })),
    ).toMatchObject({ allowed: false });
  });
});
