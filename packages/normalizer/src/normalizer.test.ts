import { describe, expect, it } from "vitest";

import { sayDigits, sayNaira, sayNumber, sayOrdinal, forSpeech } from "./index";

describe("sayNumber", () => {
  it("counts", () => {
    expect(sayNumber(0)).toBe("zero");
    expect(sayNumber(7)).toBe("seven");
    expect(sayNumber(15)).toBe("fifteen");
    expect(sayNumber(40)).toBe("forty");
    expect(sayNumber(42)).toBe("forty-two");
  });

  it("keeps the British 'and' that Nigerian English uses", () => {
    // "one hundred twenty-three" is the clearest marker of an American-sounding agent.
    expect(sayNumber(123)).toBe("one hundred and twenty-three");
    expect(sayNumber(1050)).toBe("one thousand and fifty");
    expect(sayNumber(100)).toBe("one hundred");
  });

  it("scales", () => {
    expect(sayNumber(45_000)).toBe("forty-five thousand");
    expect(sayNumber(250_000)).toBe("two hundred and fifty thousand");
    expect(sayNumber(1_500_000)).toBe("one million five hundred thousand");
    expect(sayNumber(2_000_000_000)).toBe("two billion");
  });

  it("returns something sayable rather than throwing", () => {
    // Throwing on the speech path turns a wrong number into silence, which is worse.
    expect(sayNumber(Number.NaN)).toBe("");
    expect(sayNumber(-5)).toBe("minus five");
  });
});

describe("sayOrdinal", () => {
  it("handles the irregular ones dates actually use", () => {
    expect(sayOrdinal(1)).toBe("first");
    expect(sayOrdinal(2)).toBe("second");
    expect(sayOrdinal(3)).toBe("third");
    expect(sayOrdinal(5)).toBe("fifth");
    expect(sayOrdinal(9)).toBe("ninth");
    expect(sayOrdinal(12)).toBe("twelfth");
    expect(sayOrdinal(20)).toBe("twentieth");
    expect(sayOrdinal(21)).toBe("twenty-first");
    expect(sayOrdinal(31)).toBe("thirty-first");
  });
});

describe("sayDigits", () => {
  it("says zero as 'oh', never 'zero'", () => {
    // British and Nigerian usage. "Zero eight one three" is an American agent.
    expect(sayDigits("081")).toBe("oh eight one");
  });

  it("groups a Nigerian mobile the way it is written", () => {
    // 0813 817 8550 — grouped so a caller can check it against their own phone.
    expect(sayDigits("08138178550")).toBe(
      "oh eight one three, eight one seven, eight five five oh",
    );
  });

  it("groups an international Nigerian number", () => {
    expect(sayDigits("2348138178550")).toContain("two three four");
  });

  it("says a mixed reference character by character", () => {
    expect(sayDigits("AB417")).toBe("A B four, one seven");
  });

  it("ignores punctuation in the input", () => {
    expect(sayDigits("0813-817-8550")).toBe(sayDigits("08138178550"));
  });
});

describe("sayNaira", () => {
  it("omits kobo when there are none", () => {
    // "forty-five thousand naira zero kobo" is not something anyone says.
    expect(sayNaira(45_000)).toBe("forty-five thousand naira");
  });

  it("says kobo when present", () => {
    expect(sayNaira(45_000.5)).toBe("forty-five thousand naira, fifty kobo");
  });

  it("carries a rounding that reaches a whole naira", () => {
    // Not "forty-five thousand naira, one hundred kobo".
    expect(sayNaira(45_000.999)).toBe("forty-five thousand and one naira");
  });
});

