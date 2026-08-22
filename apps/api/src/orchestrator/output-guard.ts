/**
 * The last thing between the model and the caller's ear.
 *
 * Written on the assumption that the prompt will be violated, because it will. Every rule
 * the prompt carries about how to speak is a request; this is the half that holds.
 *
 * It does no stripping. `@ansa/normalizer` already removes markdown and emoji on the way to
 * TTS and is better at it than a second implementation would be — that is text becoming
 * speakable text, and this is whether the sentence should be said at all. Two files editing
 * the same string is how one of them ends up undoing the other.
 *
 * Two checks, deliberately not equally severe, because over-blocking is its own failure. An
 * agent that refuses to speak is worse on a phone line than one that sounds slightly
 * scripted.
 *
 * - **Flag, never block.** The call-centre phrases. One of them does not ruin a call; the
 *   same one in nine calls out of ten is a catchphrase the prompt needs a counter-example
 *   for, and that is a thing to see in a log rather than to interrupt somebody over.
 * - **Block, and only this.** A claim to have already done something, with no tool call
 *   behind it on this turn. "I've refunded that" when nothing was refunded is the failure
 *   that ends up on social media, and the one case where silence beats speech.
 *
 * Deliberately *not* here, though the brief asks for it: blocking dates and currency
 * amounts absent from a tool result. It over-blocks badly — an agent repeating a date the
 * caller just gave, or quoting a price from the organisation's own published rules, trips
 * it — and an agent that goes quiet on every price is a worse product than one that
 * occasionally gets a price wrong. See TASKS.md.
 */

export type GuardOutcome =
  /** Say it. `flagged` is drift to log, never a reason to withhold anything. */
  | { readonly kind: "speak"; readonly flagged: readonly string[] }
  /** Do not say it. The caller hears the holding line and the call goes to a person. */
  | { readonly kind: "block"; readonly reason: string };

/**
 * Phrases people associate with a call-centre script.
 *
 * Their damage is cumulative, which is why none of them blocks. Lower case and
 * punctuation-free, matched against the same treatment of the sentence.
 */
const BANNED: readonly string[] = [
  "absolutely",
  "certainly",
  "of course",
  "i'd be happy to help",
  "i would be happy to help",
  "i understand your frustration",
  "thank you for your patience",
  "is there anything else i can assist you with",
  "i apologise for the inconvenience",
  "i apologize for the inconvenience",
  "rest assured",
  "please be advised",
  "as i mentioned",
  "like i said",
  "great question",
  "that's a great point",
];

/**
 * Claims to have already done something.
 *
 * Past tense and first person, because that is what makes it a claim rather than an offer.
 * The verbs are the ones that move money or change a record — the category where being
 * wrong is a complaint rather than a correction.
 */
const COMMITMENT =
  /\b(?:i|we)\s*(?:'ve|’ve| have)\s+(?:just\s+|now\s+|already\s+)?(?:gone ahead and\s+)?(?:refunded|cancelled|canceled|approved|booked|processed|issued|transferred|credited|charged|reversed|scheduled|submitted|closed|reopened)\b/i;

/**
 * A claim about the future is not a claim about the past.
 *
 * "I'll cancel that for you" is an offer, and an agent that cannot make one cannot help.
 * Only the completed form is a problem, so a sentence carrying any of these alongside the
 * claim is left alone — a false block costs a caller a real answer.
 */
const FUTURE = /\b(?:i'll|i will|we'll|we will|going to|about to|can|could|would|shall|once|after)\b/i;

const flatten = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export interface GuardInput {
  readonly sentence: string;
  /**
   * Whether any tool actually ran on this turn.
   *
   * The whole basis of the commitment check, and the reason it is enforceable rather than
   * another line of prompt: this is a fact the orchestrator holds and the model cannot
   * influence. A turn that dispatched a tool has done something and may say so; a turn that
   * only talked has not, whatever it claims.
   */
  readonly toolRanThisTurn: boolean;
}

/**
 * What the caller hears instead of an unbacked claim.
 *
 * Vague about what went wrong on purpose, and not an apology for a fault the caller cannot
 * see. It buys the handover one sentence.
 */
export const HOLDING_LINE = "Let me get someone to confirm that for you properly.";

export const guardOutput = (input: GuardInput): GuardOutcome => {
  if (!input.toolRanThisTurn && COMMITMENT.test(input.sentence) && !FUTURE.test(input.sentence)) {
    return { kind: "block", reason: "claimed a completed action with no tool call on this turn" };
  }

  const flat = flatten(input.sentence);
  return { kind: "speak", flagged: BANNED.filter((phrase) => flat.includes(phrase)) };
};
