import { describe, expect, it } from "vitest";

import {
  canonicalPhone,
  isNigerianMobile,
  parseBareAmount,
  parseSpokenAddress,
  parseSpokenAmount,
  parseSpelledName,
  parseSpokenDate,
  parseSpokenDigits,
  parseSpokenEmail,
  parseSpokenNumber,
  parseSpokenTime,
  sayAddress,
  sayAmount,
  sayDigits,
  sayDate,
  sayEmail,
  sayPhone,
  sayTime,
} from "./index";

/** Friday 2026-08-07, 09:00 in Lagos. Fixed so nothing here depends on when it runs. */
const NOW = Date.parse("2026-08-07T08:00:00Z");

describe("parseSpokenNumber", () => {
  it("reads quantities, not sequences", () => {
    expect(parseSpokenNumber("four hundred and seventeen")).toBe(417);
    expect(parseSpokenNumber("forty five thousand")).toBe(45_000);
    expect(parseSpokenNumber("two million five hundred thousand")).toBe(2_500_000);
    expect(parseSpokenNumber("one hundred")).toBe(100);
  });

  it("takes the K a Nigerian actually says", () => {
    expect(parseSpokenNumber("forty five k")).toBe(45_000);
    expect(parseSpokenNumber("45k")).toBe(45_000);
  });

  it("keeps a decimal as digits after the point", () => {
    expect(parseSpokenNumber("one point five")).toBe(1.5);
    expect(parseSpokenNumber("2.75")).toBe(2.75);
  });

  it("is not fooled by a sentence with no number in it", () => {
    expect(parseSpokenNumber("I want to renew my cover")).toBeNull();
  });
});

describe("phone numbers", () => {
  it("accepts the three forms of the same Nigerian mobile", () => {
    expect(canonicalPhone("08138178550")).toBe("08138178550");
    expect(canonicalPhone("+2348138178550")).toBe("08138178550");
    expect(canonicalPhone("8138178550")).toBe("08138178550");
  });

  it("rejects a number that is not a mobile at all", () => {
    // A mangled policy number must not become a callback number.
    expect(canonicalPhone("41729")).toBeNull();
    expect(canonicalPhone("01234567890")).toBeNull();
    expect(isNigerianMobile("0813817855")).toBe(false);
  });

  it("says it back grouped the way it is written down", () => {
    expect(sayPhone("08138178550")).toContain("oh eight one three");
  });
});

describe("email", () => {
  it("assembles one the caller spelled out", () => {
    expect(parseSpokenEmail("s i k i r u at gmail dot com")).toBe("sikiru@gmail.com");
  });

  it("takes one the transcriber already assembled", () => {
    expect(parseSpokenEmail("it's sikiru@gmail.com.")).toBe("sikiru@gmail.com");
  });

  it("handles the spoken punctuation", () => {
    expect(parseSpokenEmail("sikiru dot adedeji at yahoo dot co dot uk")).toBe(
      "sikiru.adedeji@yahoo.co.uk",
    );
    expect(parseSpokenEmail("sikiru underscore a at gmail dot com")).toBe("sikiru_a@gmail.com");
  });

  it("takes the last 'at' as the separator", () => {
    expect(parseSpokenEmail("my email at work is sikiru at gmail dot com")).toBe(
      "sikiru@gmail.com",
    );
  });

  it("refuses anything that is not an address", () => {
    expect(parseSpokenEmail("I'll be at the office tomorrow")).toBeNull();
    expect(parseSpokenEmail("sikiru at gmail")).toBeNull();
  });

  it("spells the local part and says a domain everyone knows", () => {
    // The local part is where the mistake hides; the domain is not.
    const spoken = sayEmail("sikiru@gmail.com");
    expect(spoken).toContain("S, I, K, I, R, U");
    expect(spoken).toContain("at gmail dot com");
    expect(spoken).not.toContain("G, M, A, I, L");
  });

  it("says any domain rather than holding a list of familiar ones", () => {
    // The split is structural: the local part is arbitrary, the domain is a published
    // string the caller recognises by sound. A whitelist of known providers would have
    // made the agent worst at the addresses it has never seen.
    expect(sayEmail("ada@zenithbank.com")).toContain("at zenithbank dot com");
    // Two characters or fewer is not pronounceable, so it is said as letters.
    expect(sayEmail("ada@firstbank.com.ng")).toContain("dot com dot N G");
  });
});

