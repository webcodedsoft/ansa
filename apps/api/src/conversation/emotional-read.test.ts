import { describe, expect, it } from "vitest";

import {
  createReadStripper,
  parseRead,
  renderRead,
  trajectoryOf,
  type EmotionalRead,
} from "./emotional-read";

/**
 * The stripper carries the risk in this file.
 *
 * It sits on the token path of every turn, so a mistake here is not a wrong emotion label
 * — it is the caller hearing "less than less than read colon" at the end of every sentence,
 * or a reply losing its last word. Most of what follows is about token boundaries, because
 * that is where it can go wrong and the model will never split them the same way twice.
 */

const speak = (tokens: readonly string[]): { said: string; marker: string | null } => {
  const stripper = createReadStripper();
  let said = "";
  for (const token of tokens) said += stripper.push(token);
  said += stripper.flush();
  return { said, marker: stripper.marker() };
};

const read = (over: Partial<EmotionalRead> = {}): EmotionalRead => ({
  emotion: "calm",
  energy: "normal",
  trust: "normal",
  urgency: "normal",
  ...over,
});

describe("keeping the marker out of the caller's ear", () => {
  it("passes ordinary speech through untouched", () => {
    expect(speak(["We open ", "at nine.", " Anything else?"]).said).toBe(
      "We open at nine. Anything else?",
    );
  });

  it("cuts everything from the marker onward", () => {
    const { said, marker } = speak(["It renews in May.", "\n<<read: emotion=calm>>"]);
    expect(said).toBe("It renews in May.\n");
    expect(marker).toBe("<<read: emotion=calm>>");
  });

  it("holds a lone angle bracket back rather than speaking it", () => {
    /* The model does not split tokens where you would. `<` arriving alone with its partner
       in the next token is the case that puts a stray character into the audio. */
    const { said, marker } = speak(["Done.", " <", "<read: emotion=pleased>>"]);
    expect(said).toBe("Done. ");
    expect(marker).toBe("<<read: emotion=pleased>>");
  });

  it("survives the marker arriving one character at a time", () => {
    const { said, marker } = speak([
      "Ok.",
      ..."<<read: emotion=angry, trust=low>>".split(""),
    ]);
    expect(said).toBe("Ok.");
    expect(marker).toBe("<<read: emotion=angry, trust=low>>");
  });

  it("gives back a stray bracket that turned out not to be a marker", () => {
    // Held back on the last token, so without the flush the reply loses its final character.
    expect(speak(["Fine <"]).said).toBe("Fine <");
    expect(speak(["Fine <"]).marker).toBeNull();
  });

  it("says nothing more once the marker has begun, however much follows", () => {
    // A model that keeps talking after the marker is having a bad turn; it must not be
    // an audible one.
    const { said } = speak(["Sure.", "<<read: emotion=calm>>", " and another thing"]);
    expect(said).toBe("Sure.");
  });

  it("reports no marker when the model forgot one", () => {
    expect(speak(["Just an answer."]).marker).toBeNull();
  });
});

describe("reading the marker", () => {
  it("takes the four fields", () => {
    expect(
      parseRead("<<read: emotion=frustrated, energy=high, trust=low, urgency=high>>"),
    ).toEqual({ emotion: "frustrated", energy: "high", trust: "low", urgency: "high" });
  });

  it("treats a missing level as normal, and a missing emotion as no read at all", () => {
    /* "They did not say" is a real answer for a scale and not for a feeling: normal is the
       middle of a range, and there is no middle emotion to fall back on. */
    expect(parseRead("<<read: emotion=calm>>")).toEqual(read());
    expect(parseRead("<<read: energy=high>>")).toBeNull();
  });

  it("drops a word that is not in the vocabulary rather than guessing at it", () => {
    // Deciding `annoyed` means `frustrated` puts a word in the model's mouth it did not
    // choose, and next turn's guidance keys off the exact word.
    expect(parseRead("<<read: emotion=annoyed>>")).toBeNull();
    expect(parseRead("<<read: emotion=upset, energy=volcanic>>")?.energy).toBe("normal");
  });

  it("does not fail a turn over a mangled line", () => {
    // The caller cannot hear this. Failing the turn over it would be the worst trade going.
    expect(parseRead("<<read emotion")).toBeNull();
    expect(parseRead("<<>>")).toBeNull();
    expect(parseRead(null)).toBeNull();
  });
});

describe("which way they are going", () => {
  it("is steady on the first turn, with nothing to compare against", () => {
    expect(trajectoryOf(read({ emotion: "angry" }), null)).toBe("steady");
  });

  it("counts trust dropping as getting worse even when the word has not changed", () => {
    // The quiet one. A caller who has stopped believing you while staying outwardly calm
    // is going the wrong way, and the emotion alone misses it.
    expect(trajectoryOf(read({ trust: "low" }), read())).toBe("worsening");
  });

  it("does not treat resignation as an improvement on anger", () => {
    /* This is the whole reason severity is a ranking. Resigned reads as calm and is not —
       it is somebody who has given up on you, and scoring it as easing would have the
       agent relax at the exact moment it should be handing over. */
    expect(trajectoryOf(read({ emotion: "resigned" }), read({ emotion: "angry" }))).toBe("steady");
    expect(trajectoryOf(read({ emotion: "resigned" }), read({ emotion: "calm" }))).toBe("worsening");
  });

  it("sees a caller settling down", () => {
    expect(trajectoryOf(read({ emotion: "calm" }), read({ emotion: "upset" }))).toBe("easing");
  });
});

describe("the line the model reads next turn", () => {
  it("says nothing before there is a read", () => {
    expect(renderRead(null, null)).toBeNull();
  });

  it("names where they were when it has moved", () => {
    const block = renderRead(read({ emotion: "angry" }), read({ emotion: "confused" })) ?? "";
    expect(block).toContain("How they sound: angry (was confused — worsening)");
  });

  it("names the drift when the word held but the trust did not", () => {
    const block = renderRead(read({ trust: "low" }), read()) ?? "";
    expect(block).toContain("How they sound: calm (worsening)");
    expect(block).toContain("Trust low");
  });

  it("tells the agent to change how it speaks and never to say so", () => {
    // Awareness that announces itself is performance. The static half of that rule is in
    // the prompt layer; this is the reminder that travels with the value.
    expect(renderRead(read(), null)).toContain("Never say it out loud");
  });
});
