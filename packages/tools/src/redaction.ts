/**
 * R5.2.4 — redaction that reaches free text, configured per tenant.
 *
 * `redact.ts` beside this matches credential-shaped *keys*. That rule is unconditional and
 * stays unconditional: an `authorization` header or a vault reference is not the caller's
 * personal data and not the organisation's data either, it is secret material we hold in
 * trust, and it must never leave this process whatever anybody configures. This file is
 * about the other thing — a caller reading a policy number aloud, which arrives as prose in
 * a transcript and which no key-name rule will ever see.
 *
 * **Nothing here runs by default.** The organisation is the data controller; the caller is
 * their customer; the payload is a record of a conversation their own agent had. Withholding
 * their own data from them on a judgement we made about their compliance posture is not our
 * call, and it would break the obvious uses — a CRM that needs the policy number, a
 * ticketing system that needs the callback number. A tenant that configures no categories
 * gets everything, and `NO_REDACTION` is what that looks like.
 *
 * What the capability is for is the tenant who *does* want masking, and for them it has to
 * actually work. Two sources of signal, and they are not equal:
 *
 *   1. **What the call captured.** `apps/api/src/conversation/call-facts.ts` already knows
 *      which values were recorded as identifiers on this call, because the capture layer
 *      put them there and the caller confirmed them. That is knowledge, not inference: it
 *      catches a name, which has no shape, and it catches an identifier in whatever form it
 *      was written down. It is the strongest thing available and it is why
 *      `capturedIdentifiers` is a runtime input rather than configuration.
 *
 *   2. **Shape.** An email address, a Luhn-valid card number, a long run of digits, a run
 *      of spoken digit words. These are structural and they generalise; none of them is a
 *      list of known values, and adding one would be the mistake this project has a rule
 *      about.
 *
 * What shape provably cannot do is in `docs/EVENT_WEBHOOKS.md`, where a tenant switching
 * this on will read it. The short version: a name, an address, a date of birth and a
 * disclosure about somebody's health have no shape that distinguishes them from ordinary
 * prose, so categories 2 will not find them and category 1 only finds what capture caught.
 *
 * Pure: text in, text out. No I/O, no clock, no config lookups.
 */

/**
 * The categories a tenant may switch on.
 *
 * Deliberately small and each one defensible on its own. A category that fires on prose it
 * cannot distinguish from the thing it is looking for would be worse than absent — the
 * tenant would believe the payload was clean.
 */
export type RedactionCategory =
  /** Values this call recorded as identifiers. Not a pattern; a fact about the call. */
  | "captured-identifier"
  | "email"
  /** 13–19 digits that pass Luhn. A strict subset of digit-sequence, named separately so a
   *  tenant can mask card numbers without masking every reference their agent handled. */
  | "card-number"
  /** A run of digits at or over `minDigits`, written. */
  | "digit-sequence"
  /** A run of digit *words* at or over `minSpokenDigits` — how a number arrives from STT. */
  | "spoken-digit-sequence";

export const REDACTION_CATEGORIES: readonly RedactionCategory[] = [
  "captured-identifier",
  "email",
  "card-number",
  "digit-sequence",
  "spoken-digit-sequence",
];

export interface RedactionPolicy {
  readonly categories: readonly RedactionCategory[];
  /** Shortest written run `digit-sequence` masks. Four, because three is a house number. */
  readonly minDigits: number;
  /** Shortest spoken run `spoken-digit-sequence` masks. */
  readonly minSpokenDigits: number;
}

/** The default, and the whole point of the default: the organisation gets its own data. */
export const NO_REDACTION: RedactionPolicy = {
  categories: [],
  minDigits: 4,
  minSpokenDigits: 4,
};

/** What this particular call knows, as opposed to what the tenant configured. */
export interface RedactionContext {
  /**
   * Values the capture layer recorded as identifiers on this call — a name, a policy
   * number, a customer id. Supplied by the caller because `@ansa/tools` must not reach
   * into the orchestrator's call state, and because it changes per call rather than per
   * tenant.
   */
  readonly capturedIdentifiers?: readonly string[];
}

