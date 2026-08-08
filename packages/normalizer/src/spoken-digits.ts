/**
 * The inverse direction: what the caller said, turned back into a value.
 *
 * Callers do not dictate "417". They say "four one seven", or "four seventeen", or
 * "double four", and on a Nigerian line they say "oh" for zero far more often than
 * "zero". Every one of those has to land on the same digits, because the caller believes
 * they have given the same number.
 *
 * Pure, like the rest of this package: text in, value out.
 */

const UNITS: Readonly<Record<string, number>> = {
  zero: 0, oh: 0, o: 0, nought: 0, naught: 0, nil: 0,
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9,
};

const TEENS: Readonly<Record<string, number>> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS: Readonly<Record<string, number>> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** "double four" is 44. Common in British and Nigerian dictation, absent from American. */
const REPEATS: Readonly<Record<string, number>> = { double: 2, triple: 3, treble: 3 };

/**
 * Only homophones that are not also ordinary English words.
 *
 * "to", "too", "for", "won", "ate", "free" and "tree" were here and were removed. They
 * are the homophones a transcriber actually produces, but mapping them unconditionally
 * turns "I would like to renew" into a 2, and ordinary speech is far more common than
 * dictation. The defence against a genuinely misheard digit is keyterm boosting and the
 * readback itself, not guessing here — guessing corrupts the sentences that were fine.
 */
const HOMOPHONES: Readonly<Record<string, string>> = {
  tu: "two", niner: "nine", fife: "five",
};

/**
 * Tokens that mean a value is being dictated, as opposed to tokens that merely *could*
 * belong to one.
 *
 * "oh" is a zero in "oh eight one three" and an interjection in "oh, I see"; a lone
 * letter is a policy prefix in "A B four one seven" and a pronoun in "I would like".
 * Neither can start a value on its own — a run has to contain something unambiguous.
 */
const isStrongToken = (token: string): boolean =>
  /^[0-9]+$/.test(token) ||
  token in TEENS ||
  token in TENS ||
  token in REPEATS ||
  (token in UNITS && !["oh", "o"].includes(token));

const clean = (text: string): string[] =>
  text
    .toLowerCase()
    // Apostrophes close up rather than splitting: "it's" must become "its", not "it" +
    // "s", or the stray letter is read as a prefix and "No, it's four one eight" is
    // captured as S418.
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    // "twenty-three" and "twenty three" are the same utterance with different
    // transcriber punctuation, so the hyphen becomes a space rather than a token.
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "");

/**
 * Whether a token could be part of a dictated value. Single letters count: a policy
 * number is "A B four one seven" and dropping the letters loses half the reference.
 */
const isValueToken = (token: string): boolean =>
  /^[0-9]+$/.test(token) ||
  /^[a-z]$/.test(token) ||
  token in UNITS ||
  token in TEENS ||
  token in TENS ||
  token in REPEATS ||
  token in HOMOPHONES;

const appendToken = (out: string[], tokens: readonly string[], index: number): number => {
  const raw = tokens[index] ?? "";
  const token = HOMOPHONES[raw] ?? raw;

  if (/^[0-9]+$/.test(token)) {
    out.push(token);
    return 1;
  }

  const repeat = REPEATS[token];
  if (repeat !== undefined) {
    const nextRaw = tokens[index + 1] ?? "";
    const next = HOMOPHONES[nextRaw] ?? nextRaw;
    const digit = /^[0-9]$/.test(next) ? Number(next) : UNITS[next];
    // A trailing "double" with nothing after it is a false start, not a value.
    if (digit === undefined) return 1;
    out.push(String(digit).repeat(repeat));
    return 2;
  }

  const unit = UNITS[token];
  if (unit !== undefined) {
    out.push(String(unit));
    return 1;
  }

  const teen = TEENS[token];
  if (teen !== undefined) {
    out.push(String(teen));
    return 1;
  }

  const ten = TENS[token];
  if (ten !== undefined) {
    const nextRaw = tokens[index + 1] ?? "";
    const next = HOMOPHONES[nextRaw] ?? nextRaw;
    const unitAfter = UNITS[next];
    // "twenty three" is 23, one value, not 20 followed by 3. But "twenty oh" is not a
    // number anyone says, so a zero after a ten is treated as a separate digit.
    if (unitAfter !== undefined && unitAfter !== 0) {
      out.push(String(ten + unitAfter));
      return 2;
    }
    out.push(String(ten));
    return 1;
  }

  if (/^[a-z]$/.test(token)) {
    out.push(token.toUpperCase());
    return 1;
  }

  return 1;
};

/**
 * The longest dictated value in the text, or null if there isn't one.
 *
 * Longest rather than first, because callers preface the value with words that are
 * themselves number-ish ("for my one policy, the number is four one seven"), and the
 * value they mean is the run they spent the most breath on.
 */
export const parseSpokenDigits = (text: string): string | null => {
  const tokens = clean(text);

  let best = "";
  let index = 0;

  while (index < tokens.length) {
    if (!isValueToken(tokens[index] ?? "")) {
      index += 1;
      continue;
    }

    const run: string[] = [];
    let hasStrong = false;
    while (index < tokens.length && isValueToken(tokens[index] ?? "")) {
      const raw = tokens[index] ?? "";
      if (isStrongToken(HOMOPHONES[raw] ?? raw)) hasStrong = true;
      index += appendToken(run, tokens, index);
    }

    const value = run.join("");
    if (hasStrong && /[0-9]/.test(value) && value.length > best.length) best = value;
  }

  return best === "" ? null : best;
};

/**
 * A name the caller has spelled out, letter by letter.
 *
 * Nigerian names cannot be transcribed reliably from 8kHz telephony audio and keyterms
 * cannot help: a caller's name is unknown by definition, so there is nothing to boost.
 * On a live call "Sikiru" came back as "Hill", then "Sequium", then "Security security
 * security". Spelling is the only path that converges, and it is what a human agent does
 * on a bad line too.
 *
 * Transcribers render spelled letters in several ways — "S I K I R U", "s-i-k-i-r-u",
 * "S. I. K." — and all of them flatten to single-letter tokens.
 */
export const parseSpelledName = (text: string): string | null => {
  const tokens = text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z\s-]/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "");

  const BRIDGES = ["as", "in", "for", "like", "and", "of"];

  let best: string[] = [];
  let run: string[] = [];

  for (const token of tokens) {
    if (token.length === 1) {
      run.push(token);
      continue;
    }

    const lastLetter = run[run.length - 1];

    // "S for Sunday" and "A as in Apple": the bridge is skipped and so is the word that
    // illustrates the letter, because it confirms the letter rather than adding one.
    // Recognised by its own first letter, which is what makes it work for any word in
    // any language rather than needing a spelling alphabet.
    if (BRIDGES.includes(token) && run.length > 0) continue;
    if (lastLetter !== undefined && token.startsWith(lastLetter)) continue;

    if (run.length > best.length) best = run;
    run = [];
  }
  if (run.length > best.length) best = run;

  // Two letters is not a spelling, it is a false positive on "OK" or a stray article.
  if (best.length < 3) return null;

  // Title case, not upper. "SIKIRU" makes TTS engines spell the word out letter by
  // letter, which would read the name back as the very thing the caller just did.
  const joined = best.join("");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
};
