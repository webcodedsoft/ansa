import { describe, expect, it } from "vitest";

import {
  campaignCallCannotOpen,
  forSpeech,
  GREETING_TEXT,
  outboundOpener,
  withRecordingNotice,
} from "./greeting";

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

describe("what a campaign call opens with", () => {
  /* The rule in `prompts/outbound.ts` is who, which company and why, before anything else.
     The first line is synthesised before the model has a turn, so if the reason is not in it
     the person is asked "is now a good time?" for something they have not been told, and the
     model invents the wording a turn later. */
  const reason = {
    purpose: "to confirm your viewing at {property} on {date}",
    opening: null,
    facts: { property: "14 Adeola Odeku", date: "Tuesday at two" },
  };

  it("says who, that we rang, and why, in the first line", () => {
    const spoken = outboundOpener("Oakhaven Properties", reason);
    expect(spoken).toBe(
      "Good day, this is Oakhaven Properties calling to confirm your viewing at 14 Adeola Odeku on Tuesday at two. Is now a good time?",
    );
  });

  it("still offers the way out, on a question", () => {
    const spoken = outboundOpener("Oakhaven Properties", reason);
    expect(spoken).toContain("good time");
    expect(spoken.trimEnd().endsWith("?")).toBe(true);
  });

  it("does not stack a full stop from the purpose against its own", () => {
    const spoken = outboundOpener("Oakhaven Properties", { ...reason, purpose: "to confirm your viewing." });
    expect(spoken).not.toContain("..");
    expect(spoken).toContain("viewing. Is now");
  });

  it("speaks the operator's own first line verbatim when they wrote one", () => {
    const spoken = outboundOpener("Oakhaven Properties", {
      ...reason,
      opening: "Hello, it's Oakhaven here about {property} — have you got a minute?",
    });
    expect(spoken).toBe("Hello, it's Oakhaven here about 14 Adeola Odeku — have you got a minute?");
  });

  it("falls back to the generic line when the reason is empty, rather than 'calling . Is'", () => {
    const spoken = outboundOpener("Oakhaven Properties", { purpose: "  ", opening: null, facts: null });
    expect(spoken).toBe("Good day, this is Oakhaven Properties calling. Is now a good time?");
  });

  it("leaves a fact it does not have in braces rather than dropping the clause", () => {
    /* The braces are audible and wrong, and that is the point: a list missing a column should
       be heard on the first test call, not silently spoken around. `mergeFacts` decides this;
       the opener must not undo it. */
    const spoken = outboundOpener("Oakhaven Properties", { ...reason, facts: null });
    expect(spoken).toContain("{property}");
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

describe("a campaign call with nothing to say", () => {
  /* Before this, a null brief on a campaign call went ahead with no campaign layer at all: the
     agent rang a member of the public and the model made up why. Hanging up is the least bad
     thing that can happen, and it must never catch a test call or an inbound one. */
  it("is hung up when the brief could not be read", () => {
    expect(campaignCallCannotOpen({ direction: "outbound", campaignId: "cp-1", brief: null })).toBe(
      "brief unreadable or not this organisation's",
    );
  });

  it("is hung up when the purpose is blank", () => {
    expect(
      campaignCallCannotOpen({ direction: "outbound", campaignId: "cp-1", brief: { purpose: "   " } }),
    ).toBe("purpose is empty");
  });

  it("goes ahead when there is a reason", () => {
    expect(
      campaignCallCannotOpen({ direction: "outbound", campaignId: "cp-1", brief: { purpose: "to confirm" } }),
    ).toBeNull();
  });

  it("never touches a test call, which has no campaign", () => {
    expect(campaignCallCannotOpen({ direction: "outbound", campaignId: null, brief: null })).toBeNull();
  });

  it("never touches an inbound call", () => {
    expect(campaignCallCannotOpen({ direction: "inbound", campaignId: null, brief: null })).toBeNull();
  });
});

describe("telling a caller they are recorded", () => {
  /* An organisation that records does not get to choose whether the caller is told. The
     disclosure is what makes holding somebody's voice defensible, and a settable one would be
     the first setting turned off. */
  it("says nothing at all when the organisation does not record", () => {
    expect(withRecordingNotice(GREETING_TEXT, false)).toBe(GREETING_TEXT);
    expect(withRecordingNotice("Good day, this is Oakhaven calling.", false)).toBe(
      "Good day, this is Oakhaven calling.",
    );
  });

  it("adds it after the greeting, not before", () => {
    /* "This call is recorded. Thank you for calling" opens on a warning. A person would greet
       you first, and the caller still hears it before saying anything worth recording. */
    const said = withRecordingNotice(GREETING_TEXT, true);
    expect(said.startsWith(GREETING_TEXT)).toBe(true);
    expect(said).toBe(`${GREETING_TEXT} This call is recorded.`);
  });

  it("does not double a full stop, or leave a sentence run on", () => {
    expect(withRecordingNotice("Is now a good time?", true)).toBe(
      "Is now a good time? This call is recorded.",
    );
    expect(withRecordingNotice("Good day", true)).toBe("Good day. This call is recorded.");
    expect(withRecordingNotice("Good day.   ", true)).toBe("Good day. This call is recorded.");
    expect(withRecordingNotice("Good day.", true)).not.toContain("..");
  });
});
