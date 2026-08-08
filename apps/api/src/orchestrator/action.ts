/**
 * What the caller just did, so the reply can be the right length.
 *
 * A fixed reply cap is the wrong shape: "is my policy still active?" wants three words
 * back and "how do I make a claim?" legitimately wants thirty. People vary turn length
 * by what was asked, and the variation is large and well documented.
 *
 * Pure and exhaustively tested, because a misclassification is audible.
 */
export type CallerAction =
  | "polar" // yes/no or confirmation-seeking
  | "wh" // asks for one fact
  | "explanation" // asks how something works
  | "readback" // supplying a number or name to be confirmed
  | "troubles" // reporting a problem, no question asked
  | "greeting"
  | "closing"
  | "statement"; // unmatched — behaves as today

/**
 * Asks how something works, or what the conditions are. These deserve a long answer and
 * are the only category that does.
 *
 * High-precision cues only: a false positive here produces the over-long reply we are
 * trying to eliminate, so the list stays distinctive rather than broad.
 */
const EXPLANATION_CUES: readonly string[] = [
  "how do i",
  "how can i",
  "how does",
  "how would i",
  "what happens if",
  "what happens when",
  "what do i need",
  "what s the process",
  "what is the process",
  "walk me through",
  // "tell me about my policy" is short, but it is an open request for extended talk —
  // the one place a short turn legitimately wants a long answer.
  "tell me about",
  "tell me more",
  "what can you tell me",
  "explain",
  "step by step",
  "the steps",
  "how to",
  "why does",
  "why is",
  "how i fit",
  "how i go",
];

const WH_CUES: readonly string[] = [
  "what",
  "where",
  "when",
  "who",
  "which",
  "how much",
  "how many",
  "how long",
  "wetin",
];

/** Reporting a problem rather than asking a question. Affiliate, then ask one thing. */
const TROUBLES_CUES: readonly string[] = [
  "problem",
  "wahala",
  "nobody",
  "no one",
  "still not",
  "since",
  "i have been",
  "i ve been",
  "they didn t",
  "they did not",
  "not working",
  "keeps",
  "again and again",
  "complain",
  "annoyed",
  "frustrat",
];

const GREETINGS = new Set([
  "hello",
  "hi",
  "good morning",
  "good afternoon",
  "good evening",
  "good day",
  "how are you",
  "how far",
  "well done",
]);

const CLOSINGS = new Set([
  "thank you",
  "thanks",
  "that s all",
  "that is all",
  "bye",
  "goodbye",
  "ok bye",
  "no thank you",
  "nothing else",
  "we are good",
  "i am good",
]);

/** Four or more digits in a row is a policy or phone number being read out. */
const DIGIT_RUN = /\d{4,}/;

/**
 * A caller reading a number aloud produces WORDS, not digits: "eight five nine two six".
 * Only checking for digit runs missed every spoken number on a live call, so the turn was
 * typed as a short question and answered instead of read back.
 */
const NUMBER_WORDS = new Set([
  "zero", "oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "double", "triple",
]);

/** Four or more number words, however scattered, is someone reading something out. */
const readsOutANumber = (words: readonly string[]): boolean =>
  words.filter((w) => NUMBER_WORDS.has(w)).length >= 4;

const hasCue = (text: string, cues: readonly string[]): boolean =>
  cues.some((cue) => text.includes(cue));

const wordCount = (text: string): number => (text.length === 0 ? 0 : text.split(" ").length);

/**
 * `text` must already be normalised — lower case, punctuation flattened — by the same
 * `normalise` the backchannel and repair checks use. One flattener, not two.
 *
 * Order is deliberate and the obvious order would be wrong. Most polar questions in real
 * speech are declaratives with no auxiliary inversion ("so my policy is still active"),
 * so a `^(do|is|can|will)` test would catch the minority and miss the common case.
 * Instead, anything short that is not something else is treated as polar — a short
 * caller turn almost never wants a long answer, whichever grammatical form it took.
 */
export const classify = (text: string): CallerAction => {
  const flat = text.trim();
  if (flat.length === 0) return "statement";

  if (GREETINGS.has(flat)) return "greeting";
  if (CLOSINGS.has(flat)) return "closing";

  // Before wh, because "what do i need to claim" is an explanation, not a fact lookup.
  if (hasCue(flat, EXPLANATION_CUES)) return "explanation";

  const tokens = flat.split(" ");
  if (DIGIT_RUN.test(flat) || readsOutANumber(tokens)) return "readback";

  const words = wordCount(flat);
  const looksLikeQuestion = WH_CUES.some(
    (cue) => flat.startsWith(`${cue} `) || flat.includes(` ${cue} `),
  );

  if (looksLikeQuestion) return "wh";

  // Long, no question in it, and carrying trouble lexis: the caller is telling you
  // something is wrong. The right reply is short — acknowledge, then ask one thing.
  if (words > 20 && hasCue(flat, TROUBLES_CUES)) return "troubles";

  if (words <= 12) return "polar";
  return "statement";
};
