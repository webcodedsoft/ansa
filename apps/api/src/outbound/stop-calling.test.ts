import { describe, expect, it } from "vitest";

import { asksToNotBeCalled } from "./stop-calling";

/**
 * The asymmetry runs through all of this.
 *
 * A false positive costs one customer one call that never happens. A false negative is
 * somebody rung again after asking us not to be — a regulatory breach, and the thing people
 * complain about publicly. So the cases below lean toward recording, and the ones that must
 * NOT record are the ones where the caller has not actually asked for anything.
 */

describe("hearing somebody ask not to be called again", () => {
  it("takes the plain instructions", () => {
    for (const said of [
      "Please don't call me again.",
      "Stop calling me.",
      "Take me off your list.",
      "Remove my number.",
      "Never call me again!",
      "I want to opt me out",
    ]) {
      expect(asksToNotBeCalled(said)).toBe(true);
    }
  });

  it("hears it in Pidgin", () => {
    // Callers switch register mid-sentence, and this is the register somebody uses when
    // they have had enough. Missing it is the same breach as missing the English.
    expect(asksToNotBeCalled("Abeg no call me again.")).toBe(true);
    expect(asksToNotBeCalled("Make you no call me again o")).toBe(true);
  });

  it("survives the words people put in the middle", () => {
    expect(asksToNotBeCalled("Don't ever ring me again.")).toBe(true);
    expect(asksToNotBeCalled("Please stop phoning this number, ever.")).toBe(true);
  });

  it("finds the instruction inside a longer sentence", () => {
    expect(asksToNotBeCalled("I'm not interested, take me off your list, thanks.")).toBe(true);
  });

  it("does not mistake a complaint for an instruction", () => {
    /* Both carry every word, and neither asks for anything. Suppressing a customer who was
       telling you about their week is a customer you then never reach again. */
    for (const said of [
      "You keep calling me about this.",
      "Somebody called me again yesterday.",
      "You've already called me twice today.",
    ]) {
      expect(asksToNotBeCalled(said)).toBe(false);
    }
  });

  it("still records when the complaint and the instruction are in one sentence", () => {
    // The half that asks is what matters, whatever the other half says.
    expect(asksToNotBeCalled("You keep calling me and I want you to take me off your list")).toBe(
      true,
    );
  });

  it("does not confuse asking for a person with asking to be left alone", () => {
    /* These read alike and mean opposite things. Putting "get me a manager" on a permanent
       suppression list is the worse of the two mistakes this file can make. */
    for (const said of [
      "Can I speak to a person?",
      "Put me through to somebody.",
      "I want to talk to your manager.",
      "Call me back tomorrow.",
      "Can you call me on my other number?",
    ]) {
      expect(asksToNotBeCalled(said)).toBe(false);
    }
  });

  it("says nothing about an empty transcript", () => {
    expect(asksToNotBeCalled("")).toBe(false);
    expect(asksToNotBeCalled("   ")).toBe(false);
  });
});
