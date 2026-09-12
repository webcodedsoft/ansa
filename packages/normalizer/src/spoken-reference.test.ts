import { describe, expect, it } from "vitest";

import { sayDigits, sayReference } from "./digits";

/**
 * Reading a reference back so a wrong letter is heard as wrong.
 *
 * On the call this was written from, "FST901EE" came back from the transcriber as
 * "SST901EE", was read back as "S, S, T, nine oh one, E, E", and the caller agreed —
 * because on an 8kHz line F and S sound the same both ways. A word per letter is the
 * difference between a readback that checks and one that repeats the mistake.
 */
describe("saying a reference back", () => {
  it("says a letter with its word, and digits as digits", () => {
    expect(sayReference("FST901EE")).toBe("F for Fish, S for Sun, T for Table, nine oh one, E for Egg, E for Egg");
  });

  it("reads a digits-only reference exactly as digits are read", () => {
    expect(sayReference("2901")).toBe(sayDigits("2901"));
    expect(sayReference("08138178550")).toBe(sayDigits("08138178550"));
  });

  it("ignores punctuation and case, and says nothing for nothing", () => {
    expect(sayReference("ab-12")).toBe("A for Apple, B for Ball, one two");
    expect(sayReference("--")).toBe("");
  });
});
