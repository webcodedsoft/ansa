/**
 * Somebody asking never to be called again.
 *
 * The consent gate has checked suppression before anything else since it was written —
 * before consent, before hours — and the table it checks had no writer. Every row in it was
 * put there by hand. This is the writer's trigger.
 *
 * Deliberately separate from `asksForAPerson`. The two read alike and mean opposite things:
 * one is a request to continue the conversation elsewhere, the other is a request to end
 * the relationship. Folding them together would put "get me a manager" onto a permanent
 * suppression list, which is a worse failure than any amount of duplication here.
 *
 * **Errs toward recording.** A false positive costs one customer one unwanted call that
 * never happens; a false negative is a regulatory breach and, more to the point, somebody
 * being rung again after asking us not to be. Those are not comparable, so this does not
 * try to be clever about ambiguity — but it does insist on an actual instruction, because
 * "they keep calling me about this" is a complaint and not a request.
 */

/**
 * Unambiguous whatever surrounds them. Each is a complete instruction on its own, and there
 * is no ordinary sentence in which one appears meaning something else.
 */
const OUTRIGHT: readonly string[] = [
  "do not call me again",
  "dont call me again",
  "don t call me again",
  "never call me again",
  "stop calling me",
  "stop calling this number",
  "quit calling me",
  "take me off your list",
  "take me off the list",
  "take me off your calling list",
  "remove me from your list",
  "remove my number",
  "delete my number",
  "unsubscribe me",
  "opt me out",
  "no dey call me again",
  "abeg no call me again",
  "make you no call me again",
  "no call this number again",
];

/**
 * The instruction, split so it survives the words people put in the middle: "don't ever
 * call me again", "please stop calling this number". All three parts must land in one
 * clause, which is what keeps it off "they keep calling me about this".
 */
const NEGATION = /\b(?:do ?n'?t|dont|never|stop|quit|cease)\b/;
const CALLING = /\b(?:call|calling|ring|ringing|phone|phoning|contact|contacting)\b/;
const AGAIN = /\b(?:again|any ?more|no more|ever)\b/;

/**
 * A complaint about being called is not a request to stop being called.
 *
 * "You keep calling me" and "somebody called me again yesterday" both carry the words and
 * neither is an instruction. Checked per clause, so "you keep calling me — take me off your
 * list" still records: the outright list catches the second half whatever the first says.
 */
const COMPLAINT = /\b(?:keep|kept|keeps|already|yesterday|earlier|twice|three times)\b/;

const flatten = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * True when the caller asked not to be contacted again.
 *
 * The caller on any call, not only an outbound one. Somebody ringing in specially to say it
 * means it exactly as much as an outbound recipient does, and a suppression list that only
 * listened on outbound calls would fail at precisely that moment.
 */
export const asksToNotBeCalled = (text: string): boolean => {
  const flat = flatten(text);
  if (flat.length === 0) return false;
  if (OUTRIGHT.some((phrase) => flat.includes(phrase))) return true;

  /* Split on the joins people actually use, so one instruction inside a longer sentence is
     still found and a complaint in the other half does not suppress it. */
  for (const clause of flat.split(/\b(?:and|but|because|so)\b/)) {
    if (COMPLAINT.test(clause)) continue;
    if (NEGATION.test(clause) && CALLING.test(clause) && AGAIN.test(clause)) return true;
  }
  return false;
};
