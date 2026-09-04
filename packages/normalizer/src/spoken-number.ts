/**
 * Spoken quantities turned back into numbers.
 *
 * This is a different problem from `parseSpokenDigits`, and conflating them is the
 * mistake worth naming up front. "four one seven" is a sequence and means 417. "four
 * hundred and seventeen" is a quantity and also means 417 — but "forty five thousand"
 * is 45000 as a quantity and "4 5 1 0 0 0" as a sequence, and only one of those is what
 * a caller quoting a premium meant.
 *
 * Sequences are references; quantities are amounts, counts and years. They need separate
 * parsers because they need separate answers.
 *
 * Pure, like the rest of the package: text in, value out.
 */

const UNITS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS: Readonly<Record<string, number>> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Short scale, as used in Nigeria. */
const SCALES: Readonly<Record<string, number>> = {
  hundred: 100,
  thousand: 1_000,
  million: 1_000_000,
  billion: 1_000_000_000,
};

/**
 * "Forty-five K" is how a Nigerian quotes a premium out loud at least as often as
 * "forty-five thousand", and "45k" is how a transcriber renders it.
 */
/**
 * "2k", "250k", "1.5m": the way a Nigerian quotes money in a text message and, since
 * transcribers write what they would type, in a transcript. "k" is thousand and "m" is
 * million; "b" is deliberately absent, because "5b" is a bus stop as often as it is money.
 */
const K_SUFFIX = /^(\d+(?:\.\d+)?)k$/;
const M_SUFFIX = /^(\d+(?:\.\d+)?)m$/;

/**
 * "Half a million", "a quarter of a million". A fraction word in front of a scale word
 * is the scale multiplied down, and "a" between them is noise.
 */
const FRACTIONS: Readonly<Record<string, number>> = { half: 0.5, quarter: 0.25 };

const BRIDGES = ["and", "point", "a", "an", "of"];

const isNumberWord = (token: string): boolean =>
  token in UNITS || token in TENS || token in SCALES || token in FRACTIONS || token === "k" || token === "m";

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    // Thousands separators are noise here: "45,000" is one number, not two.
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/[^a-z0-9.\s-]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "");

const isNumeric = (token: string): boolean => /^\d+(?:\.\d+)?$/.test(token);

/**
 * Whether a token can be part of a quantity at all. "and" only counts once a run has
 * started, or every conjunction in the sentence would look like the middle of a number.
 */
const continuesRun = (token: string, started: boolean): boolean =>
  isNumeric(token) ||
  isNumberWord(token) ||
  K_SUFFIX.test(token) ||
  M_SUFFIX.test(token) ||
  (started && BRIDGES.includes(token));

/**
 * One run of number tokens, accumulated the way the words compose.
 *
 * "two million five hundred thousand" is 2,500,000 and not 2,000,000 + 500 + 1000, so
 * scale words multiply what is pending rather than adding to a total.
 */
/** Whether anything numeric was actually folded, so a stray "half" is not read as zero. */
const seenScaleOrDigits = (total: number, current: number): boolean => total !== 0 || current !== 0;

