import { describe, expect, it } from "vitest";

import { guardOutput } from "./output-guard";

/**
 * Two rules with very different costs, and the tests are weighted accordingly.
 *
 * A missed banned phrase costs a slightly stiff call. A missed commitment claim is an agent
 * telling somebody their money has been refunded when it has not. But a *false* block is an
 * agent going quiet on a caller who asked a fair question, and there are more ways to write
 * that bug than the real one — so most of what follows is about what must still be spoken.
 */

const said = (sentence: string, toolRanThisTurn = false) =>
  guardOutput({ sentence, toolRanThisTurn });

describe("claiming to have done something", () => {
  it("blocks a completed action with no tool call behind it", () => {
    for (const claim of [
      "I've refunded that for you.",
      "I have cancelled the order.",
      "We've already processed the transfer.",
      "I've gone ahead and booked it.",
      "I've issued the credit.",
    ]) {
      expect(said(claim).kind).toBe("block");
    }
  });

  it("allows the same claim when a tool actually ran", () => {
    /* The whole basis of the rule. A turn that dispatched a tool has done something and may
       say so; the orchestrator knows which, and the model cannot influence it. */
    expect(said("I've cancelled the order.", true).kind).toBe("speak");
  });

  it("never blocks an offer", () => {
    /* "I'll cancel that" is what helping sounds like. An agent that cannot promise to do
       something is an agent that cannot do anything, and this is the false positive most
       likely to be written by accident. */
    for (const offer of [
      "I'll cancel that for you.",
      "I can refund that.",
      "We will process it today.",
      "I'm going to book it now.",
      "I could approve that, but let me check first.",
      "Once I've cancelled it you'll get a text.",
    ]) {
      expect(said(offer).kind).toBe("speak");
    }
  });

  it("does not block ordinary past-tense speech", () => {
    // Only the verbs that move money or change a record, and only about ourselves.
    for (const fine of [
      "I've checked and it's on its way.",
      "I've got your policy number.",
      "You cancelled it last week.",
      "They've refunded it already.",
      "I've looked at the account.",
    ]) {
      expect(said(fine).kind).toBe("speak");
    }
  });

  it("reads a curly apostrophe the same as a straight one", () => {
    // Models emit both, and a rule that only knows one is a rule with a trivial bypass.
    expect(said("I’ve refunded that.").kind).toBe("block");
  });
});

describe("the phrases that mean the prompt is losing", () => {
  it("flags them and still says them", () => {
    /* One "certainly" does not ruin a call. Blocking on it would silence an agent for being
       slightly stiff, which is a worse trade than the stiffness. */
    const outcome = said("Certainly, I'd be happy to help with that.");
    expect(outcome.kind).toBe("speak");
    expect(outcome.kind === "speak" && outcome.flagged).toEqual(
      expect.arrayContaining(["certainly", "i'd be happy to help"]),
    );
  });

  it("flags nothing in an ordinary sentence", () => {
    const outcome = said("It's out for delivery — should reach you today.");
    expect(outcome.kind === "speak" && outcome.flagged).toEqual([]);
  });

  it("matches regardless of punctuation and case", () => {
    const outcome = said("Rest assured! As I mentioned, it's fine.");
    expect(outcome.kind === "speak" && outcome.flagged).toEqual(
      expect.arrayContaining(["rest assured", "as i mentioned"]),
    );
  });
});
