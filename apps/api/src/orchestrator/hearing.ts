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

/** Runs of the same word. Four, because "no no no" is emphasis and people do say it. */
const REPEATED_TOKEN_LIMIT = 4;

const isMostlyNonLatin = (text: string): boolean => {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  if (letters.length === 0) return false;
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  return latin / letters.length < 0.5;
};

const hasRepeatedToken = (words: readonly string[]): boolean => {
  let run = 1;
  for (let i = 1; i < words.length; i += 1) {
    run = words[i] === words[i - 1] ? run + 1 : 1;
    if (run >= REPEATED_TOKEN_LIMIT) return true;
  }
  return false;
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
  if (hasRepeatedToken(flat.split(" "))) return { kind: "noise", reason: "repeated token" };

  let forModel = raw;
  const corrections: string[] = [];
  for (const { pattern, to } of CORRECTIONS) {
    const before = forModel;
    forModel = forModel.replace(pattern, to);
    if (forModel !== before) corrections.push(`${before} -> ${forModel}`);
  }

  return { kind: "speech", raw, forModel, corrections };
};