const foldRun = (tokens: readonly string[]): number | null => {
  let total = 0;
  let current = 0;
  let seen = false;
  let fraction: string | null = null;

  /** "Half" or "quarter" waiting for its scale word. */
  let fractionOf: number | null = null;
  /** The last thing folded was a lone unit digit, so a tens word next is "two fifty". */
  let loneDigit = false;

  for (const token of tokens) {
    if (fraction !== null) {
      // Everything after "point" is read digit by digit — "one point five" and no
      // further arithmetic. A second "point" ends the number.
      if (isNumeric(token)) { fraction += token; continue; }
      const unit = UNITS[token];
      if (unit !== undefined && unit < 10) { fraction += String(unit); continue; }
      /* "One point five million". The decimal is finished and a scale word follows, so
         the whole decimal is what gets scaled — the reading that was returning 1.5 for a
         million and a half, which on a naira amount is the worst mistake this file can
         make. Only "thousand" and up: "one point five hundred" is not a number anybody
         says. */
      const scale = SCALES[token];
      if (scale !== undefined && scale >= 1_000) {
        // The decimal is the whole pending number — "one point five" — scaled as one value.
        total = Math.round(Number(`${total + current}.${fraction}`) * scale);
        current = 0;
        fraction = null;
        loneDigit = false;
        continue;
      }
      break;
    }

    if (token === "point") {
      if (!seen) return null;
      fraction = "";
      loneDigit = false;
      continue;
    }
    if (token === "and" || token === "a" || token === "an" || token === "of") continue;

    const fractionWord = FRACTIONS[token];
    if (fractionWord !== undefined) {
      fractionOf = fractionWord;
      seen = true;
      continue;
    }

    const kMatch = K_SUFFIX.exec(token);
    if (kMatch !== null) {
      total += Number(kMatch[1]) * 1000;
      seen = true;
      loneDigit = false;
      continue;
    }
    const mMatch = M_SUFFIX.exec(token);
    if (mMatch !== null) {
      total += Number(mMatch[1]) * 1_000_000;
      seen = true;
      loneDigit = false;
      continue;
    }
    if (token === "k" || token === "m") {
      // A bare "k" scales whatever is pending: "forty five k" is forty-five thousand.
      // A bare "m" the same, for a million: "one point five m".
      if (!seen || current === 0) return seen ? total : null;
      total += current * (token === "k" ? 1000 : 1_000_000);
      current = 0;
      loneDigit = false;
      continue;
    }

    if (isNumeric(token)) {
      current += Number(token);
      seen = true;
      loneDigit = false;
      continue;
    }

    const tens = TENS[token];
    if (tens !== undefined && loneDigit && current >= 1 && current <= 9) {
      /* "Two fifty", "three twenty", "one eighty": a lone digit straight into a tens word
         is a hundreds count, the way prices are said here — two-fifty is two hundred and
         fifty, never fifty-two. Only a single digit, and only into tens: "twenty five" is
         tens then units and folds as it always did. */
      current = current * 100 + tens;
      loneDigit = false;
      continue;
    }

    const unit = UNITS[token] ?? tens;
    if (unit !== undefined) {
      loneDigit = current === 0 && unit >= 1 && unit <= 9;
      current += unit;
      seen = true;
      continue;
    }

    const scale = SCALES[token];
    if (scale === undefined) continue;
    seen = true;
    loneDigit = false;
    if (fractionOf !== null) {
      // "Half a million": the fraction of the scale, closed off like any scale.
      total += fractionOf * scale;
      fractionOf = null;
      current = 0;
      continue;
    }
    if (scale === 100) {
      // "hundred" multiplies only what is immediately pending: "five hundred" is 500,
      // and "two thousand five hundred" leaves the two thousand alone.
      current = (current === 0 ? 1 : current) * 100;
      continue;
    }
    // "thousand", "million", "billion" close off everything pending, including a
    // hundreds group: "five hundred thousand".
    total += (current === 0 ? 1 : current) * scale;
    current = 0;
  }

  // A fraction word with no scale after it — "half" on its own — is not a number here.
  if (fractionOf !== null && !seenScaleOrDigits(total, current)) return null;

  if (!seen) return null;
  const whole = total + current;
  return fraction === null || fraction === "" ? whole : Number(`${whole}.${fraction}`);
};

/**
 * The first quantity in the text, or null if there isn't one.
 *
 * First rather than longest, which is the opposite of `parseSpokenDigits`. A dictated
 * reference is the run the caller spent the most breath on; a quantity is almost always
 * the thing they said first and then qualified — "forty five thousand naira, or
 * thereabouts, I paid it in three instalments".
 */
export const parseSpokenNumber = (text: string): number | null => {
  const tokens = tokenize(text);

  let index = 0;
  while (index < tokens.length) {
    if (!continuesRun(tokens[index] ?? "", false)) {
      index += 1;
      continue;
    }
    const run: string[] = [];
    while (index < tokens.length && continuesRun(tokens[index] ?? "", run.length > 0)) {
      run.push(tokens[index] ?? "");
      index += 1;
    }
    // A run that is nothing but bridges ("and point") is not a number.
    const folded = foldRun(run);
    if (folded !== null) return folded;
  }

  return null;
};

/**
 * The quantity immediately before a marker word — "forty five thousand **naira**".
 *
 * Anchoring on the currency is what makes amounts reliable in a real sentence: "I have
 * three policies and the premium is forty five thousand naira" has two numbers in it and
 * only one of them is the amount. Scanning left from the marker gets the right one;
 * scanning from the start of the turn gets the wrong one.
 */
export const parseNumberBefore = (text: string, marker: RegExp): number | null => {
  const tokens = tokenize(text);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (!marker.test(tokens[i] ?? "")) continue;
    let start = i;
    // Walking left, so the run is already under way and bridge words count.
    while (start > 0 && continuesRun(tokens[start - 1] ?? "", true)) start -= 1;
    if (start === i) continue;
    const folded = foldRun(tokens.slice(start, i));
    if (folded !== null) return folded;
  }
  return null;
};
