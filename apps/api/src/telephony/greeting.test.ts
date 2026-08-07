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
