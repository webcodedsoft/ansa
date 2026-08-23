import { normalise } from "./hearing";

/**
 * Answering the question the caller actually asked, when the form takes the turn.
 *
 * Read off the call at 17:32 on 2026-08-23:
 *
 *   caller  Hi. Good evening. My name is Sikir. How are you doing?
 *   agent   Sikir — have I got that right?
 *
 * They asked how it was, and it read their name back at them. Not rudeness in the prompt —
 * the prompt says to answer what they said before moving on — but the capture engine
 * handles that turn and returns before the model ever sees it, so no instruction to the
 * model could have helped. It is the difference between the reference transcript's "Hello
 * Bill, I am doing very well today, thank you for asking" and a form being filled in.
 *
 * Deliberately narrow. Only a *question* about how the agent is, because a bare "good
 * evening" needs no answer — the greeting has already been spoken and answering it again
 * is the double-greeting the prompt spends a rule on.
 */

/**
 * `GREETINGS` in `action.ts` cannot do this: it matches a whole flattened turn against a
 * set, so it fires on "how are you" alone and never on it inside a sentence — which is
 * where it always is.
 */
const ASKING_AFTER_YOU: readonly RegExp[] = [
  /\bhow are you\b/,
  /\bhow are things\b/,
  /\bhow you doing\b/,
  /\bhow is it going\b/,
  /\bhow s it going\b/,
  /\bhope you re well\b/,
  /\bhope you are well\b/,
  // Nigerian English. "How far" is a greeting and a question at once, and "how you dey"
  // is Pidgin for the same thing — both expect an answer.
  /\bhow far\b/,
  /\bhow you dey\b/,
  /\bhow body\b/,
];

/**
 * Several, because one would become a catchphrase.
 *
 * `variation.ts` tells the model never to let a phrase become its signature, and a fixed
 * string generated in code would be exactly that — said identically to every caller who
 * ever asks, on a line where the same person may ring twice in a week.
 */
export const COURTESY_REPLIES: readonly string[] = [
  "I'm well, thank you.",
  "Very well, thanks for asking.",
  "Good, thank you.",
  "All good here, thanks.",
  "I'm fine, thank you.",
];

export const asksAfterYou = (text: string): boolean => {
  const flat = normalise(text);
  return ASKING_AFTER_YOU.some((pattern) => pattern.test(flat));
};

/**
 * The courtesy in front of whatever the turn was already going to say.
 *
 * Joined rather than spoken separately so it is one turn: two utterances would give the
 * caller a gap to start talking into, and the second half would then be an interruption of
 * their own answer.
 */
export const withCourtesy = (reply: string, line: string): string => `${reply} ${line}`;
