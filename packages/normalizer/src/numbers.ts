/**
 * Cardinal numbers as Nigerian English says them.
 *
 * The "and" in "one hundred and twenty-three" is not decorative. Nigerian English
 * follows British usage here, and dropping it ("one hundred twenty-three") is one of the
 * clearest markers of an American-sounding agent.
 */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen",
];

const TENS = [
  "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];

/** Short scale, as used in Nigeria. */
const SCALES: readonly { readonly value: number; readonly name: string }[] = [
  { value: 1_000_000_000, name: "billion" },
  { value: 1_000_000, name: "million" },
  { value: 1_000, name: "thousand" },
];

const underThousand = (n: number): string => {
  if (n < 20) return ONES[n] ?? "";
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)] ?? "";
    const rest = n % 10;
    return rest === 0 ? tens : `${tens}-${ONES[rest] ?? ""}`;
  }
  const hundreds = `${ONES[Math.floor(n / 100)] ?? ""} hundred`;
  const rest = n % 100;
  return rest === 0 ? hundreds : `${hundreds} and ${underThousand(rest)}`;
};

/**
 * A whole number in words. Negative and fractional input is the caller's problem to
 * avoid; this returns something sayable rather than throwing, because throwing on the
 * speech path turns a wrong number into silence, and silence is the worse failure.
 */
export const sayNumber = (value: number): string => {
  if (!Number.isFinite(value)) return "";
  const rounded = Math.trunc(Math.abs(value));
  const sign = value < 0 ? "minus " : "";
  if (rounded === 0) return `${sign}zero`;

  const parts: string[] = [];
  let remaining = rounded;

  for (const scale of SCALES) {
    if (remaining < scale.value) continue;
    const count = Math.floor(remaining / scale.value);
    parts.push(`${underThousand(count)} ${scale.name}`);
    remaining %= scale.value;
  }

  if (remaining > 0) {
    // "one thousand and fifty", not "one thousand fifty" — same British "and" as above,
    // but only when what remains is under a hundred.
    if (parts.length > 0 && remaining < 100) parts.push("and");
    parts.push(underThousand(remaining));
  }

  return sign + parts.join(" ");
};

const ORDINALS: Readonly<Record<string, string>> = {
  one: "first", two: "second", three: "third", five: "fifth", eight: "eighth",
  nine: "ninth", twelve: "twelfth",
};

/** "5" -> "fifth". Used for dates, which are the common case by far. */
export const sayOrdinal = (value: number): string => {
  const words = sayNumber(value);
  const match = /([a-z]+)$/.exec(words);
  if (match === null) return words;

  const last = match[1] ?? "";
  const replacement =
    ORDINALS[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return words.slice(0, words.length - last.length) + replacement;
};
