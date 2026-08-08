import { sayNumber } from "./numbers";

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

export const sayKobo = (kobo: number): string =>
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
