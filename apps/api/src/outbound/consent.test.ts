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
