import { describe, expect, it } from "vitest";

import { closestOption } from "./choice-match";

/**
 * The listed answers from a real front desk, and the things callers actually said to it.
 * The refusals matter as much as the matches: a guess between "renew my policy" and "cancel
 * or change my policy" would send a caller to the wrong desk with nothing to show for it.
 */
const OPTIONS = [
  "make a claim",
  "get new cover",
  "renew my policy",
  "pay a premium",
  "cancel or change my policy",
  "a complaint",
];

describe("hearing a listed answer in what the caller said", () => {
  it("takes the answer said whole, whatever the case", () => {
    expect(closestOption(OPTIONS, "Make A Claim")).toBe("make a claim");
  });

  it("takes the answer inside a longer sentence", () => {
    expect(closestOption(OPTIONS, "I'd like to make a claim, please")).toBe("make a claim");
    expect(closestOption(OPTIONS, "it's about a complaint")).toBe("a complaint");
  });

  it("takes a shorter way of saying one answer", () => {
    expect(closestOption(OPTIONS, "I want to renew")).toBe("renew my policy");
    expect(closestOption(OPTIONS, "cancel my policy")).toBe("cancel or change my policy");
    expect(closestOption(OPTIONS, "I want to pay")).toBe("pay a premium");
    expect(closestOption(OPTIONS, "new cover")).toBe("get new cover");
  });

  /** The call that started this: three answers say "policy", and none of them is "details". */
  it("says none of these rather than guessing between answers that share a word", () => {
    expect(closestOption(OPTIONS, "I want to get my policy details")).toBeNull();
    expect(closestOption(OPTIONS, "my policy")).toBeNull();
  });

  it("says none of these for something unrelated, and for nothing", () => {
    expect(closestOption(OPTIONS, "what are your opening hours")).toBeNull();
    expect(closestOption(OPTIONS, "")).toBeNull();
    expect(closestOption(OPTIONS, "um, well, please")).toBeNull();
  });

  it("is not fooled by an answer that is only noise words", () => {
    expect(closestOption(["a", "the other one"], "I want the one")).toBeNull();
  });
});
