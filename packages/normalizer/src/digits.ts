/**
 * Digit strings — phone numbers, policy numbers, reference codes.
 *
 * These are never read as quantities. "08138178550" is not eight billion; it is a
 * sequence, and saying it as a quantity is both wrong and unusable to a caller writing
 * it down.
 */

/**
 * Zero is "oh" inside a sequence.
 *
 * Nigerian English follows British usage: a phone number starting 080 is "oh eight oh",
 * never "zero eight zero". Saying "zero" is the single most American-sounding thing an
 * agent can do with a Nigerian phone number.
 */
const DIGIT_WORDS: Readonly<Record<string, string>> = {
  "0": "oh", "1": "one", "2": "two", "3": "three", "4": "four",
  "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
};

/** Letters are said plainly; the pause between them is what makes them land. */
const sayChar = (char: string): string => DIGIT_WORDS[char] ?? char.toUpperCase();

/**
 * Nigerian mobile numbers are eleven digits, written 0813 817 8550. Grouping them the
 * way they are written is what lets a caller check the number against their own phone
 * rather than counting digits.
 */
const NIGERIAN_MOBILE_GROUPS = [4, 3, 4];

const groupsFor = (digits: string): readonly number[] => {
  if (digits.length === 11 && digits.startsWith("0")) return NIGERIAN_MOBILE_GROUPS;
  if (digits.length === 13 && digits.startsWith("234")) return [3, 4, 3, 3];
  // Anything else: threes, which is how people naturally chunk an unfamiliar sequence.
  return [];
};

const chunk = (value: string, sizes: readonly number[]): string[] => {
  if (sizes.length === 0) {
    const out: string[] = [];
    for (let i = 0; i < value.length; i += 3) out.push(value.slice(i, i + 3));
    return out;
  }
  const out: string[] = [];
  let index = 0;
  for (const size of sizes) {
    if (index >= value.length) break;
    out.push(value.slice(index, index + size));
    index += size;
  }
  if (index < value.length) out.push(value.slice(index));
  return out;
};

/**
 * A sequence of characters, said one at a time and grouped for the ear.
 *
 * Commas between groups matter: they become a pause in TTS, and the pause is what makes
 * eleven digits writable-down instead of a blur.
 */
export const sayDigits = (value: string): string => {
  const cleaned = value.replace(/[^0-9A-Za-z]/g, "");
  if (cleaned === "") return "";

  const digitsOnly = /^[0-9]+$/.test(cleaned);
  const groups = digitsOnly ? chunk(cleaned, groupsFor(cleaned)) : chunk(cleaned, []);

  return groups.map((group) => [...group].map(sayChar).join(" ")).join(", ");
};

/**
 * The word for each letter, for reading a reference back over an 8kHz line.
 *
 * The primary-school alphabet every Nigerian caller learned, not the NATO one: "F for
 * Fish" is understood without explanation; "Foxtrot" is not. It exists because of one call
 * where "FST901EE" was heard as "SST901EE", read back as "S, S, T", and the caller, hearing
 * the same three sounds they had said, agreed to it. F and S are one phoneme apart and the
 * line strips the frequencies that separate them; a word per letter replaces that one
 * phoneme with a whole word, on the way back as well as on the way in.
 */
const LETTER_WORDS: Readonly<Record<string, string>> = {
  A: "Apple", B: "Ball", C: "Cat", D: "Dog", E: "Egg", F: "Fish", G: "Goat", H: "Hat", I: "Ink",
  J: "Jug", K: "Kite", L: "Lion", M: "Mango", N: "Nest", O: "Orange", P: "Pot", Q: "Queen",
  R: "Rat", S: "Sun", T: "Table", U: "Umbrella", V: "Van", W: "Water", X: "X-ray", Y: "Yam", Z: "Zebra",
};

/**
 * A reference the caller must copy exactly — policy numbers, claim references, plates.
 *
 * Digits are said and grouped as `sayDigits` says them. A letter is said with its word —
 * "F for Fish" — because bare letters are the one thing this channel cannot carry; see
 * `LETTER_WORDS`. A reference with no letters in it reads exactly as it did before.
 */
export const sayReference = (value: string): string => {
  const cleaned = value.replace(/[^0-9A-Za-z]/g, "");
  if (cleaned === "") return "";
  if (!/[A-Za-z]/.test(cleaned)) return sayDigits(cleaned);
  const runs = cleaned.match(/[0-9]+|[A-Za-z]+/g) ?? [];
  return runs
    .map((run) =>
      /^[0-9]+$/.test(run)
        ? sayDigits(run)
        : [...run.toUpperCase()].map((letter) => `${letter} for ${LETTER_WORDS[letter] ?? letter}`).join(", "),
    )
    .join(", ");
};
