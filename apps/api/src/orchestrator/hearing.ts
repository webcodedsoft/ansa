/**
 * What to make of a transcript before acting on it.
 *
 * Two separate jobs, deliberately kept apart:
 *
 *  - deciding whether it is speech at all, and
 *  - repairing words the transcriber is known to get wrong.
 *
 * The raw transcript is never altered. It is the eval corpus and the review loop's
 * ground truth (R9.2.3–4), and a corrected transcript recorded as if the caller said it
 * would poison the data Gate A depends on. Corrections are produced alongside it, for
 * the model only, and every one is reported so it can be audited from a real call.
 */

export type Hearing =
  | { readonly kind: "noise"; readonly reason: string }
  | {
      readonly kind: "speech";
      /** Exactly what the transcriber returned. Log this, store this. */
      readonly raw: string;
      /** What the model is given. Differs only where a correction fired. */
      readonly forModel: string;
      readonly corrections: readonly string[];
    };

/** Lower case, punctuation flattened — the shape a transcriber's output compares in. */
export const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Whisper-family models emit these from silence and line noise rather than from speech.
 *
 * Deliberately short, and deliberately excluding "thank you" and "bye": the model
 * hallucinates those, but callers also genuinely say them, and the two failures are not
 * symmetric. Letting noise through costs one wasted turn; ignoring a caller who spoke is
 * the agent appearing not to listen.
 */
const HALLUCINATIONS = new Set([
  "thanks for watching",
  "thanks for watching and see you next time",
  "please subscribe",
  "subscribe to my channel",
  "subtitles by the amara org community",
  "transcription by castingwords",
  "www mooji org",
  "you you",
  "the the",
]);

/**
 * A hallucinated run is the WHOLE utterance; emphasis is the start of one.
 *
 * The first version counted consecutive repeats and rejected at four — while its own
 * comment said "no no no is emphasis and people do say it". On a live call it threw away
 * "No. No. No. No. But if you... I want to get the details of my policy…", a hundred
 * characters of real speech, and the caller got eighteen seconds of stalling followed by
 * "sorry, I didn't catch that".
 *
 * So the test is now about the whole utterance, not a prefix of it: a transcript is
 * noise when it is several words long and made of almost nothing but one repeated word.
 * "you you you you" fails it; anything with real content after the emphasis does not.
 */
/**
 * Words that are worth hearing however many times they are said.
 *
 * A caller repeating "no" is not a stuck transcriber, it is the most emphatic thing they
 * can do — and during a readback it is the difference between the right number and the
 * wrong one. "No. No. No. No. No." was discarded as a repeated token on a live call,
 * immediately before the readback confirmed a value the caller was rejecting.
 */
const DECISION_WORDS = new Set([
  "no", "nope", "nah", "yes", "yeah", "yep", "stop", "wait", "wrong", "correct",
]);

const isJustRepetition = (words: readonly string[]): boolean => {
  if (words.length < 4) return false;
  const distinct = new Set(words);
  if (distinct.size > 2) return false;
  return ![...distinct].every((word) => DECISION_WORDS.has(word));
};

const isMostlyNonLatin = (text: string): boolean => {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  if (letters.length === 0) return false;
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  return latin / letters.length < 0.5;
};

/**
 * Corrections applied for the model's benefit only.
 *
 * Every entry is a multi-word phrase whose mistaken form means nothing in this context.
 * Single words are deliberately absent: "apology", "penalty" and "police" are all real
 * words a caller might mean, and silently rewriting them would be worse than the
 * mishearing. Those go to the model as a hint in the system prompt instead, where
 * surrounding context can disambiguate them.
 *
 * Observed on live calls: "policy" heard as apology, penalty, polling and course.
 */
const CORRECTIONS: readonly { readonly pattern: RegExp; readonly to: string }[] = [
  { pattern: /\b(polling|apology|apologies|penalty|police|pauci|paulie)\s+number\b/gi, to: "policy number" },
  { pattern: /\bmy\s+(polling|apology|penalty|police)\b(?!\s+number)/gi, to: "my policy" },
  { pattern: /\b(polling|apology|penalty)\s+(renew|renews|renewal|expires?|cover|covers)\b/gi, to: "policy $2" },
  { pattern: /\bpremiums?\s+number\b/gi, to: "premium" },
];

export const interpret = (text: string): Hearing => {
  const raw = text.trim();
  const flat = normalise(raw);

  if (raw.length === 0) return { kind: "noise", reason: "empty" };

  // Checked against the raw text and checked FIRST: normalise() strips everything
  // outside [a-z0-9 ], so a non-Latin transcript would otherwise arrive here as an
  // empty string and be reported as silence. Those are different failures — a caller
  // who said nothing versus a model that left the language — and the log has to tell
  // them apart or the next person debugging this loses an hour.
  //
  // Observed: Malayalam script returned from Nigerian-accented English with language
  // "en" set explicitly.
  if (isMostlyNonLatin(raw)) return { kind: "noise", reason: "not latin script" };

  if (flat.length === 0) return { kind: "noise", reason: "empty" };
  // A single letter or digit is a click, a breath, or the tail of a word.
  if (flat.length < 2) return { kind: "noise", reason: "too short" };
  if (HALLUCINATIONS.has(flat)) return { kind: "noise", reason: "known hallucination" };
  if (isJustRepetition(flat.split(" "))) return { kind: "noise", reason: "repeated token" };

  let forModel = raw;
  const corrections: string[] = [];
  for (const { pattern, to } of CORRECTIONS) {
    const before = forModel;
    forModel = forModel.replace(pattern, to);
    if (forModel !== before) corrections.push(`${before} -> ${forModel}`);
  }

  return { kind: "speech", raw, forModel, corrections };
};