describe("amounts", () => {
  it("anchors on the currency, not on the first number in the turn", () => {
    expect(
      parseSpokenAmount("I have three policies and the premium is forty five thousand naira"),
    ).toBe(45_000);
  });

  it("reads the written forms", () => {
    expect(parseSpokenAmount("₦45,000")).toBe(45_000);
    expect(parseSpokenAmount("it is N250000")).toBe(250_000);
  });

  it("keeps kobo when the caller said them", () => {
    expect(parseSpokenAmount("forty five thousand naira fifty kobo")).toBe(45_000.5);
  });

  it("does not turn a bare quantity into money", () => {
    expect(parseSpokenAmount("I have three policies")).toBeNull();
    // Only when the agent has just asked "how much?" is a bare number an amount.
    expect(parseBareAmount("about forty five thousand")).toBe(45_000);
  });

  it("says it in naira", () => {
    expect(sayAmount(45_000)).toBe("forty-five thousand naira");
  });
});

describe("dates", () => {
  it("reads the spoken forms", () => {
    expect(parseSpokenDate("the fourteenth of August", NOW)).toBe("2026-08-14");
    expect(parseSpokenDate("August the fourteenth", NOW)).toBe("2026-08-14");
    expect(parseSpokenDate("14th August 2027", NOW)).toBe("2027-08-14");
    expect(parseSpokenDate("the twenty first of September", NOW)).toBe("2026-09-21");
  });

  it("reads day-first numerics, as Nigeria writes them", () => {
    expect(parseSpokenDate("14/08/2026", NOW)).toBe("2026-08-14");
    expect(parseSpokenDate("2026-08-14", NOW)).toBe("2026-08-14");
  });

  it("resolves the relative forms against the clock it is given", () => {
    expect(parseSpokenDate("tomorrow", NOW)).toBe("2026-08-08");
    expect(parseSpokenDate("today", NOW)).toBe("2026-08-07");
    expect(parseSpokenDate("the day after tomorrow", NOW)).toBe("2026-08-09");
  });

  it("takes a bare weekday as the next one, and 'next' as the one after", () => {
    // NOW is a Friday.
    expect(parseSpokenDate("Monday", NOW)).toBe("2026-08-10");
    expect(parseSpokenDate("next Monday", NOW)).toBe("2026-08-17");
    // The same weekday means a week away, not today.
    expect(parseSpokenDate("Friday", NOW)).toBe("2026-08-14");
  });

  it("rejects a day that does not exist", () => {
    expect(parseSpokenDate("the thirty first of September", NOW)).toBeNull();
  });

  it("finds no date in a turn that has none", () => {
    expect(parseSpokenDate("I would like to renew my cover", NOW)).toBeNull();
  });

  it("reads back the weekday the caller never gave, because that is the checksum", () => {
    // Nobody knows what date next Thursday is; everybody knows whether they meant Thursday.
    expect(sayDate("2026-08-14", NOW)).toBe("Friday the fourteenth of August");
    expect(sayDate("2027-08-14", NOW)).toContain("two thousand and twenty-seven");
  });
});

describe("times", () => {
  it("reads the conversational forms", () => {
    expect(parseSpokenTime("half past two")).toBe("14:30");
    expect(parseSpokenTime("quarter past three")).toBe("15:15");
    expect(parseSpokenTime("quarter to four")).toBe("15:45");
    expect(parseSpokenTime("twenty five past two")).toBe("14:25");
    expect(parseSpokenTime("two thirty")).toBe("14:30");
    expect(parseSpokenTime("two o'clock")).toBe("14:00");
  });

  it("honours an explicit am or pm over the assumption", () => {
    expect(parseSpokenTime("two thirty in the morning")).toBe("02:30");
    expect(parseSpokenTime("9:15 am")).toBe("09:15");
    expect(parseSpokenTime("nine in the evening")).toBeNull();
    expect(parseSpokenTime("nine o'clock in the evening")).toBe("21:00");
  });

  it("assumes the daytime reading of a bare hour", () => {
    // Guessed, and the readback says which way it guessed.
    expect(parseSpokenTime("nine thirty")).toBe("09:30");
    expect(parseSpokenTime("four o'clock")).toBe("16:00");
  });

  it("handles the named times", () => {
    expect(parseSpokenTime("midday")).toBe("12:00");
    expect(parseSpokenTime("midnight")).toBe("00:00");
    expect(parseSpokenTime("14:30")).toBe("14:30");
  });

  it("says the part of day, which is what catches a wrong guess", () => {
    expect(sayTime("14:30")).toBe("half past two in the afternoon");
    expect(sayTime("09:00")).toBe("nine o'clock in the morning");
    expect(sayTime("09:05")).toBe("nine oh five in the morning");
    expect(sayTime("12:00")).toBe("midday");
  });
});

describe("addresses", () => {
  it("keeps what the caller said, minus the lead-in", () => {
    expect(parseSpokenAddress("It's 14 Adeola Odeku Street, Victoria Island, Lagos")).toBe(
      "14 Adeola Odeku Street, Victoria Island, Lagos",
    );
    expect(parseSpokenAddress("my address is Plot 3, Admiralty Way, Lekki Phase 1")).toBe(
      "Plot 3, Admiralty Way, Lekki Phase 1",
    );
  });

  it("refuses a sentence that is not an address", () => {
    expect(parseSpokenAddress("I live with my mother")).toBeNull();
    expect(parseSpokenAddress("street")).toBeNull();
  });

  it("reads back with the commas that become pauses", () => {
    expect(sayAddress("14 Adeola Odeku Street,Victoria Island")).toBe(
      "14 Adeola Odeku Street, Victoria Island",
    );
  });
});

