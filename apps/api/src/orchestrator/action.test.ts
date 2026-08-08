import { describe, expect, it } from "vitest";

import { classify } from "./action";
import { normalise } from "./hearing";

const of = (text: string) => classify(normalise(text));

describe("classify", () => {
  // The pair the whole design exists for: same code path, opposite budgets.
  it("separates a yes/no question from a request for an explanation", () => {
    expect(of("Is my policy still active?")).toBe("polar");
    expect(of("How do I make a claim?")).toBe("explanation");
  });

  // Most polar questions in real speech are declaratives with no auxiliary inversion,
  // so a "starts with do/is/can" test would catch the minority and miss the common form.
  it.each([
    "So my policy is still active.",
    "You said it renews in May.",
    "My cover is still on, right?",
    "Yes please.",
    "That one.",
  ])("treats the short declarative %j as polar", (text) => {
    expect(of(text)).toBe("polar");
  });

  it.each([
    "How do I make a claim?",
    "What happens if I miss a payment?",
    "Walk me through the renewal.",
    "Can you explain the excess to me?",
    "Tell me about my policy.",
    "What do I need to renew?",
  ])("treats %j as an explanation", (text) => {
    expect(of(text)).toBe("explanation");
  });

  it.each([
    "When does my policy renew?",
    "How much is my premium?",
    "Who is my underwriter?",
  ])("treats %j as a single-fact question", (text) => {
    expect(of(text)).toBe("wh");
  });

  it("treats a number being read out as a readback", () => {
    expect(of("My policy number is 85932514.")).toBe("readback");
  });

  // A caller reading a number aloud produces words, not digits. Missing this meant every
  // spoken number on a live call was typed as a short question and answered rather than
  // read back, so the caller repeated it three times.
  it.each([
    "eight five nine two six two five",
    "Okay so if I put the number I use, eight five nine two six two five",
    "It is zero eight one three, eight one seven",
  ])("treats the spoken number %j as a readback", (text) => {
    expect(of(text)).toBe("readback");
  });

  it("does not mistake an ordinary sentence with one number for a readback", () => {
    expect(of("I have one policy with you")).not.toBe("readback");
  });

  it("recognises a caller reporting a problem rather than asking anything", () => {
    expect(
      of(
        "I have been trying since last week and nobody has called me back about this " +
          "claim and it is still not resolved at all",
      ),
    ).toBe("troubles");
  });

  it("recognises greetings and closings", () => {
    expect(of("Good evening")).toBe("greeting");
    expect(of("How far")).toBe("greeting");
    expect(of("Thank you")).toBe("closing");
    expect(of("That's all")).toBe("closing");
  });

  it("falls back to statement for a long turn with no question in it", () => {
    expect(
      of(
        "I was calling because my brother told me you people handle this kind of thing " +
          "and he gave me this number to try today",
      ),
    ).toBe("statement");
  });

  it("handles Pidgin question forms", () => {
    expect(of("Wetin be my balance?")).toBe("wh");
  });

  it("never throws on empty or odd input", () => {
    expect(of("")).toBe("statement");
    expect(of("   ")).toBe("statement");
  });
});

describe("requests are not yes/no questions", () => {
  it("gives a request room to be answered", () => {
    // 2026-08-08, live call. Nine words, fell through to polar, answered in five.
    expect(classify("i want you to definitely take my policy number")).toBe("statement");
    expect(classify("i need to renew my cover")).toBe("statement");
    expect(classify("i am calling about my premium")).toBe("statement");
  });

  it("still treats a real short question as polar", () => {
    expect(classify("is my policy still active")).toBe("polar");
    expect(classify("can you hear me")).toBe("polar");
  });
});