export type RedactionCounts = Readonly<Record<RedactionCategory, number>>;

export interface RedactedText {
  readonly text: string;
  readonly counts: RedactionCounts;
}

const zeroCounts = (): Record<RedactionCategory, number> => ({
  "captured-identifier": 0,
  email: 0,
  "card-number": 0,
  "digit-sequence": 0,
  "spoken-digit-sequence": 0,
});

/**
 * What replaces a match.
 *
 * Named rather than blanked, so the receiving system can tell that something was removed
 * and what kind of thing it was. A silently shortened sentence reads as a transcription
 * failure and would send somebody looking in the wrong place.
 */
const mask = (category: RedactionCategory): string => `[redacted:${category}]`;

const MASK = /\[redacted:[a-z-]+\]/g;

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Letters and digits in any script.
 *
 * `[A-Za-z0-9]` was the first version and it silently dropped every character outside
 * ASCII, which meant a name carrying a diacritic — Yorùbá, Norwegian, Spanish — produced a
 * pattern that could not match the value it was built from. The tenant would have seen the
 * name survive redaction and had no way to tell why.
 */
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * One captured value, as it might have been written down.
 *
 * A policy number confirmed as `AB123456` can appear in a transcript as `AB 123 456`,
 * `ab-123456`, or spelled out with the letters apart, because that is how people read
 * references aloud and how a transcriber writes them down. Matching the exact string only
 * would leave the commonest spelling in the payload, which is the failure the tenant
 * switched this on to avoid.
 *
 * So the value's significant characters are matched with optional separators between them.
 * Word boundaries are applied at whichever end is alphanumeric, so masking a captured name
 * does not eat the middle of an unrelated word.
 */
const capturedPattern = (value: string): RegExp | null => {
  const significant = [...value].filter((c) => ALPHANUMERIC.test(c));
  // One character is not an identifier, it is a letter, and masking every occurrence of it
  // would destroy the payload rather than clean it.
  if (significant.length < 2) return null;

  const body = significant.map(escapeRegex).join("[\\s.\\-]{0,2}");
  // Lookarounds rather than `\b`, which JavaScript defines over ASCII word characters
  // only. A surname ending in ø or í has no ASCII boundary after it, so `\b` would refuse
  // to match exactly the names this product exists to get right.
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * A digit run long enough to be a card, separated the way people write one.
 *
 * Only space and hyphen separate, deliberately: a full stop would make `1234.56` a
 * seventeen-digit candidate joined to the next number in the sentence.
 */
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

const luhnValid = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const digit = digits.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    const value = double ? digit * 2 : digit;
    sum += value > 9 ? value - 9 : value;
    double = !double;
  }
  return sum % 10 === 0;
};

/**
 * The digit words a number arrives as when somebody reads it out.
 *
 * A lexicon of the language, not a list of values: these are the words for the ten digits
 * plus the two ways English speakers group repeats and the two ways they say zero. Tens and
 * teens are deliberately absent — "twenty" and "hundred" appear in prose about money, dates
 * and quantities far more often than in a spoken reference, and including them would mask
 * sentences that contain no identifier at all.
 */
const DIGIT_WORDS = [
  "zero", "nought", "oh", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "double", "triple",
];

const SPOKEN_RUN = new RegExp(
  `\\b(?:${DIGIT_WORDS.join("|")})(?:[\\s,-]+(?:${DIGIT_WORDS.join("|")}))*\\b`,
  "gi",
);

/**
 * Replace, counting, and never inside a mask this pass already wrote.
 *
 * The guard matters because the categories run in sequence: `[redacted:email]` contains no
 * digits, but a captured identifier that happens to be a substring of a category name would
 * otherwise be found inside the marker left by an earlier pass.
 */
const replaceOutsideMasks = (
  text: string,
  pattern: RegExp,
  category: RedactionCategory,
  accept: (match: string) => boolean,
  counts: Record<RedactionCategory, number>,
): string => {
  const spans: [number, number][] = [];
  for (const found of text.matchAll(MASK)) {
    if (found.index !== undefined) spans.push([found.index, found.index + found[0].length]);
  }
  const inMask = (from: number, to: number): boolean =>
    spans.some(([start, end]) => from < end && to > start);

  return text.replace(pattern, (match, offset: number) => {
    if (inMask(offset, offset + match.length)) return match;
    if (!accept(match)) return match;
    counts[category] += 1;
    return mask(category);
  });
};

