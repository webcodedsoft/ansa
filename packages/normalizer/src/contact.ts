/**
 * Contact details: phone numbers, email addresses, street addresses.
 *
 * All three share a property that makes them different from a policy number: they are
 * how the caller is reached afterwards. A wrong reference produces "I can't find that",
 * which the caller hears. A wrong phone number or email produces silence a week later,
 * which nobody hears until it is a complaint. That asymmetry is why none of these can be
 * captured without a readback, and why the readback for an email spells the local part
 * rather than saying it as a word.
 *
 * Pure: text in, value out. No lookups, no validation service, no network.
 */

import { sayDigits } from "./digits";

/* ------------------------------------------------------------------ phone */

/**
 * Nigerian mobile numbers.
 *
 * Eleven digits beginning 070, 080, 081, 090, 091 and so on — the second digit is always
 * 7, 8 or 9. That is enough of a shape to catch the common failure, which is a
 * transcriber dropping or inventing a digit, without hardcoding a carrier prefix list
 * that goes stale every time the NCC allocates a new range.
 */
const NIGERIAN_MOBILE = /^0[789]\d{9}$/;

/**
 * Whether a value is a usable Nigerian mobile number.
 *
 * Landlines exist and are not covered. They are vanishingly rare as a callback number in
 * this market, and accepting anything eleven digits long would let a mangled policy
 * number through as a phone number, which is the worse mistake.
 */
export const isNigerianMobile = (value: string): boolean => NIGERIAN_MOBILE.test(value);

/**
 * Digits from a caller into a canonical `0XXXXXXXXXX`.
 *
 * Three forms all mean the same number and callers use all three: the local `0803…`,
 * the international `+234 803…`, and the bare `803…` that people give when they have
 * already said "zero eight". Storing three spellings of one number is how a callback
 * ends up sent twice.
 */
export const canonicalPhone = (digits: string): string | null => {
  const bare = digits.replace(/\D/g, "");

  if (NIGERIAN_MOBILE.test(bare)) return bare;
  // +234 or 234 prefix: drop it and restore the national trunk zero.
  if (/^234[789]\d{9}$/.test(bare)) {
    const local = `0${bare.slice(3)}`;
    return NIGERIAN_MOBILE.test(local) ? local : null;
  }
  // Ten digits starting 7, 8 or 9: the caller dropped the leading zero.
  if (/^[789]\d{9}$/.test(bare)) return `0${bare}`;

  return null;
};

/**
 * Said back grouped 0803 817 8550, which is how it is written on a business card.
 *
 * A distinct name from `sayDigits` for the same reason `sayReference` is: when phone
 * grouping and reference grouping need to diverge, the call sites are already
 * distinguishable.
 */
export const sayPhone = (value: string): string => sayDigits(value);

/* ------------------------------------------------------------------ email */

/**
 * Deliberately loose. A strict RFC 5322 pattern rejects addresses that work and this
 * runs on a transcript, where the realistic failure is "gmail dot" with no TLD, not an
 * exotic-but-legal local part.
 */
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

export const isEmail = (value: string): boolean => EMAIL.test(value);

/** Spoken punctuation. "dot" is the only one most callers use; the rest appear enough to matter. */
const SPOKEN_PUNCTUATION: Readonly<Record<string, string>> = {
  dot: ".", point: ".", period: ".", full: "", stop: ".",
  underscore: "_", under: "_", score: "_",
  dash: "-", hyphen: "-", minus: "-",
  plus: "+",
};

