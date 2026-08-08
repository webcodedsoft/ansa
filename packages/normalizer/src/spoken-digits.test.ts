import { describe, expect, it } from "vitest";

import { parseSpokenDigits } from "./spoken-digits";

describe("parseSpokenDigits", () => {
  it("reads digits dictated one at a time", () => {
    expect(parseSpokenDigits("four one seven")).toBe("417");
  });

  it("treats 'oh' as zero, which is how a Nigerian caller says it", () => {
    expect(parseSpokenDigits("oh eight one three")).toBe("0813");
    expect(parseSpokenDigits("nought nought seven")).toBe("007");
  });

  it("expands 'double' and 'triple'", () => {
    // British and Nigerian dictation; absent from American speech and easy to miss.
    expect(parseSpokenDigits("double four seven")).toBe("447");
    expect(parseSpokenDigits("triple eight")).toBe("888");
  });

  it("keeps a compound number together", () => {
    expect(parseSpokenDigits("twenty three")).toBe("23");
    expect(parseSpokenDigits("four seventeen")).toBe("417");
  });

  it("keeps letters, because a policy number is not only digits", () => {
    expect(parseSpokenDigits("A B four one seven")).toBe("AB417");
  });

  it("takes only the homophones that are not also ordinary words", () => {
    expect(parseSpokenDigits("niner fife tu")).toBe("952");
  });

  it("never turns ordinary speech into a number", () => {
    // The reason "to", "for" and "ate" are not in the homophone table: they are the
    // ones a transcriber really does produce, and also the ones that appear in every
    // other sentence. Corrupting real speech is worse than missing a dictated digit,
    // which readback catches anyway.
    for (const said of [
      "I would like to renew my cover please",
      "I have to call you back",
      "oh, I see",
      "that is what I paid for",
      "a moment please",
    ]) {
      expect(parseSpokenDigits(said)).toBeNull();
    }
  });

  it("still reads a zero said as 'oh' when the run is unambiguous", () => {
    expect(parseSpokenDigits("oh eight one three")).toBe("0813");
  });

  it("accepts digits the transcriber already resolved", () => {
    expect(parseSpokenDigits("my number is 08138178550")).toBe("08138178550");
  });

  it("takes the longest run, not the first", () => {
    // The caller's preamble is number-ish too; the value is what they laboured over.
    expect(parseSpokenDigits("for my one policy, the number is four one seven two nine")).toBe(
      "41729",
    );
  });

  it("ignores a hyphen the transcriber inserted", () => {
    expect(parseSpokenDigits("twenty-three")).toBe("23");
  });

  it("returns null when there is no value at all", () => {
    expect(parseSpokenDigits("I would like to renew my cover please")).toBeNull();
    expect(parseSpokenDigits("")).toBeNull();
  });

  it("does not invent a digit from a dangling 'double'", () => {
    expect(parseSpokenDigits("double")).toBeNull();
  });
});

describe("parseSpokenDigits contractions", () => {
  it("does not turn an apostrophe into a letter in the reference", () => {
    // "No, it's four one eight" was captured as S418 before the apostrophe closed up.
    expect(parseSpokenDigits("No, it's four one eight")).toBe("418");
    expect(parseSpokenDigits("that's nine nine two")).toBe("992");
  });
});