describe("forSpeech", () => {
  it("expands naira written as a bare N, which is how Nigerians write it", () => {
    expect(forSpeech("Your premium is N45,000.")).toBe(
      "Your premium is forty-five thousand naira.",
    );
    expect(forSpeech("Your premium is ₦45,000.")).toContain("forty-five thousand naira");
  });

  it("never lets a currency amount reach the number pass as a bare quantity", () => {
    expect(forSpeech("₦1,500")).not.toContain("naira naira");
    expect(forSpeech("₦1,500")).toBe("one thousand five hundred naira");
  });

  it("reads a policy number as a sequence, not a quantity", () => {
    // The failure this package exists to prevent: "four hundred and seventeen".
    const spoken = forSpeech("Your policy number is 417293.");
    expect(spoken).toContain("four one seven");
    expect(spoken).not.toContain("hundred");
  });

  it("reads a small quantity as a quantity", () => {
    expect(forSpeech("You have 3 policies with us.")).toBe("You have three policies with us.");
  });

  it("treats a leading zero as a sequence whatever its length", () => {
    expect(forSpeech("Call 08138178550.")).toContain("oh eight one three");
  });

  it("says a date the way it is spoken, not the way it is stored", () => {
    expect(forSpeech("It renews on 2026-08-14.")).toBe(
      "It renews on the fourteenth of August two thousand and twenty-six.",
    );
  });

  it("reads a slash date day-first, as written in Nigeria", () => {
    expect(forSpeech("Due 14/08/2026.")).toContain("fourteenth of August");
  });

  it("says a time with a leading-zero minute audibly", () => {
    // "two five" would be heard as twenty-five.
    expect(forSpeech("We open at 8:05 am.")).toContain("eight oh five a m");
    expect(forSpeech("We close at 17:00.")).toContain("seventeen o'clock");
  });

  it("strips the markdown the model emits despite being told not to", () => {
    // A caller must never hear "asterisk asterisk".
    expect(forSpeech("**Important:** your *cover* lapsed")).toBe(
      "Important: your cover lapsed",
    );
    expect(forSpeech("- first\n- second")).toBe("first\nsecond");
  });

  it("expands abbreviations rather than spelling them", () => {
    expect(forSpeech("Kano General Ltd")).toBe("Kano General Limited");
    expect(forSpeech("Open 24/7")).toBe("Open twenty-four hours a day");
  });

  it("respells the company name so it survives an 8kHz line", () => {
    expect(forSpeech("This is Ansa.")).toBe("This is An-Sah.");
  });

  it("expands percentages", () => {
    expect(forSpeech("A 15% increase")).toBe("A fifteen percent increase");
  });

  it("is idempotent, because normalized text gets re-normalized in practice", () => {
    const inputs = [
      "Your premium is ₦45,000.",
      "Your policy number is AB417.",
      "It renews on 2026-08-14.",
      "This is Ansa.",
    ];
    for (const input of inputs) {
      const once = forSpeech(input);
      expect(forSpeech(once)).toBe(once);
    }
  });

  it("leaves ordinary speech completely alone", () => {
    const plain = "I can help you with that. What is your name?";
    expect(forSpeech(plain)).toBe(plain);
  });
});

describe("things that only make sense on a screen", () => {
  /**
   * Emoji survived this package for as long as it has existed. They render silently in a
   * chat window and are pronounced on a phone: "Done ✅" reaches the caller as "Done white
   * heavy check mark", which is exactly the failure markdown stripping was added for.
   */
  it("removes emoji rather than letting them be read aloud", () => {
    expect(forSpeech("Done \u{2705}")).toBe("Done");
    expect(forSpeech("All set \u{1F389}")).toBe("All set");
  });

  it("removes the invisible characters that glue a composite emoji together", () => {
    // A variation selector or a joiner left behind turns one unspoken symbol into two.
    expect(forSpeech("Ready \u{1F468}\u{200D}\u{1F4BB}")).toBe("Ready");
    expect(forSpeech("Warning \u{26A0}\u{FE0F}")).toBe("Warning");
  });

  it("leaves ordinary punctuation and accented letters alone", () => {
    /* The ranges are narrow on purpose. Stripping too widely would eat the punctuation a
       voice needs for its pauses, or a name somebody actually has. */
    expect(forSpeech("Well — yes, that's right.")).toBe("Well — yes, that's right.");
    expect(forSpeech("Adaeze Okonkwo")).toBe("Adaeze Okonkwo");
  });
});
