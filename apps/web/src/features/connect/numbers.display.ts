/**
 * What a number card says about a number, from the number alone.
 *
 * The country of a number the organisation brought is not stored — only a bought number
 * carries one — so it is read off the dialling code. The table is the handful of codes
 * this product actually meets; anything else shows the code itself rather than a guess.
 */
const COUNTRY_BY_PREFIX: readonly (readonly [string, string])[] = [
  ["+234", "NG"],
  ["+233", "GH"],
  ["+254", "KE"],
  ["+27", "ZA"],
  ["+44", "GB"],
  ["+353", "IE"],
  ["+1", "US"],
];

export const countryOf = (number: string, stored: string | null): string => {
  if (stored !== null) return stored;
  const hit = COUNTRY_BY_PREFIX.find(([prefix]) => number.startsWith(prefix));
  return hit === undefined ? "—" : hit[1];
};

/** `+17065517550` → `+1 706 551 7550`, so a number reads as one. */
export const spaced = (number: string): string => {
  if (number.startsWith("+1") && number.length === 12) return `+1 ${number.slice(2, 5)} ${number.slice(5, 8)} ${number.slice(8)}`;
  if (number.startsWith("+234") && number.length === 14) return `+234 ${number.slice(4, 7)} ${number.slice(7, 10)} ${number.slice(10)}`;
  if (number.startsWith("+44") && number.length === 13) return `+44 ${number.slice(3, 5)} ${number.slice(5, 9)} ${number.slice(9)}`;
  return number;
};
