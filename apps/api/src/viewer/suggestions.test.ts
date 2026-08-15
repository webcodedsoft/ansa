import type { CorpusEntry } from "@ansa/db";
import { describe, expect, it } from "vitest";

import { BASE_KEYTERMS } from "../tenancy/defaults";
import { captureCases, keytermCandidates } from "./suggestions";

/**
 * What a correction is evidence for (R9.2.5).
 *
 * The property this file protects is mostly negative: nothing here writes, nothing here
 * applies, and the candidate list stays short enough that a human will actually read it.
 * A suggestion engine that emits every word of every corrected turn is not a feed, it is a
 * second transcript.
 */

let next = 1;
const pair = (heard: string, corrected: string, callId = `call-${next}`): CorpusEntry => {
  next += 1;
  return {
    transcriptId: String(next),
    callId,
    carrierCallId: `CA-${callId}`,
    offsetMs: 1_000,
    provider: "openai",
    confidence: 0.5,
    heard,
    corrected,
    correctedAt: new Date("2026-08-08T12:00:00Z"),
  };
};

describe("keyterm candidates", () => {
  it("suggests a word a reviewer put back on more than one call", () => {
    const candidates = keytermCandidates([
      pair("I want to renew my Anza cover", "I want to renew my Ansa cover", "one"),
      pair("Is Anza open", "Is Ansa open", "two"),
    ]);

    expect(candidates.map((c) => c.term)).toContain("Ansa");
    expect(candidates.find((c) => c.term === "Ansa")?.calls).toBe(2);
  });

  it("holds back a word seen on one call only", () => {
    // One mishearing is an anecdote. Boosting on one is how a list grows into the thing
    // `defaults.ts` measured damaging an adjacent name.
    expect(keytermCandidates([pair("Anza", "Ansa", "one")])).toEqual([]);
  });

  it("does not suggest a term the organization already carries, however it is capitalised", () => {
    const entries = [pair("naria", "naira", "one"), pair("naria", "naira", "two")];

    expect(keytermCandidates(entries)).not.toEqual([]);
    expect(keytermCandidates(entries, { known: ["NAIRA"] })).toEqual([]);
  });

  it("does not suggest the platform's own base vocabulary back to itself", () => {
    const entries = [pair("Anza", "Ansa", "one"), pair("Answer", "Ansa", "two")];
    expect(keytermCandidates(entries, { known: [...BASE_KEYTERMS] })).toEqual([]);
  });

  it("ignores the function words that move with every correction", () => {
    // A correction rewrites a whole turn, so the diff drags in every word around the one
    // that was wrong. Boosting "the" would be worse than useless.
    const entries = [
      pair("send it to them", "send it to underwriting", "one"),
      pair("it is with them", "it is with underwriting", "two"),
    ];
    // "the", "is", "with", "them" all moved with the correction and none of them is
    // evidence about what the transcriber mishears.
    expect(keytermCandidates(entries).map((c) => c.term)).toEqual(["underwriting"]);
  });

  it("leaves numbers alone, because boosting a digit does nothing", () => {
    const entries = [
      pair("PM8592624", "PM8592625", "one"),
      pair("PM8592624", "PM8592625", "two"),
    ];
    expect(keytermCandidates(entries)).toEqual([]);
  });

  it("flags a candidate that reads as a personal name rather than dropping it", () => {
    // Dropping names would not make the rest safe — `defaults.ts` measured a list with no
    // name in it damaging one — and it would hide the most common thing a Nigerian
    // caller's transcript gets wrong. A human sees which decision they are making.
    const entries = [
      pair("my name is Chike", "my name is Sikiru", "one"),
      pair("Chike here", "Sikiru here", "two"),
    ];
    const candidate = keytermCandidates(entries).find((c) => c.term === "Sikiru");

    expect(candidate?.looksLikeAName).toBe(true);
  });

  it("carries the pairs it inferred from, so the inference can be checked", () => {
    const entries = [pair("Anza", "Ansa", "one"), pair("Answer", "Ansa", "two")];
    const evidence = keytermCandidates(entries)[0]?.evidence ?? [];

    expect(evidence.map((e) => e.heard)).toEqual(["Anza", "Answer"]);
    expect(evidence[0]?.carrierCallId).toBe("CA-one");
  });
});

describe("number capture cases", () => {
  it("keeps a turn where the digits changed", () => {
    const cases = captureCases([pair("P M 8 5 9 2 6 2 4", "P M 8 5 9 2 6 2 5")]);

    expect(cases).toHaveLength(1);
    expect(cases[0]?.heardDigits).toBe("85926 24".replace(" ", ""));
    expect(cases[0]?.correctedDigits).toBe("85926 25".replace(" ", ""));
  });

  it("drops a turn the transcriber got the number right on", () => {
    // Grouping is a rendering habit that differs by provider; the digits are the claim.
    expect(captureCases([pair("PM8592625", "P M 8 5 9 2 6 2 5")])).toEqual([]);
  });

  it("drops a prose turn with no number in it at all", () => {
    expect(captureCases([pair("Security", "Sikiru")])).toEqual([]);
  });

  it("keeps a turn where the transcriber invented digits, or lost them", () => {
    expect(captureCases([pair("call me on 08138", "call me back")])).toHaveLength(1);
    expect(captureCases([pair("call me back", "call me on 08138")])).toHaveLength(1);
  });
});
