import { describe, expect, it } from "vitest";

import { createSentenceBuffer } from "./sentences";

const feed = (tokens: readonly string[]): { spoken: string[]; tail: string } => {
  const buffer = createSentenceBuffer();
  const spoken: string[] = [];
  for (const t of tokens) spoken.push(...buffer.push(t));
  return { spoken, tail: buffer.flush() };
};

describe("createSentenceBuffer", () => {
  it("emits a sentence as soon as it completes, not at end of stream", () => {
    const buffer = createSentenceBuffer();

    expect(buffer.push("Your policy ")).toEqual([]);
    expect(buffer.push("renews in May. ")).toEqual(["Your policy renews in May."]);
  });

  it("handles a boundary that arrives as its own token", () => {
    expect(feed(["Hello there", ".", " How can I help?"]).spoken).toEqual([
      "Hello there.",
      "How can I help?",
    ]);
  });

  it("emits several sentences arriving in one token", () => {
    expect(feed(["One. Two! Three?"]).spoken).toEqual(["One.", "Two!", "Three?"]);
  });

  // A decimal point is not a sentence end. Splitting here would speak "one point" and
  // "five million naira" as two separate utterances with a gap between them.
  it("does not split inside a decimal number", () => {
    const { spoken, tail } = feed(["Your premium is 1.5 million naira"]);

    expect(spoken).toEqual([]);
    expect(tail).toBe("Your premium is 1.5 million naira");
  });

  it("does not split after a common abbreviation", () => {
    const { spoken, tail } = feed(["Please hold for Mr. Adeyemi"]);

    expect(spoken).toEqual([]);
    expect(tail).toBe("Please hold for Mr. Adeyemi");
  });

  it("returns the unterminated remainder on flush", () => {
    expect(feed(["All done. And one more thing"]).tail).toBe("And one more thing");
  });

  it("returns nothing on flush when the reply ended on a boundary", () => {
    expect(feed(["Complete."]).tail).toBe("");
  });

  it("never loses characters across a whole reply", () => {
    const tokens = ["Your ", "policy ", "AB417 ", "renews ", "in May. ", "Anything ", "else?"];
    const { spoken, tail } = feed(tokens);

    const rebuilt = [...spoken, tail].filter((s) => s.length > 0).join(" ");
    expect(rebuilt).toBe("Your policy AB417 renews in May. Anything else?");
  });
});