const always = (): boolean => true;

/**
 * One string, redacted under one tenant's policy.
 *
 * Order is not arbitrary. Captured identifiers go first because they are known rather than
 * inferred, and masking them first stops a policy number being reported as an anonymous
 * digit run when we can say exactly what it was. Email before the digit rules, so a local
 * part full of digits is not carved up first. Card before the general digit rule, because
 * card is the narrower claim and the more useful label.
 */
export const redactText = (
  text: string,
  policy: RedactionPolicy,
  context: RedactionContext = {},
): RedactedText => {
  const counts = zeroCounts();
  if (policy.categories.length === 0) return { text, counts };

  const on = new Set(policy.categories);
  let out = text;

  if (on.has("captured-identifier")) {
    for (const value of context.capturedIdentifiers ?? []) {
      const pattern = capturedPattern(value);
      if (pattern === null) continue;
      out = replaceOutsideMasks(out, pattern, "captured-identifier", always, counts);
    }
  }

  if (on.has("email")) {
    out = replaceOutsideMasks(out, EMAIL, "email", always, counts);
  }

  if (on.has("card-number")) {
    out = replaceOutsideMasks(out, CARD_CANDIDATE, "card-number", (match) => {
      const digits = match.replace(/[^0-9]/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    }, counts);
  }

  if (on.has("digit-sequence")) {
    const minimum = Math.max(2, policy.minDigits);
    const pattern = new RegExp(`\\d(?:[ -]?\\d){${minimum - 1},}`, "g");
    out = replaceOutsideMasks(out, pattern, "digit-sequence", always, counts);
  }

  if (on.has("spoken-digit-sequence")) {
    const minimum = Math.max(2, policy.minSpokenDigits);
    out = replaceOutsideMasks(out, SPOKEN_RUN, "spoken-digit-sequence", (match) => {
      const words = match.split(/[\s,-]+/).filter((w) => w.length > 0);
      return words.length >= minimum;
    }, counts);
  }

  return { text: out, counts };
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_MIN_DIGITS = 4;

const asRun = (value: unknown, where: string, fallback: number): number => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 2 || value > 64) {
    throw new Error(`redaction: ${where} must be a whole number between 2 and 64`);
  }
  return value;
};

/**
 * A tenant's redaction rules, validated the same way the rest of their config is.
 *
 * Throws rather than dropping an unrecognised category. A tenant who writes `phone-number`
 * and gets silence has configured masking that is not happening, and would find out from a
 * payload rather than from the screen they typed it on.
 */
export const parseRedactionPolicy = (value: unknown, where = "redaction"): RedactionPolicy => {
  if (value === undefined || value === null) return NO_REDACTION;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`redaction: ${where} must be an object`);
  }
  const raw = value as Record<string, unknown>;

  const categories = raw.categories;
  if (categories !== undefined && !Array.isArray(categories)) {
    throw new Error(`redaction: ${where}.categories must be an array`);
  }

  const chosen: RedactionCategory[] = [];
  for (const entry of (categories ?? []) as unknown[]) {
    if (typeof entry !== "string" || !REDACTION_CATEGORIES.includes(entry as RedactionCategory)) {
      throw new Error(
        `redaction: ${where}.categories has an unknown entry; allowed: ${REDACTION_CATEGORIES.join(", ")}`,
      );
    }
    if (!chosen.includes(entry as RedactionCategory)) chosen.push(entry as RedactionCategory);
  }

  return {
    categories: chosen,
    minDigits: asRun(raw.minDigits, `${where}.minDigits`, DEFAULT_MIN_DIGITS),
    minSpokenDigits: asRun(raw.minSpokenDigits, `${where}.minSpokenDigits`, DEFAULT_MIN_DIGITS),
  };
};
