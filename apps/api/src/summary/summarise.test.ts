import { describe, expect, it } from "vitest";

import {
  buildSummaryPrompt,
  EMPTY,
  parseSummary,
  PROMPT_VERSION,
  type SummaryLine,
} from "./summarise";

/**
 * The grounding rule, which is the whole point of this module (slice 6).
 *
 * A summary is the first model output here that is written down and read later by somebody who
 * was not on the call. The prompt asks for citations; these check that asking is not what makes
 * it true — a sentence that cannot be pointed at is dropped by code, whatever the model says.
 */
const LINES: readonly SummaryLine[] = [
  { id: "11", speaker: "agent", text: "Good day, Oakhaven Properties." },
  { id: "12", speaker: "caller", text: "I am calling about the flat on Adeola Odeku." },
  { id: "13", speaker: "agent", text: "Thursday at half past three?" },
  { id: "14", speaker: "caller", text: "Yes, that works." },
];

const reply = (sentences: unknown): string => JSON.stringify({ sentences });

describe("what the model is asked", () => {
  it("shows every line with the id it must cite", () => {
    const prompt = buildSummaryPrompt(LINES);
    expect(prompt).toContain("[12] Caller: I am calling about the flat on Adeola Odeku.");
    expect(prompt).toContain("[11] Agent: Good day, Oakhaven Properties.");
  });

  it("has a version, so a batch written by one wording can be found", () => {
    expect(PROMPT_VERSION).toBeGreaterThan(0);
  });
});

describe("what survives grounding", () => {
  it("keeps a sentence whose citations all land", () => {
    const summary = parseSummary(
      reply([{ text: "She asked about the Adeola Odeku flat.", cites: ["12"] }]),
      LINES,
    );
    expect(summary.summary).toBe("She asked about the Adeola Odeku flat.");
    expect(summary.cites).toEqual([["12"]]);
  });

  it("drops a sentence citing a line this call does not have", () => {
    /* The shape a hallucination takes. The invented id is the tell, and the sentence around it
       cannot be trusted either — so the whole sentence goes, not just the citation. */
    const summary = parseSummary(
      reply([
        { text: "She asked about the flat.", cites: ["12"] },
        { text: "She agreed to pay a deposit.", cites: ["99"] },
      ]),
      LINES,
    );
    expect(summary.summary).toBe("She asked about the flat.");
    expect(summary.cites).toEqual([["12"]]);
  });

  it("drops a sentence that is partly invented", () => {
    // One real id does not launder a made-up one beside it.
    expect(parseSummary(reply([{ text: "…", cites: ["12", "99"] }]), LINES)).toEqual(EMPTY);
  });

  it("drops a sentence with no citation at all", () => {
    expect(parseSummary(reply([{ text: "The call went well.", cites: [] }]), LINES)).toEqual(EMPTY);
    expect(parseSummary(reply([{ text: "The call went well." }]), LINES)).toEqual(EMPTY);
  });

  it("stops after four sentences, where a model starts inventing", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ text: `Sentence ${i}.`, cites: ["12"] }));
    const summary = parseSummary(reply(many), LINES);
    expect(summary.cites).toHaveLength(4);
    expect(summary.summary).toBe("Sentence 0. Sentence 1. Sentence 2. Sentence 3.");
  });

  it("reads JSON a model wrapped in prose", () => {
    const body = reply([{ text: "She asked about the flat.", cites: ["12"] }]);
    expect(parseSummary(`Here you go:\n\n${body}\n\nHope that helps.`, LINES).summary).toBe(
      "She asked about the flat.",
    );
  });

  it("returns nothing rather than something, when the reply is not usable", () => {
    /* Nothing is a legitimate answer, and the caller of this writes the deterministic fallback
       instead. Something invented would be worse than a blank card. */
    expect(parseSummary("", LINES)).toEqual(EMPTY);
    expect(parseSummary("I could not summarise this call.", LINES)).toEqual(EMPTY);
    expect(parseSummary("{ this is not json", LINES)).toEqual(EMPTY);
    expect(parseSummary(reply("not an array"), LINES)).toEqual(EMPTY);
    expect(parseSummary(reply([null, 7, "text"]), LINES)).toEqual(EMPTY);
  });

  it("produces nothing for a call with no lines, whatever the model says", () => {
    // Every citation is unresolvable when there is nothing to resolve against.
    expect(parseSummary(reply([{ text: "A long chat about rent.", cites: ["12"] }]), [])).toEqual(
      EMPTY,
    );
  });
});
