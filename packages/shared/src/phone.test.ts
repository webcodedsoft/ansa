import { describe, expect, it } from "vitest";

import { asDialled, sameNumber, toE164 } from "./phone";

/**
 * One number, one person (plan slice 1).
 *
 * The console normalised on add and import; the call path stored whatever the carrier sent.
 * Every caller ID on record today is already E.164, so what these pin down is the guard: the
 * day a carrier presents a national number, it must resolve to the person we already know
 * rather than mint a second one.
 */
describe("turning a number into the form we dial", () => {
  it("passes E.164 through, however it was punctuated", () => {
    expect(toE164("+2348030000001")).toBe("+2348030000001");
    expect(toE164("+234 803 000 0001")).toBe("+2348030000001");
    expect(toE164("+234-803-000-0001")).toBe("+2348030000001");
    expect(toE164(" (+234) 803.000.0001 ")).toBe("+2348030000001");
  });

  it("reads a Nigerian national number as the same number", () => {
    expect(toE164("08030000001")).toBe("+2348030000001");
    expect(toE164("0803 000 0001")).toBe("+2348030000001");
    // Every mobile prefix, and nothing else.
    expect(toE164("07030000001")).toBe("+2347030000001");
    expect(toE164("09030000001")).toBe("+2349030000001");
    expect(toE164("01234567890")).toBeNull();
  });

  it("reads a bare 234… as the same number missing its plus", () => {
    expect(toE164("2348030000001")).toBe("+2348030000001");
  });

  it("is not Nigeria-only, because a handoff destination need not be", () => {
    expect(toE164("+18148592625")).toBe("+18148592625");
    expect(toE164("+442079460958")).toBe("+442079460958");
  });

  it("says null rather than guessing", () => {
    expect(toE164("")).toBeNull();
    expect(toE164("not a number")).toBeNull();
    expect(toE164("0803000000")).toBeNull(); // a digit short
    expect(toE164("080300000012")).toBeNull(); // a digit long
    expect(toE164("+0803000001")).toBeNull(); // E.164 never starts +0
    // Letters are not a number with punctuation in it.
    expect(toE164("ABC-DEF-GHIJ")).toBeNull();
  });
});

describe("what the call path stores", () => {
  it("canonicalises what it recognises", () => {
    expect(asDialled("08030000001")).toBe("+2348030000001");
    expect(asDialled("+234 803 000 0001")).toBe("+2348030000001");
  });

  it("keeps a shape it does not recognise exactly as the carrier sent it", () => {
    /* A caller ID is evidence. Mangling an odd one into a valid number would file a call
       under somebody who was never on it; dropping it would hide what the carrier said. */
    expect(asDialled("anonymous")).toBe("anonymous");
    expect(asDialled("SIP/12345")).toBe("SIP/12345");
  });

  it("leaves a withheld number withheld", () => {
    expect(asDialled(null)).toBeNull();
    expect(asDialled("")).toBeNull();
    expect(asDialled("   ")).toBeNull();
  });
});

describe("whether two spellings are one person", () => {
  it("matches across all three forms", () => {
    expect(sameNumber("08030000001", "+2348030000001")).toBe(true);
    expect(sameNumber("2348030000001", "0803 000 0001")).toBe(true);
  });

  it("does not match two different numbers", () => {
    expect(sameNumber("08030000001", "08030000002")).toBe(false);
  });

  it("never merges two records on a value that is not a number", () => {
    /* Equal strings that are not numbers must not read as the same person, or every contact
       with a blank or malformed number collapses into one. */
    expect(sameNumber("anonymous", "anonymous")).toBe(false);
    expect(sameNumber("", "")).toBe(false);
    expect(sameNumber(null, null)).toBe(false);
    expect(sameNumber(null, "+2348030000001")).toBe(false);
  });
});
