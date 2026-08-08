import { describe, expect, it } from "vitest";

import { forSpeech, GREETING_TEXT } from "./greeting";

describe("the greeting", () => {
  it("hands over to the caller, so they know it is their turn", () => {
    expect(GREETING_TEXT.trimEnd().endsWith("?")).toBe(true);
  });

  it("says the brand name, which is the point of speaking it at all (PRD §1.0)", () => {
    expect(GREETING_TEXT).toBe("Thank you for calling Ansa. How can I help you?");
  });
});

describe("forSpeech", () => {
  // Confirmed on a real call: at 8kHz μ-law "Ansa" is heard as "Anza", because /s/ lives
  // above the telephony passband. The respelling is what makes it survive.
  it("respells the brand name for the telephone channel", () => {
    expect(forSpeech(GREETING_TEXT)).toBe("Thank you for calling An-Sah. How can I help you?");
  });

  it("leaves the written brand name untouched, so transcripts stay honest", () => {
    // If the workaround leaked into what we record as having been said, every
    // transcript, eval corpus entry and WER score would inherit it.
    expect(GREETING_TEXT).toContain("Ansa");
    expect(GREETING_TEXT).not.toContain("An-Sah");
  });

  it("respells every occurrence, not just the first", () => {
    expect(forSpeech("Ansa here. This is Ansa.")).toBe("An-Sah here. This is An-Sah.");
  });

  it("leaves words that merely contain the letters alone", () => {
    expect(forSpeech("The answer is Ansa.")).toBe("The answer is An-Sah.");
  });

  it("passes through text without the brand name", () => {
    expect(forSpeech("Your policy renews in May.")).toBe("Your policy renews in May.");
  });
});

describe("forSpeech markdown stripping", () => {
  // The model emits markdown despite the prompt. A caller must never hear punctuation
  // read as words, and CLAUDE.md is explicit that nothing reaches TTS unnormalized.
  it("strips emphasis rather than speaking it", () => {
    expect(forSpeech("Your premium is **unchanged**.")).toBe("Your premium is unchanged.");
  });

  it("strips list markers", () => {
    expect(forSpeech("- Your policy renews in May")).toBe("Your policy renews in May");
  });

  it("says a decimal quantity rather than leaving the caller to read it", () => {
    // This asserted the opposite until the normalizer existed: forSpeech used to leave
    // "1.5" alone, and a caller heard the TTS engine's guess at it.
    expect(forSpeech("It's 1.5 million naira, isn't it?")).toBe(
      "It's one point five million naira, isn't it?",
    );
  });
});
