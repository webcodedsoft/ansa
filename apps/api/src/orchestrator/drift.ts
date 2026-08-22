/**
 * The prompt losing, slowly, in ways one call never shows.
 *
 * Models regress toward prose. An agent told to answer in one or two sentences does so for
 * a while and then starts writing paragraphs; an agent told never to use markdown starts
 * emitting asterisks somewhere around the point the conversation gets complicated. Neither
 * is visible on the call it happens on — the caller hears a slightly long answer, or hears
 * nothing wrong at all, because the normalizer stripped the asterisks on the way out.
 *
 * So both are counted, with the turn number attached. The brief's question is the right
 * one: if violations cluster after turn fifteen the prompt is not what is failing, the
 * *history* is, and that is a different fix from rewording anything.
 *
 * **Nothing here changes what the caller hears.** `@ansa/normalizer` already strips the
 * markdown and the emoji and `turn-budget` already caps the words. This writes down that
 * they had to, which is the part nobody could see.
 */

/**
 * Characters that mean something on a screen and nothing out loud.
 *
 * The same family the normalizer removes, asked as a question rather than performed as a
 * transformation. Comparing the text before and after `forSpeech` would have been the
 * obvious implementation and the wrong one: expanding numbers is also its job, so every
 * reply containing a figure would report as drift.
 */
const SCREEN_ONLY = [
  /\*\*|__|[*_`#]/,
  /^[ \t]*[-+•][ \t]+/m,
  /^[ \t]*\d+\.[ \t]+/m,
  /\[[^\]]+\]\([^)]*\)/,
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
];

/** The brief's ceiling, and the prompt's: one or two, with three as the hard limit. */
const MAX_SENTENCES = 3;

export interface DriftSignals {
  readonly sentences: number;
  /** More than three. The prompt asks for two and tolerates three; four is drift. */
  readonly tooLong: boolean;
  /** Markdown, bullets, links or emoji — things a voice reads out as their own names. */
  readonly screenFormatting: boolean;
  /** True when either fired, so a caller has one thing to branch on. */
  readonly drifted: boolean;
}

/**
 * Counted on terminal punctuation, which is what the sentence buffer splits on too.
 *
 * Abbreviations are not special-cased here even though they are in `sentences.ts`, and the
 * difference is deliberate. There, a wrong split cuts a caller's audio mid-phrase and
 * matters. Here, "Mr. Adeyemi" counting as two costs one false signal in a thousand turns,
 * and avoiding it would cost a second copy of that logic to keep in step.
 */
const countSentences = (text: string): number =>
  text
    .split(/[.!?]+(?:\s|$)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;

export const driftIn = (reply: string): DriftSignals => {
  const text = reply.trim();
  if (text === "") {
    return { sentences: 0, tooLong: false, screenFormatting: false, drifted: false };
  }

  const sentences = countSentences(text);
  const tooLong = sentences > MAX_SENTENCES;
  const screenFormatting = SCREEN_ONLY.some((pattern) => pattern.test(text));

  return { sentences, tooLong, screenFormatting, drifted: tooLong || screenFormatting };
};
