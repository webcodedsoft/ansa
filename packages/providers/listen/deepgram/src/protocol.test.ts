import { TELEPHONY_AUDIO } from "@ansa/shared";
import { describe, expect, it } from "vitest";

import { assertUsableKeyterms, buildUrl, parseEvent } from "./protocol";

const OPTIONS = {
  format: TELEPHONY_AUDIO,
  model: "flux-general-en",
  keyterms: ["policy", "policy number", "naira"],
  eotThreshold: 0.8,
  eotTimeoutMs: 3000,
  host: "api.deepgram.com",
};

describe("buildUrl", () => {
  it("targets v2, which is the only endpoint that serves Flux", () => {
    expect(buildUrl(OPTIONS)).toContain("wss://api.deepgram.com/v2/listen?");
  });

  it("asks for mu-law at the carrier's own sample rate, with no transcode", () => {
    const url = buildUrl(OPTIONS);
    expect(url).toContain("encoding=mulaw");
    expect(url).toContain("sample_rate=8000");
  });

  // The silent-failure mode, confirmed on the live API: a comma-joined list connects
  // happily and boosts nothing.
  it("sends one parameter per keyterm rather than joining them", () => {
    const url = buildUrl(OPTIONS);
    expect(url.match(/keyterm=/g)).toHaveLength(3);
    expect(url).toContain("keyterm=policy+number");
    expect(url).not.toContain("keyterm=policy%2Cpolicy");
  });

  it("carries the turn-detection thresholds", () => {
    const url = buildUrl(OPTIONS);
    expect(url).toContain("eot_threshold=0.8");
    expect(url).toContain("eot_timeout_ms=3000");
  });

  it("can target the EU host, which is nearer to Lagos", () => {
    expect(buildUrl({ ...OPTIONS, host: "api.eu.deepgram.com" })).toContain(
      "wss://api.eu.deepgram.com/v2/listen",
    );
  });

  it("refuses audio it would have to transcode", () => {
    expect(() =>
      buildUrl({ ...OPTIONS, format: { encoding: "linear16", sampleRate: 16000 } }),
    ).toThrow(/mu-law/);
  });
});

describe("assertUsableKeyterms", () => {
  // Deepgram accepts a comma-joined keyterm, treats it as one literal phrase, and boosts
  // nothing — with no error. A typo would silently disable the one capability this
  // provider was chosen for, so it fails loudly here instead.
  it.each([["policy,premium"], ["policy;premium"], ["policy:0.5"]])(
    "rejects %j, which the API would accept and silently ignore",
    (term) => {
      expect(() => assertUsableKeyterms([term])).toThrow(/separator/);
    },
  );

  it("accepts multi-word phrases, which are legitimate", () => {
    expect(() => assertUsableKeyterms(["policy number", "no claims bonus"])).not.toThrow();
  });

  it("rejects an empty term", () => {
    expect(() => assertUsableKeyterms(["  "])).toThrow(/Empty/);
  });
});

describe("parseEvent", () => {
  it("reads a start of turn", () => {
    expect(parseEvent(JSON.stringify({ type: "TurnInfo", event: "StartOfTurn" }))).toEqual({
      kind: "speechStart",
    });
  });

  it("reads an interim update with its words", () => {
    const e = parseEvent(
      JSON.stringify({
        type: "TurnInfo",
        event: "Update",
        transcript: "my policy",
        words: [
          { word: "my", confidence: 0.99 },
          { word: "policy", confidence: 0.49 },
        ],
      }),
    );
    expect(e).toEqual({
      kind: "interim",
      text: "my policy",
      words: [
        { text: "my", confidence: 0.99 },
        { text: "policy", confidence: 0.49 },
      ],
    });
  });

  // R4.1.5 becomes actionable for the first time: the previous provider reported no
  // confidence at all, so a low-confidence turn could not trigger a clarifying question.
  it("carries per-word confidence and the end-of-turn confidence on a final", () => {
    const e = parseEvent(
      JSON.stringify({
        type: "TurnInfo",
        event: "EndOfTurn",
        transcript: "when does my policy renew",
        words: [{ word: "policy", confidence: 0.87 }],
        end_of_turn_confidence: 0.86,
      }),
    );
    if (e?.kind !== "endOfTurn") throw new Error("expected an end of turn");
    expect(e.words[0]?.confidence).toBe(0.87);
    expect(e.endOfTurnConfidence).toBe(0.86);
  });

  // Observed on the live API: a fatal error arrives with type "Error".
  it("recognises an error frame by its type rather than its name", () => {
    expect(parseEvent(JSON.stringify({ type: "Error", description: "bad audio" }))).toEqual({
      kind: "error",
      message: "bad audio",
    });
  });

  it.each([
    ["malformed json", "{{{"],
    ["an unknown type", JSON.stringify({ type: "SomethingNew" })],
    ["an unknown turn event", JSON.stringify({ type: "TurnInfo", event: "Whatever" })],
  ])("returns null for %s rather than taking the call down", (_label, raw) => {
    expect(parseEvent(raw)).toBeNull();
  });
});