describe("spelled values, across shapes rather than examples", () => {
  const CASES: readonly { readonly label: string; readonly spoken: string; readonly value: string }[] = [
    { label: "three letters", spoken: "R I O", value: "Rio" },
    { label: "long", spoken: "T H E O P H I L U S", value: "Theophilus" },
    { label: "with a spoken space", spoken: "L E A space P A R K", value: "Lea Park" },
    { label: "with a spoken dash", spoken: "L E A dash P A R K", value: "Lea-Park" },
    { label: "illustrated by arbitrary words", spoken: "R for river, I for ink, O for oven", value: "Rio" },
    { label: "rendered with transcriber hyphens", spoken: "r-i-o", value: "Rio" },
  ];

  for (const { label, spoken, value } of CASES) {
    it(`reads a name spelled ${label}`, () => {
      expect(parseSpelledName(spoken), label).toBe(value);
    });
  }

  it("keeps a floor of three letters when nothing asked for a spelling", () => {
    // Speculative: "OK" must not become somebody's name.
    expect(parseSpelledName("O K")).toBeNull();
  });

  it("drops to two when a spelling was asked for", () => {
    // Two-letter surnames are real, and a three-letter floor means those callers can
    // never get their name across at all.
    expect(parseSpelledName("N G", 2)).toBe("Ng");
  });
});

describe("dictated values degrade rather than mangle", () => {
  it("bridges a hesitation in the middle of a value", () => {
    expect(parseSpokenDigits("eight three one, um, six four")).toBe("83164");
    // A trailing filler ends the run rather than reaching forward for the next number.
    expect(parseSpokenDigits("six two nine four one, erm")).toBe("62941");
  });

  it("reads the letter O between letters and a zero between digits", () => {
    expect(parseSpokenDigits("R O V four two eight")).toBe("ROV428");
    expect(parseSpokenDigits("four one o seven")).toBe("4107");
  });

  it("falls back to threes for anything that fits no national pattern", () => {
    // Nigerian mobile grouping is length-and-prefix specific. Everything else is chunked
    // the way people naturally chunk an unfamiliar sequence, not forced into 4-3-4.
    expect(sayDigits("441632960111")).toBe(
      "four four one, six three two, nine six oh, one one one",
    );
    expect(sayDigits("KR7392")).toBe("K R seven, three nine two");
  });
});

/**
 * Money the way a Nigerian says it, and three bugs found by saying it.
 *
 * "One point five million" was reading as one and a half naira, "two fifty k" as
 * fifty-two thousand, and "half a million" as a full one. Every one of those would have
 * been read back with confidence, and a caller who hears their own amount said back at
 * a thousandth of its size does not always notice.
 */
describe("amounts as spoken here", () => {
  it.each([
    ["one point five million naira", 1_500_000],
    ["one point two five million naira", 1_250_000],
    ["two fifty k naira", 250_000],
    ["three twenty naira", 320],
    ["twenty five thousand naira", 25_000],
    ["twenty five k naira", 25_000],
    ["half a million naira", 500_000],
    ["a quarter of a million naira", 250_000],
    ["2k naira", 2_000],
    ["250k naira", 250_000],
    ["1.5m naira", 1_500_000],
    ["two thousand five hundred naira", 2_500],
    ["five hundred thousand naira", 500_000],
  ])("%s → %d", (said, naira) => {
    expect(parseSpokenAmount(said)).toBe(naira);
  });

  it("still folds tens then units the ordinary way, and a count is still a count", () => {
    expect(parseSpokenNumber("twenty five")).toBe(25);
    expect(parseSpokenNumber("I have three policies")).toBe(3);
    expect(parseSpokenNumber("half")).toBeNull();
  });
});

/**
 * "By two" is at two. Not before two — that is what "by" means in London and not what it
 * means in Lagos, where "I'll call you by two" is an appointment.
 */
describe("a bare hour after a clock word", () => {
  it.each([
    ["I'll call by two", "14:00"],
    ["at two", "14:00"],
    ["around nine", "09:00"],
    ["by nine in the morning", "09:00"],
    ["2pm", "14:00"],
    ["by 2 pm", "14:00"],
    ["before six", "18:00"],
  ])("%s → %s", (said, time) => {
    expect(parseSpokenTime(said)).toBe(time);
  });

  it("leaves a bare number that is not on the clock alone", () => {
    expect(parseSpokenTime("I have two policies")).toBeNull();
    expect(parseSpokenTime("give me two")).toBeNull();
  });
});
