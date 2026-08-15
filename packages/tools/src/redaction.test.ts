import { describe, expect, it } from "vitest";

import { redactPayload } from "./redact";
import {
  NO_REDACTION,
  parseRedactionPolicy,
  redactText,
  REDACTION_CATEGORIES,
  type RedactionCategory,
  type RedactionPolicy,
} from "./redaction";

/**
 * The values below are fixtures and nothing in the implementation may key on one of them.
 * They are deliberately unrelated to each other and to anything in the briefs: several
 * linguistic backgrounds for the names, and identifiers that are purely numeric,
 * alphanumeric, letter-led and digit-led, so a rule that only helps one shape fails here.
 */

const policy = (
  categories: readonly RedactionCategory[],
  extra: Partial<RedactionPolicy> = {},
): RedactionPolicy => ({ ...NO_REDACTION, ...extra, categories });

describe("the default is the organisation's own data, complete", () => {
  it("changes nothing when no category is configured", () => {
    const text = "Kwabena Mensah, reference RT-88213, kwabena@example.test, said 4 0 1 9 2.";
    expect(redactText(text, NO_REDACTION).text).toBe(text);
  });

  it("parses absent configuration as no redaction rather than as an error", () => {
    expect(parseRedactionPolicy(undefined).categories).toEqual([]);
    expect(parseRedactionPolicy(null).categories).toEqual([]);
    expect(parseRedactionPolicy({}).categories).toEqual([]);
  });

  it("leaves a payload untouched when the organization configured nothing", () => {
    const payload = { transcript: "My number is 08031234567", name: "Ifeoma Nwachukwu" };
    expect(redactPayload(payload)).toEqual(payload);
  });
});

describe("captured identifiers — what the call actually recorded", () => {
  const cases = [
    { captured: "Ifeoma Nwachukwu", spoken: "This is Ifeoma Nwachukwu speaking." },
    { captured: "Bjørn Halvorsen", spoken: "Put me down as Bjørn Halvorsen." },
    { captured: "Li Wei", spoken: "The account is under Li Wei." },
    { captured: "Ada", spoken: "Ada is the name on the file." },
    { captured: "María del Carmen Ruiz", spoken: "It is María del Carmen Ruiz." },
    { captured: "RT-88213", spoken: "The reference is RT-88213 as far as I know." },
    { captured: "9948217736", spoken: "My number there is 9948217736." },
    { captured: "QX7K2M", spoken: "It should be QX7K2M on your screen." },
  ];

  for (const { captured, spoken } of cases) {
    it(`masks ${captured} wherever it appears`, () => {
      const out = redactText(spoken, policy(["captured-identifier"]), {
        capturedIdentifiers: [captured],
      });
      expect(out.text).not.toContain(captured);
      expect(out.text).toContain("[redacted:captured-identifier]");
      expect(out.counts["captured-identifier"]).toBe(1);
    });
  }

  it("finds an identifier written apart from the way it was captured", () => {
    // How a reference arrives from a transcriber when it was read out character by
    // character. The exact string is absent and the value is still in the payload.
    const spread = ["QX7K2M", "QX 7K 2M", "q x 7 k 2 m", "QX-7K-2M"];
    for (const form of spread) {
      const out = redactText(`On file as ${form}.`, policy(["captured-identifier"]), {
        capturedIdentifiers: ["QX7K2M"],
      });
      expect(out.text).toBe("On file as [redacted:captured-identifier].");
    }
  });

  it("does not eat the inside of an unrelated word", () => {
    const out = redactText("Always ask.", policy(["captured-identifier"]), {
      capturedIdentifiers: ["Al"],
    });
    expect(out.text).toBe("Always ask.");
  });

  it("refuses to act on a one-character value", () => {
    const out = redactText("A call about a policy.", policy(["captured-identifier"]), {
      capturedIdentifiers: ["A"],
    });
    expect(out.text).toBe("A call about a policy.");
  });

  it("masks several captured values in one string", () => {
    const out = redactText(
      "Ranjit Kaur, reference 5512-AA, called about it.",
      policy(["captured-identifier"]),
      { capturedIdentifiers: ["Ranjit Kaur", "5512-AA"] },
    );
    expect(out.text).not.toContain("Ranjit Kaur");
    expect(out.text).not.toContain("5512-AA");
    expect(out.counts["captured-identifier"]).toBe(2);
  });
});

describe("shape — email", () => {
  const addresses = [
    "grace.okonkwo@example.test",
    "b.jensen+alerts@mail.example.test",
    "u_2291@sub.example.test",
  ];

  for (const address of addresses) {
    it(`masks ${address}`, () => {
      const out = redactText(`Send it to ${address} please.`, policy(["email"]));
      expect(out.text).toBe("Send it to [redacted:email] please.");
    });
  }
});

describe("shape — card numbers", () => {
  // Synthetic, Luhn-valid, and not any real scheme's test number.
  const valid = ["4485110485710019", "5500005555555559", "6011000990139424"];

  for (const number of valid) {
    it(`masks ${number} and its spaced and hyphenated forms`, () => {
      for (const form of [number, number.replace(/(\d{4})(?=\d)/g, "$1 "), number.replace(/(\d{4})(?=\d)/g, "$1-")]) {
        const out = redactText(`The card is ${form}.`, policy(["card-number"]));
        expect(out.text).toBe("The card is [redacted:card-number].");
      }
    });
  }

  it("leaves a long run alone when it does not pass Luhn", () => {
    const out = redactText("Reference 4485110485710013.", policy(["card-number"]));
    expect(out.text).toContain("4485110485710013");
    expect(out.counts["card-number"]).toBe(0);
  });
});

