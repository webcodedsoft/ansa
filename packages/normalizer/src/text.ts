import { sayDigits } from "./digits";
import { expandMoney } from "./money";
import { sayNumber, sayOrdinal } from "./numbers";

/**
 * The one pipeline every outbound utterance passes through.
 *
 * Nothing reaches TTS unnormalized — not model output, not tool results, not static
 * greetings, not error messages. A phrase that skips this is a bug even when it happens
 * to sound fine, because the next value substituted into it will not.
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Phrases whose digits are part of the phrase, not a quantity.
 *
 * These MUST run before the number pass. Left until after it, "24/7" has already become
 * "twenty-four/seven" and no longer matches anything — the general pass destroys the
 * pattern that would have recognised it.
 */
const DIGIT_PHRASES: readonly (readonly [RegExp, string])[] = [
  [/\b24\/7\b/g, "twenty-four hours a day"],
  [/\bNo\.\s*(?=\d)/g, "number "],
];

/**
 * Said in full, because an agent that says "Ltd" as three letters sounds like a form
 * being read rather than a person talking.
 */
const ABBREVIATIONS: readonly (readonly [RegExp, string])[] = [
  [/\bLtd\.?/g, "Limited"],
  [/\bPlc\.?/gi, "P L C"],
  [/\bSt\.\s/g, "Street "],
  [/\bRd\.?\b/g, "Road"],
  [/\bAve\.?\b/g, "Avenue"],
  [/\be\.g\.\s*/gi, "for example, "],
  [/\bi\.e\.\s*/gi, "that is, "],
  [/\betc\.?\b/gi, "and so on"],
  [/\bvs\.?\b/gi, "versus"],
];

/**
 * Words that mean the digits after them are a sequence to be copied down, not a
 * quantity. Getting this wrong in either direction is bad: a policy number said as a
 * quantity is unusable, and a premium said digit by digit is absurd.
 */
const SEQUENCE_CUE =
  /(?:policy|reference|ref|claim|account|acct|number|no\.?|code|pin|otp|id|nin|bvn)\s*(?:number|no\.?|code)?\s*(?:is|are|:|#)?\s*$/i;

const looksLikeSequence = (digits: string, preceding: string): boolean =>
  // A leading zero is never a quantity anyone says aloud, and eleven digits is a phone
  // number by construction.
  digits.startsWith("0") || digits.length >= 7 || SEQUENCE_CUE.test(preceding);

/** The markdown the model emits despite being told not to. */
const stripMarkdown = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^[ \t]*[#>*\-+][ \t]+/gm, "")
    .replace(/^[ \t]*\d+\.[ \t]+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|[*_]/g, "");

const expandDatesAndTimes = (text: string): string =>
  text
    // 2026-08-14 — ISO, which is what a tool result almost always returns.
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (whole, y: string, m: string, d: string) => {
      const month = MONTHS[Number(m) - 1];
      if (month === undefined) return whole;
      return `the ${sayOrdinal(Number(d))} of ${month} ${sayNumber(Number(y))}`;
    })
    // 14/08/2026 — day first, as written in Nigeria. Ambiguous with US order by nature;
    // day-first is correct for the locale and the wrong guess is at worst a wrong date
    // read back, which readback exists to catch.
    .replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (whole, d: string, m: string, y: string) => {
      const month = MONTHS[Number(m) - 1];
      if (month === undefined) return whole;
      return `the ${sayOrdinal(Number(d))} of ${month} ${sayNumber(Number(y))}`;
    })
    // 14:30 / 2:05 pm
    .replace(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/gi, (_m, h: string, min: string, suffix?: string) => {
      const hour = Number(h);
      const minutes = Number(min);
      const spoken =
        minutes === 0 ? `${sayNumber(hour)} o'clock`
        // "oh five", not "five" — a bare "two five" is heard as twenty-five.
        : minutes < 10 ? `${sayNumber(hour)} oh ${sayNumber(minutes)}`
        : `${sayNumber(hour)} ${sayNumber(minutes)}`;
      return suffix === undefined ? spoken : `${spoken} ${suffix.toLowerCase() === "am" ? "a m" : "p m"}`;
    });

/**
 * "1.5" is "one point five", never "one point fifty" — the fractional part is a
 * sequence of digits, not a quantity, and "one point fifty" is meaningless.
 */
const sayDecimal = (token: string): string => {
  const [whole = "0", fraction] = token.split(".");
  const wholeWords = sayNumber(Number(whole));
  if (fraction === undefined) return wholeWords;
  const digits = [...fraction].map((d) => (d === "0" ? "oh" : sayNumber(Number(d)))).join(" ");
  return `${wholeWords} point ${digits}`;
};

const expandNumbers = (text: string): string => {
  // Percentages before the general pass, so "15%" keeps its meaning.
  const withPercent = text.replace(/([\d,]+(?:\.\d+)?)\s?%/g, (_m, value: string) => {
    const parsed = Number(value.replace(/,/g, ""));
    return `${sayNumber(parsed)} percent`;
  });

  // One pass, three shapes, most specific first. Splitting these into separate passes
  // was wrong: "45,000" matched as "45" then "000", and a run of zeros starting with a
  // zero looks like a sequence, so a plain quantity came out as "forty-five, oh oh oh".
  const NUMERIC =
    /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+\.\d+\b|\b[\dA-Za-z]*\d[\dA-Za-z-]*\b/g;

  return withPercent.replace(NUMERIC, (token, offset: number) => {
    const preceding = withPercent.slice(Math.max(0, offset - 40), offset);

    // A comma is a thousands separator, and nobody writes one inside a reference. It is
    // the strongest available signal that this is a quantity.
    if (token.includes(",")) return sayDecimal(token.replace(/,/g, ""));
    if (/^\d+\.\d+$/.test(token)) return sayDecimal(token);

    // Mixed letters and digits is a reference by definition — AB417, POL-2291.
    if (/[A-Za-z]/.test(token)) return sayDigits(token);

    const digits = token.replace(/-/g, "");
    if (looksLikeSequence(digits, preceding)) return sayDigits(digits);

    const value = Number(digits);
    return Number.isFinite(value) ? sayNumber(value) : sayDigits(digits);
  });
};

/**
 * Respellings for TTS.
 *
 * The brand is "Ansa" everywhere a human reads it. TTS is handed "An-Sah" instead,
 * because the telephone channel destroys the name otherwise.
 *
 * /s/ carries most of its energy above 4kHz. The telephony passband ends near 3.4kHz and
 * mu-law discards the rest, so between a nasal and a vowel the stripped fricative is
 * heard as its voiced neighbour and callers hear "Anza". Confirmed by A/B on a real
 * call: the same sentence at pcm_24000 is a correct "Ansa", at ulaw_8000 it is not — the
 * model is right and the channel is wrong. The respelling makes the model produce a
 * longer, harder fricative, so enough survives the band-pass to be heard correctly.
 *
 * A caller who cannot repeat the company name back has not really been greeted.
 */
const respell = (text: string): string => text.replace(/\bAnsa\b/g, "An-Sah");

/** Text as it should be spoken. Idempotent: running it twice changes nothing. */
export const forSpeech = (text: string): string => {
  const prepared = DIGIT_PHRASES.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    stripMarkdown(text),
  );

  const withCommas = expandNumbers(expandDatesAndTimes(expandMoney(prepared)));

  const expanded = ABBREVIATIONS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    withCommas,
  );

  return respell(expanded)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
};
