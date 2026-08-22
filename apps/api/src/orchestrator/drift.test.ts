import { describe, expect, it } from "vitest";

import { driftIn } from "./drift";

/**
 * This changes nothing the caller hears — the normalizer already strips the formatting and
 * the budget already caps the words. So the tests are about whether the *signal* is
 * trustworthy, and the expensive mistake is a false one: a drift count that fires on
 * ordinary replies tells somebody to rewrite a prompt that was working.
 */

describe("replies that got too long", () => {
  it("allows the one or two the prompt asks for, and the three it tolerates", () => {
    expect(driftIn("It's out for delivery.").drifted).toBe(false);
    expect(driftIn("It's out for delivery. Should reach you today.").drifted).toBe(false);
    expect(driftIn("Right. It's out for delivery. Should reach you today.").drifted).toBe(false);
  });

  it("flags the fourth", () => {
    const signals = driftIn("One. Two. Three. Four.");
    expect(signals.sentences).toBe(4);
    expect(signals.tooLong).toBe(true);
  });

  it("counts a long single sentence as one", () => {
    /* Length in sentences, not words — the word cap is `turn-budget`'s job and duplicating
       it here would report the same turn twice under two names. */
    expect(driftIn("It is out for delivery and should reach you today, some time before six")
      .tooLong).toBe(false);
  });

  it("is not fooled by trailing punctuation or whitespace", () => {
    expect(driftIn("Done.   ").sentences).toBe(1);
    expect(driftIn("Really?!").sentences).toBe(1);
    expect(driftIn("   ").drifted).toBe(false);
  });
});

describe("things that only make sense on a screen", () => {
  it("flags markdown the model was told not to use", () => {
    for (const reply of ["That's **important**.", "Use `policy_lookup`.", "# Heading"]) {
      expect(driftIn(reply).screenFormatting).toBe(true);
    }
  });

  it("flags bullets and numbered lists", () => {
    expect(driftIn("- standard\n- premium").screenFormatting).toBe(true);
    expect(driftIn("1. standard\n2. premium").screenFormatting).toBe(true);
  });

  it("flags links and emoji", () => {
    expect(driftIn("See [our site](https://example.com).").screenFormatting).toBe(true);
    expect(driftIn("All set \u{1F389}").screenFormatting).toBe(true);
  });

  it("leaves ordinary speech alone", () => {
    /* The expensive direction. A dash, an apostrophe, a decimal point and a naira figure
       are all things an agent says constantly, and none is drift. */
    for (const reply of [
      "It renews in May — the eighth, I think.",
      "That's one thousand five hundred naira, fifty kobo.",
      "Your reference is O R D, four four seven one.",
      "Sorry, could you say that again?",
    ]) {
      expect(driftIn(reply).screenFormatting).toBe(false);
    }
  });

  it("does not compare the text against its spoken form", () => {
    /* The obvious implementation was diffing against `forSpeech`, which expands numbers —
       so every reply carrying a figure would have reported as drift. */
    expect(driftIn("Your balance is 12000 naira.").drifted).toBe(false);
  });
});

describe("what the caller is told", () => {
  it("reports both signals together so one branch covers them", () => {
    const signals = driftIn("- one\n- two\n- three\n- four\n- five.");
    expect(signals.drifted).toBe(true);
    expect(signals.screenFormatting).toBe(true);
  });

  it("says nothing drifted on an empty reply", () => {
    expect(driftIn("")).toEqual({
      sentences: 0,
      tooLong: false,
      screenFormatting: false,
      drifted: false,
    });
  });
});
