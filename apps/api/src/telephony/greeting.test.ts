import { describe, expect, it } from "vitest";

import { forSpeech, GREETING_TEXT, outboundOpener } from "./greeting";

describe("the greeting", () => {
  it("hands over to the caller, so they know it is their turn", () => {
    expect(GREETING_TEXT.trimEnd().endsWith("?")).toBe(true);
  });

  it("says the brand name, which is the point of speaking it at all (PRD §1.0)", () => {
    expect(GREETING_TEXT).toBe("Thank you for calling Ansa. How can I help you?");
  });
});

/**
 * Read from a real call before this existed.
 *
 * Oakhaven's greeting — "Oakhaven Properties, good day. Are you calling about a property to
 * rent, to buy, or something else?" — was spoken on an outbound call, to somebody the agent
 * had just dialled. Their first words back were "Yeah, look at that." They had been asked to
 * explain a call they did not make, and the three minutes after it never recovered.
 */
describe("what an outbound call opens with", () => {
  it("says who is calling, because that is the question they are already asking", () => {
    expect(outboundOpener("Oakhaven Properties")).toContain("Oakhaven Properties");
  });

  it("says that we rang them, which no inbound greeting ever has to", () => {
    expect(outboundOpener("Oakhaven Properties")).toContain("calling");
  });

  it("never asks the caller why they rang, which is the bug it exists for", () => {
    const spoken = outboundOpener("Oakhaven Properties").toLowerCase();
    expect(spoken).not.toContain("are you calling about");
    expect(spoken).not.toContain("how can i help");
  });

  it("offers a way out, since consent to be called is not consent to talk now", () => {
    expect(outboundOpener("Oakhaven Properties")).toContain("good time");
  });

  it("hands over on a question, so end-of-turn has a clause to commit against", () => {
    expect(outboundOpener("Oakhaven Properties").trimEnd().endsWith("?")).toBe(true);
  });

  it("does not say 'this is  calling' when the name is empty", () => {
    /* Unreachable through the product — `agents.name` is not null — but the argument is a
       string, so the failure would be heard by a caller rather than caught by a type. */
    const spoken = outboundOpener("   ");
    expect(spoken).not.toMatch(/is\s{2,}calling/);
    expect(spoken.trimEnd().endsWith("?")).toBe(true);
  });

  it("is not the inbound greeting", () => {
    expect(outboundOpener("Ansa")).not.toBe(GREETING_TEXT);
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
