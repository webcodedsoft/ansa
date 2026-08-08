import type { CallerAction } from "./action";

/**
 * How much the agent may say in reply, in the units a caller actually experiences.
 *
 * Words, not tokens. A token cap was never a length control here — at a realistic
 * speaking rate, the cap that was in place allowed about twelve seconds of speech and
 * never once bound, while replies ran to a 4.6s median. What was actually cutting turns
 * short was a fixed two-sentence limit, which is equally blind to what was asked.
 */
export interface TurnBudget {
  readonly action: CallerAction;
  /** The control. Enforced in the dispatch path, not requested in the prompt. */
  readonly maxWords: number;
  /** Sentences. Secondary — a single long sentence is still too long. */
  readonly maxUnits: number;
  /** Runaway guard only. Deliberately generous; maxWords does the work. */
  readonly maxTokens: number;
  /** Appended to the system prompt. The soft half; the caps are the hard half. */
  readonly instruction: string;
}

/** Roughly the average English word plus its trailing space. */
const CHARS_PER_WORD = 5.2;

interface Shape {
  readonly maxWords: number;
  readonly maxUnits: number;
  readonly instruction: string;
}

/**
 * Answers to yes/no questions are overwhelmingly just the yes or the no, sometimes with
 * a short elaboration. Explanations are the one category where holding the floor is what
 * the caller asked for.
 */
const SHAPES: Readonly<Record<CallerAction, Shape>> = {
  closing: {
    maxWords: 6,
    maxUnits: 1,
    instruction: "They are ending the call. Say goodbye warmly in a few words. Nothing else.",
  },
  polar: {
    maxWords: 8,
    maxUnits: 1,
    instruction:
      "Answer yes or no first, then at most a short clause. Do not explain unless asked.",
  },
  greeting: {
    maxWords: 10,
    maxUnits: 1,
    instruction: "Greet them back briefly and ask how you can help. One short sentence.",
  },
  troubles: {
    maxWords: 12,
    maxUnits: 1,
    instruction:
      "They are telling you something is wrong. Acknowledge it in a few words, then ask " +
      "one short question. Do not explain or apologise at length.",
  },
  readback: {
    maxWords: 14,
    maxUnits: 1,
    instruction:
      "They gave you a number. Read it back to confirm, and nothing else. One item only.",
  },
  wh: {
    maxWords: 16,
    maxUnits: 1,
    instruction: "Give the one fact they asked for. One short sentence. Do not elaborate.",
  },
  statement: {
    maxWords: 22,
    maxUnits: 2,
    instruction: "Reply in one short sentence, two at the very most.",
  },
  explanation: {
    maxWords: 40,
    maxUnits: 3,
    instruction:
      "They asked how something works, so a longer answer is right — but give the first " +
      "step or two and stop, then let them ask. Do not list everything at once.",
  },
};

export const budgetFor = (action: CallerAction): TurnBudget => {
  const shape = SHAPES[action];
  return {
    action,
    maxWords: shape.maxWords,
    maxUnits: shape.maxUnits,
    // Generous on purpose: this exists only to stop a runaway generation, and a tight
    // token cap guillotines mid-clause, which the caller hears as a cut-off word.
    maxTokens: Math.min(160, Math.max(48, Math.round(shape.maxWords * 2.5))),
    instruction: shape.instruction,
  };
};

/** Roughly how long a budget's worth of speech takes to say. For logging, not control. */
export const budgetMs = (budget: TurnBudget, charsPerSecond: number): number =>
  Math.round((budget.maxWords * CHARS_PER_WORD * 1000) / Math.max(1, charsPerSecond));
