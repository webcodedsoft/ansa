import type { SummarisableLine } from "@ansa/db";
import { describe, expect, it } from "vitest";

import { withoutAModel } from "./call-summary.sweeper";

/**
 * The account written when the model cannot be reached (slice 6).
 *
 * Not a placeholder and not an apology. A blank card tells a reader nothing, and waiting for a
 * model that is down means the summary arrives days later beside a call nobody is looking at.
 * What it must never do is say something the call does not: every sentence here is a caller's
 * own line, cited, exactly as the model's output has to be.
 */
const line = (id: string, speaker: "caller" | "agent", text: string): SummarisableLine => ({
  id,
  speaker,
  text,
});

describe("summarising without a model", () => {
  it("leads with what they rang about, and cites it", () => {
    const summary = withoutAModel([
      line("1", "agent", "Good day, Oakhaven Properties."),
      line("2", "caller", "I am calling about the flat on Adeola Odeku."),
      line("3", "agent", "Thursday at half past three?"),
      line("4", "caller", "Yes, that works."),
    ]);

    expect(summary.summary).toContain("I am calling about the flat on Adeola Odeku.");
    expect(summary.summary).toContain("Yes, that works.");
    expect(summary.cites).toEqual([["2"], ["4"]]);
  });

  it("skips a pleasantry to find the first real thing said", () => {
    /* "Yes" and "Hello" are answers to the greeting, not the reason for the call. Three words
       is the same bar the handoff summary has always used. */
    const summary = withoutAModel([
      line("1", "agent", "Good day."),
      line("2", "caller", "Yes."),
      line("3", "caller", "I want to renew my lease please."),
    ]);
    expect(summary.summary).toContain("I want to renew my lease please.");
    expect(summary.cites[0]).toEqual(["3"]);
  });

  it("never quotes the agent back as though the caller said it", () => {
    // The agent's words are ours. A summary of what we said is not a summary of the call.
    expect(
      withoutAModel([
        line("1", "agent", "Good day, how may I help you today?"),
        line("2", "agent", "Are you still there?"),
      ]),
    ).toEqual({ summary: "", cites: [] });
  });

  it("says one thing when the caller only said one thing", () => {
    const summary = withoutAModel([line("7", "caller", "I need to change my viewing time.")]);
    expect(summary.cites).toEqual([["7"]]);
    expect(summary.summary).not.toContain("The last thing");
  });

  it("writes nothing rather than something for a call with no words", () => {
    expect(withoutAModel([])).toEqual({ summary: "", cites: [] });
  });

  it("cites every sentence it writes, with ids from this call", () => {
    /* The invariant the model's output is held to, held to here as well. A fallback exempt
       from grounding would be the one place an uncheckable claim could enter. */
    const lines = [
      line("11", "caller", "There is a leak in the kitchen ceiling."),
      line("12", "agent", "I will send someone."),
      line("13", "caller", "Thank you very much."),
    ];
    const summary = withoutAModel(lines);
    const ids = new Set(lines.map((one) => one.id));

    expect(summary.cites.length).toBeGreaterThan(0);
    for (const sentence of summary.cites) {
      expect(sentence.length).toBeGreaterThan(0);
      for (const id of sentence) expect(ids.has(id)).toBe(true);
    }
  });
});
