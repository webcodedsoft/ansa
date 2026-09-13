import { describe, expect, it } from "vitest";

import {
  NIGERIAN_LEXICON,
  applyPronunciations,
  compilePronunciations,
  mergePronunciations,
  parsePronunciations,
} from "./pronunciation";

/**
 * How a name sounds is the difference between a caller who trusts the voice and one who
 * does not. The list is large; these are the rules that make it safe to apply to every
 * sentence of every call.
 */
describe("the built-in Nigerian lexicon", () => {
  it("is large, and every entry is whole", () => {
    expect(NIGERIAN_LEXICON.length).toBeGreaterThan(350);
    for (const item of NIGERIAN_LEXICON) {
      expect(item.term.trim()).not.toBe("");
      expect(item.sayAs.trim()).not.toBe("");
      expect(item.term.length).toBeLessThanOrEqual(80);
    }
  });

  it("names no term twice", () => {
    const terms = NIGERIAN_LEXICON.map((item) => item.term.toLowerCase());
    const duplicates = terms.filter((term, index) => terms.indexOf(term) !== index);
    expect(duplicates).toEqual([]);
  });

  /* A voice already says these; respelling them would only make them worse. */
  it("carries no ordinary English word", () => {
    const terms = new Set(NIGERIAN_LEXICON.map((item) => item.term.toLowerCase()));
    for (const english of ["delta", "plateau", "rivers", "unity", "bolt", "sterling", "fidelity"]) {
      expect(terms.has(english)).toBe(false);
    }
  });
});

describe("saying a term the way its entry says", () => {
  it("respells a name inside a sentence, whole and without regard to case", () => {
    expect(applyPronunciations("Thank you, Sikiru, calling from IKEJA.", NIGERIAN_LEXICON)).toBe(
      "Thank you, see-kee-roo, calling from ee-kay-jah.",
    );
  });

  it("wraps a term in a phoneme tag for a voice that takes them", () => {
    const spoken = applyPronunciations("Ikeja", NIGERIAN_LEXICON, "phoneme-tags");
    expect(spoken).toBe('<phoneme alphabet="ipa" ph="iˈkedʒa">Ikeja</phoneme>');
  });

  it("takes the longer phrase whole rather than half of it", () => {
    expect(applyPronunciations("near Ibeju Lekki", NIGERIAN_LEXICON)).toBe("near ee-beh-joo lek-kee");
    expect(applyPronunciations("in Port Harcourt", NIGERIAN_LEXICON)).toBe("in port har-court");
  });

  it("leaves a word that merely contains a term alone", () => {
    // "Obi" is a name; "Obinna" is another, and "obituary" is neither.
    expect(applyPronunciations("the obituary", [{ term: "Obi", sayAs: "oh-bee" }])).toBe("the obituary");
    expect(applyPronunciations("Obinna and Obi", NIGERIAN_LEXICON)).toBe("oh-bin-nah and oh-bee");
  });

  it("does not touch a term already inside a phoneme tag", () => {
    const once = applyPronunciations("Ikeja", NIGERIAN_LEXICON, "phoneme-tags");
    expect(applyPronunciations(once, NIGERIAN_LEXICON, "phoneme-tags")).toBe(once);
  });

  it("falls back to the respelling in phoneme mode when an entry has no IPA", () => {
    expect(applyPronunciations("your NIN", NIGERIAN_LEXICON, "phoneme-tags")).toBe("your N I N");
  });

  it("changes nothing when there is nothing to say differently", () => {
    expect(applyPronunciations("Good afternoon, how can I help?", NIGERIAN_LEXICON)).toBe(
      "Good afternoon, how can I help?",
    );
    expect(applyPronunciations("Ikeja", [])).toBe("Ikeja");
  });

  it("is built once and reused", () => {
    const say = compilePronunciations(NIGERIAN_LEXICON);
    expect(say("Lagos", "respelling")).toBe("lay-goss");
    expect(say("Kano", "respelling")).toBe("kah-noh");
  });
});

describe("an organisation's own entries", () => {
  it("win over the built-in ones for the same term, whatever the case", () => {
    const merged = mergePronunciations(NIGERIAN_LEXICON, [{ term: "ikeja", sayAs: "ee-keh-jah" }]);
    expect(applyPronunciations("Ikeja", merged)).toBe("ee-keh-jah");
    expect(merged.filter((item) => item.term.toLowerCase() === "ikeja")).toHaveLength(1);
  });

  it("are read back from storage safely, dropping what is not an entry", () => {
    expect(
      parsePronunciations([
        { term: " Oakhaven ", sayAs: "oak-hay-ven" },
        { term: "Bad", sayAs: "" },
        { term: "", sayAs: "x" },
        "nonsense",
        { term: "Leadway", sayAs: "leed-way", ipa: "ˈlidwei" },
      ]),
    ).toEqual([
      { term: "Oakhaven", sayAs: "oak-hay-ven" },
      { term: "Leadway", sayAs: "leed-way", ipa: "ˈlidwei" },
    ]);
    expect(parsePronunciations(null)).toEqual([]);
    expect(parsePronunciations("Ikeja")).toEqual([]);
  });
});
