import { sayNumber } from "./numbers";
import { parseNumberBefore, parseSpokenNumber } from "./spoken-number";

/**
 * Money, which is the highest-stakes thing this package says.
 *
 * A misheard premium is a complaint; a misspoken one is a dispute. This is also the
 * clearest case for why the normalizer exists at all rather than a prompt instruction:
 * the model gets naira amounts right most of the time, and most of the time is a
 * customer complaint.
 */

/** Nigerians write the naira as ₦ and, very commonly, as a bare N before a digit. */
const NAIRA = String.raw`(?:₦|NGN|N(?=\s?[\d]))`;

const sayKobo = (kobo: number): string =>
  kobo === 0 ? "" : `${sayNumber(kobo)} ${kobo === 1 ? "kobo" : "kobo"}`;

/**
 * A naira amount in words. Kobo are spoken only when present — "forty-five thousand
 * naira" is what a Nigerian says, not "forty-five thousand naira zero kobo".
 */
export const sayNaira = (amount: number): string => {
  const whole = Math.trunc(Math.abs(amount));
  // Rounded, not truncated: 0.005 of a naira is half a kobo and floor() would lose it.
  const kobo = Math.round((Math.abs(amount) - whole) * 100);

  // Rounding can carry: 45000.999 -> 45001 naira, not 45000 naira 100 kobo.
  const carried = kobo === 100;
  const naira = whole + (carried ? 1 : 0);
  const remainder = carried ? 0 : kobo;

  const sign = amount < 0 ? "minus " : "";
  const nairaWords = `${sayNumber(naira)} naira`;
  return remainder === 0 ? sign + nairaWords : `${sign}${nairaWords}, ${sayKobo(remainder)}`;
};

const parseAmount = (raw: string): number => Number(raw.replace(/,/g, ""));

/**
 * Rewrites currency written as symbols into words.
 *
 * Runs before the general number pass, because "₦45,000" must never reach it as a bare
 * "45,000" and come out as a quantity with the currency lost.
 */
export const expandMoney = (text: string): string =>
  text
    .replace(new RegExp(String.raw`${NAIRA}\s?([\d,]+(?:\.\d{1,2})?)`, "g"), (_m, amount: string) =>
      sayNaira(parseAmount(amount)),
    )
    // Kept because insurance is quoted in dollars often enough to matter, and "$500"
    // read as a bare number is a materially different sentence.
    .replace(/\$\s?([\d,]+(?:\.\d{1,2})?)/g, (_m, amount: string) => {
      const value = parseAmount(amount);
      return `${sayNumber(value)} ${value === 1 ? "dollar" : "dollars"}`;
    })
    .replace(/£\s?([\d,]+(?:\.\d{1,2})?)/g, (_m, amount: string) => {
      const value = parseAmount(amount);
      return `${sayNumber(value)} ${value === 1 ? "pound" : "pounds"}`;
    });

/* --------------------------------------------------- the other direction */

/**
 * The word that marks the number to its left as naira.
 *
 * Kobo are deliberately not in here. "Forty five thousand naira fifty kobo" has two
 * currency words and scanning for either from the right finds the kobo, which is how an
 * amount of forty-five thousand naira came out as fifty.
 */
const CURRENCY_WORD = /^(naira|nairas|ngn)$/;

const CURRENCY_SYMBOL = /(?:₦|NGN\s?|\bN(?=\s?\d))\s?([\d,]+(?:\.\d{1,2})?)/i;

/**
 * An amount the caller quoted, in naira.
 *
 * Anchored on the currency word rather than taken from the start of the turn. "I have
 * three policies and the premium is forty five thousand naira" contains two numbers and
 * only one of them is money; reading left from "naira" gets the right one, and reading
 * forward from the beginning gets three.
 *
 * Returns naira, rounded to the kobo. Kobo are essentially extinct in retail pricing
 * here — nothing is quoted in them — so carrying a minor-unit integer through the whole
 * pipeline would buy precision for a case that does not occur, at the cost of every call
 * site having to remember which unit it holds.
 */
export const parseSpokenAmount = (text: string): number | null => {
  const symbol = CURRENCY_SYMBOL.exec(text);
  if (symbol !== null) return Math.round(parseAmount(symbol[1] ?? "") * 100) / 100;

  const naira = parseNumberBefore(text, CURRENCY_WORD);
  if (naira === null) return null;

  // "forty five thousand naira fifty kobo". Rare, but a readback that drops the kobo
  // from an amount the caller said is a readback that hides the mistake it exists for.
  const kobo = parseNumberBefore(text, /^kobo$/);
  const withKobo = kobo === null || kobo >= 100 ? naira : naira + kobo / 100;
  return Math.round(withKobo * 100) / 100;
};

/**
 * An amount with no currency word attached — "forty five thousand", said in answer to
 * "how much?".
 *
 * Separate from `parseSpokenAmount` on purpose. Treating any bare number in a turn as
 * money is how "I have three policies" becomes three naira; this may only be called when
 * the agent has just asked for an amount and the answer can be nothing else.
 */
export const parseBareAmount = (text: string): number | null => parseSpokenNumber(text);

/** An amount read back. The same words `expandMoney` would produce, reached directly. */
export const sayAmount = (naira: number): string => sayNaira(naira);