const SPOKEN_DIGITS: Readonly<Record<string, string>> = {
  zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

/**
 * Words that end the address on their left.
 *
 * The local part is whatever runs up to "at" without crossing one of these. Taking
 * everything before "at" instead is what turned "my email at work is sikiru at gmail dot
 * com" into "worksikiru" — the sentence has two "at"s and a noun phrase in front of the
 * real one. Single letters are deliberately absent: "i" and "a" are letters far more
 * often than words inside a dictated address.
 */
const EMAIL_STOP = [
  "is", "its", "it", "so", "and", "then", "please", "okay", "ok", "yes", "yeah",
  "well", "um", "erm", "er", "to", "was", "be", "sure", "right", "thats", "that",
];

/** Lead-ins stripped only from the front of what is left. */
const EMAIL_LEAD_IN = ["my", "the", "email", "address", "mail"];

const emailPart = (tokens: readonly string[]): string => {
  let out = "";
  for (const raw of tokens) {
    const token = raw.toLowerCase();
    const punctuation = SPOKEN_PUNCTUATION[token];
    if (punctuation !== undefined) { out += punctuation; continue; }
    const digit = SPOKEN_DIGITS[token];
    // "o" is a letter far more often than a zero inside an email, so only the
    // unambiguous spellings map to digits here — the opposite of a phone number.
    if (digit !== undefined && token !== "o" && token !== "oh") { out += digit; continue; }
    out += token.replace(/[^a-z0-9._%+-]/g, "");
  }
  return out;
};

/**
 * An email address the caller dictated.
 *
 * Two shapes arrive. The transcriber sometimes assembles it — "sikiru@gmail.com" — and
 * that is taken as-is. More often it comes out as words: "s i k i r u at gmail dot com".
 * Both have to land on the same string, because the caller believes they said the same
 * address either way.
 */
export const parseSpokenEmail = (text: string): string | null => {
  const literal = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(text);
  if (literal !== null) {
    const value = literal[0].toLowerCase().replace(/\.$/, "");
    return isEmail(value) ? value : null;
  }

  const tokens = text.toLowerCase().replace(/[^a-z0-9\s._%+@-]/g, " ").split(/\s+/).filter((t) => t !== "");

  // "at" splits local from domain. The last one wins: "my email, at work, is x at
  // gmail dot com" has two and only the second is the separator.
  const at = tokens.lastIndexOf("at");
  if (at <= 0 || at === tokens.length - 1) return null;

  let start = at;
  while (start > 0 && !EMAIL_STOP.includes(tokens[start - 1] ?? "")) start -= 1;
  while (start < at && EMAIL_LEAD_IN.includes(tokens[start] ?? "")) start += 1;

  const local = emailPart(tokens.slice(start, at));
  const domain = emailPart(tokens.slice(at + 1));
  if (local === "" || domain === "") return null;

  const value = `${local}@${domain}`.replace(/\.+$/, "");
  return isEmail(value) ? value : null;
};

const spellOut = (value: string): string =>
  [...value]
    .map((char) => (/[0-9]/.test(char) ? sayDigits(char) : char.toUpperCase()))
    .join(", ");

/**
 * A domain label said aloud.
 *
 * Two characters or fewer is said as letters and anything longer as a word. That is a
 * structural rule about pronounceability, not a list of domains: no two-letter string is
 * reliably a word, so ".ng" and ".uk" have to be "N G" and "U K", while "com", "net" and
 * any provider name long enough to have a shape are said.
 *
 * An earlier version of this held a set of well-known providers and spelled anything
 * outside it. That was a whitelist of literal values in a branch, and it would have made
 * the agent worse at exactly the addresses it has never seen — which is all of the
 * interesting ones.
 */
const sayLabel = (label: string): string =>
  label.length <= 2 ? [...label].map((c) => c.toUpperCase()).join(" ") : label;

/**
 * An email read back the way a person reads one back: the local part spelled, the domain
 * said.
 *
 * The split is structural, not a matter of familiarity. The local part is arbitrary and
 * unguessable — "sikiru" and "sekiru" are identical at 8kHz and that is where the
 * mistake actually is, so it is spelled. The domain is a published string the caller
 * chose from a handful and recognises instantly by sound, so spelling it is six seconds
 * of "G, M, A, I, L" spent checking the one part nobody gets wrong.
 */
export const sayEmail = (value: string): string => {
  const [local = "", domain = ""] = value.split("@");
  const spokenLocal = local
    .split(".")
    .map(spellOut)
    .join(", dot, ");
  const spokenDomain = domain.split(".").map(sayLabel).join(" dot ");
  return `${spokenLocal}, at ${spokenDomain}`;
};

/* ---------------------------------------------------------------- address */

/**
 * Words that make a run of text an address rather than a sentence.
 *
 * Nigerian addresses lead with a plot or house number and a street type, and very often
 * an estate or an area — "Plot 14, Adeola Odeku Street, Victoria Island, Lagos". The cue
 * list is what stops "I live with my mother" being stored as an address.
 */
const ADDRESS_CUE =
  /\b(street|st|road|rd|avenue|ave|close|crescent|drive|lane|way|boulevard|estate|plot|block|flat|suite|apartment|apt|house|no|number|off|junction|roundabout|island|layout|gra|phase|zone)\b/i;

/** Lead-ins a caller puts in front of an address that are not part of it. */
const ADDRESS_LEAD_IN =
  /^(?:(?:yes|yeah|okay|ok|so|erm|um|well)[,\s]+)*(?:(?:it'?s|its|it is|i live at|i'?m at|i am at|my address is|the address is|address is|send it to|deliver(?: it)? to)\s+)?/i;

/**
 * An address is not parsed into fields, and that is a decision rather than a shortcut.
 *
 * Nigerian addresses have no reliable structure to parse into — no postcode in practice,
 * street types spelled six ways, estates that are sometimes the street and sometimes the
 * area. Any field-splitting we invent would be wrong often enough to corrupt the value,
 * and a tenant's own system takes a single line anyway. What the caller said, tidied, is
 * both the most accurate thing available and the thing they can check when it is read
 * back.
 */
export const tidyAddress = (text: string): string | null => {
  const trimmed = text.trim().replace(ADDRESS_LEAD_IN, "").trim().replace(/[.\s]+$/, "");
  if (trimmed === "") return null;
  // Two words is not an address, it is the word "street" with something in front of it.
  if (trimmed.split(/\s+/).length < 3) return null;
  return trimmed.replace(/\s{2,}/g, " ");
};

/**
 * An address the caller volunteered, which needs a cue word to be recognised as one at
 * all. When the agent has just *asked* for the address, use `tidyAddress`: the answer to
 * "what's the address?" is an address whether or not it happens to contain "street".
 */
export const parseSpokenAddress = (text: string): string | null =>
  ADDRESS_CUE.test(text) ? tidyAddress(text) : null;

/**
 * Read back with a pause between the parts, because an address is checked one line at a
 * time. `forSpeech` supplies the digit handling — "Plot 14" must not become "Plot
 * fourteen thousand".
 */
export const sayAddress = (value: string): string => value.replace(/\s*,\s*/g, ", ");