describe("shape — written digit runs", () => {
  const runs = ["08031234567", "2291 4470", "77-31-9042", "300415"];

  for (const run of runs) {
    it(`masks ${run} at the default threshold`, () => {
      const out = redactText(`It is ${run}, I think.`, policy(["digit-sequence"]));
      expect(out.text).toBe("It is [redacted:digit-sequence], I think.");
    });
  }

  it("leaves runs shorter than the threshold", () => {
    const out = redactText("Flat 12 on the 3rd floor.", policy(["digit-sequence"]));
    expect(out.text).toBe("Flat 12 on the 3rd floor.");
  });

  it("honours a organization's own threshold", () => {
    const tight = redactText("Flat 12.", policy(["digit-sequence"], { minDigits: 2 }));
    expect(tight.text).toBe("Flat [redacted:digit-sequence].");

    const loose = redactText("Ref 300415.", policy(["digit-sequence"], { minDigits: 8 }));
    expect(loose.text).toBe("Ref 300415.");
  });
});

describe("shape — spoken digit runs", () => {
  it("masks a reference read out digit by digit", () => {
    const out = redactText(
      "It is four eight two nine one on the letter.",
      policy(["spoken-digit-sequence"]),
    );
    expect(out.text).toBe("It is [redacted:spoken-digit-sequence] on the letter.");
  });

  it("masks the way people group repeats", () => {
    const out = redactText("double four seven oh three", policy(["spoken-digit-sequence"]));
    expect(out.text).toBe("[redacted:spoken-digit-sequence]");
  });

  it("leaves ordinary prose that happens to contain a number word", () => {
    for (const sentence of [
      "I have one question about my cover.",
      "Two or three days, they said.",
      "It went up by twenty five thousand naira.",
    ]) {
      expect(redactText(sentence, policy(["spoken-digit-sequence"])).text).toBe(sentence);
    }
  });
});

describe("categories compose without corrupting each other", () => {
  it("does not redact inside a mask an earlier category wrote", () => {
    const out = redactText(
      "Chidinma Eze on 08031234567 or chidinma@example.test.",
      policy(REDACTION_CATEGORIES),
      { capturedIdentifiers: ["Chidinma Eze"] },
    );
    expect(out.text).not.toContain("Chidinma Eze");
    expect(out.text).not.toContain("08031234567");
    expect(out.text).not.toContain("chidinma@example.test");
    // Every mask is intact — none has been chewed by a later pass.
    expect(out.text.match(/\[redacted:[a-z-]+\]/g)?.length).toBe(3);
  });

  it("prefers the identifier label over the anonymous digit label", () => {
    const out = redactText("Reference 9948217736 confirmed.", policy(REDACTION_CATEGORIES), {
      capturedIdentifiers: ["9948217736"],
    });
    expect(out.text).toBe("Reference [redacted:captured-identifier] confirmed.");
    expect(out.counts["digit-sequence"]).toBe(0);
  });
});

describe("secret material is not a organization setting", () => {
  it("removes credential-shaped keys even with no policy configured", () => {
    const out = redactPayload({
      transcript: "the caller said hello",
      authorization: "Bearer some-value",
      nested: { apiKey: "another-value", note: "fine" },
    }) as Record<string, unknown>;

    expect(out.authorization).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).apiKey).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).note).toBe("fine");
    expect(out.transcript).toBe("the caller said hello");
  });

  it("does not truncate a long transcript the way the tool-log redactor does", () => {
    const long = "a sentence about the policy. ".repeat(40);
    const out = redactPayload({ transcript: long }) as Record<string, unknown>;
    expect(out.transcript).toBe(long);
  });

  it("applies the organization's free-text policy through a nested payload", () => {
    const out = redactPayload(
      { turns: [{ speaker: "caller", text: "my number is 08031234567" }] },
      policy(["digit-sequence"]),
    ) as { turns: { text: string }[] };
    expect(out.turns[0]?.text).toBe("my number is [redacted:digit-sequence]");
  });
});

describe("configuration is validated where somebody is looking at a screen", () => {
  it("accepts every category it documents", () => {
    const parsed = parseRedactionPolicy({ categories: [...REDACTION_CATEGORIES] });
    expect(parsed.categories).toEqual(REDACTION_CATEGORIES);
  });

  it("refuses a category it does not implement", () => {
    expect(() => parseRedactionPolicy({ categories: ["phone-number"] })).toThrow(/unknown entry/);
  });

  it("refuses a threshold that would mask every digit in the payload", () => {
    expect(() => parseRedactionPolicy({ minDigits: 1 })).toThrow(/between 2 and 64/);
    expect(() => parseRedactionPolicy({ minSpokenDigits: 0 })).toThrow(/between 2 and 64/);
  });

  it("de-duplicates a repeated category rather than running it twice", () => {
    expect(parseRedactionPolicy({ categories: ["email", "email"] }).categories).toEqual(["email"]);
  });
});
