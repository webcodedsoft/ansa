import { describe, expect, it } from "vitest";

import { interpret, normalise } from "./hearing";

const speech = (text: string) => {
  const h = interpret(text);
  if (h.kind !== "speech") throw new Error(`expected speech, got noise: ${h.reason}`);
  return h;
};

const noise = (text: string) => {
  const h = interpret(text);
  if (h.kind !== "noise") throw new Error(`expected noise, got speech: ${h.raw}`);
  return h;
};

describe("normalise", () => {
  it("flattens case and punctuation the way a transcriber's output compares", () => {
    expect(normalise("Sorry, WHAT?!")).toBe("sorry what");
    expect(normalise("  it's   fine  ")).toBe("it s fine");
  });
});

describe("interpret — is it speech at all", () => {
  it("passes ordinary speech through untouched", () => {
    const h = speech("When does my policy renew?");
    expect(h.raw).toBe("When does my policy renew?");
    expect(h.forModel).toBe("When does my policy renew?");
    expect(h.corrections).toEqual([]);
  });

  it.each([["", "empty"], ["   ", "empty"], [".", "empty"], ["a", "too short"]])(
    "rejects %j as noise",
    (text) => {
      expect(interpret(text).kind).toBe("noise");
    },
  );

  // Observed on a live call: Malayalam script returned from Nigerian-accented English
  // with language "en" set explicitly. Not a mishearing — the model left the language.
  it("rejects a transcript that is not in Latin script", () => {
    expect(noise("പലനി പിടിച്ച്").reason).toBe("not latin script");
  });

  it("keeps speech that merely contains an accented character", () => {
    expect(speech("My name is Adéyemi.").raw).toBe("My name is Adéyemi.");
  });

  it("rejects known transcriber hallucinations", () => {
    expect(noise("Thanks for watching!").reason).toBe("known hallucination");
    expect(noise("Subtitles by the Amara.org community").reason).toBe("known hallucination");
  });

  // The two failures are not symmetric. Letting noise through wastes one turn; ignoring
  // a caller who spoke makes the agent look like it is not listening. These are things
  // the model hallucinates AND things callers really say, so they must pass.
  it.each(["Thank you.", "Bye.", "Yes.", "No.", "May.", "Okay"])(
    "does not reject %j, which a caller might genuinely say",
    (text) => {
      expect(interpret(text).kind).toBe("speech");
    },
  );

  it("rejects a long run of one repeated word", () => {
    expect(noise("you you you you you").reason).toBe("repeated token");
  });

  it("allows repetition short enough to be emphasis", () => {
    expect(speech("no no no").raw).toBe("no no no");
  });
});

describe("interpret — repairing known mishearings", () => {
  it.each([
    ["My polling number is AB417.", "My policy number is AB417."],
    ["My apology number is AB417.", "My policy number is AB417."],
    ["my penalty number please", "my policy number please"],
  ])("repairs %j", (raw, expected) => {
    expect(speech(raw).forModel).toBe(expected);
  });

  it("repairs the bare noun where the sentence makes it unambiguous", () => {
    expect(speech("I want to check my polling.").forModel).toBe("I want to check my policy.");
    expect(speech("When does my apology renew?").forModel).toBe("When does my policy renew?");
  });

  // The raw transcript is the eval corpus and the review loop's ground truth. A
  // corrected transcript recorded as if the caller said it would poison the data Gate A
  // depends on.
  it("never alters the raw transcript, only what the model is shown", () => {
    const h = speech("My polling number is AB417.");
    expect(h.raw).toBe("My polling number is AB417.");
    expect(h.forModel).not.toBe(h.raw);
    expect(h.corrections).toHaveLength(1);
  });

  // "apology", "penalty" and "police" are real words. Rewriting them on sight would be
  // worse than the mishearing; the model gets a hint in the system prompt instead.
  it.each([
    "I owe you an apology.",
    "Is there a penalty for cancelling?",
    "I need to call the police.",
    "Sorry for the apology earlier.",
  ])("leaves %j alone", (text) => {
    expect(speech(text).forModel).toBe(text);
  });

  it("reports every correction it made, so a live call can be audited", () => {
    expect(speech("My polling number is AB417.").corrections).toEqual([
      "My polling number is AB417. -> My policy number is AB417.",
    ]);
  });
});
