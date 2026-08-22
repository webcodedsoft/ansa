/**
 * Short sounds played into the gap while the agent is thinking.
 *
 * Split into two registers because that is what people do. The first noise after
 * someone stops speaking says "I heard you"; a second one, seconds later, has to say
 * "I am still working on it" — repeating "mm-hm" there sounds like the line is stuck.
 *
 * R6.2 requires any gap over two seconds to produce sound, and measured turns run
 * 1.3-2.3s, so the first tier fires on most turns and the second only on slow ones.
 */

/** Immediate, content-free. The caller has just stopped speaking. */
export const ACKNOWLEDGEMENTS: readonly string[] = [
  "Mm-hm.",
  "Okay.",
  "Right.",
  "I see.",
  "Sure.",
  "Alright.",
  "Mm.",
  "Got it.",
];

/** Seconds in. The caller needs to know something is happening, not just that they were heard. */
export const PROGRESS: readonly string[] = [
  "Let me check that.",
  "One moment.",
  "Just a second.",
  "Let me see.",
  "Bear with me.",
  "Give me one moment.",
];

/** Well past comfortable. Acknowledges the wait rather than pretending it is normal. */
export const STILL_WORKING: readonly string[] = [
  "Still checking that for you.",
  "Almost there.",
  "Sorry, just one more moment.",
];

export const ALL_FILLERS: readonly string[] = [
  ...ACKNOWLEDGEMENTS,
  ...PROGRESS,
  ...STILL_WORKING,
];

/**
 * Picks at random, and does not say the same thing twice on one call.
 *
 * Round-robin was the obvious choice and is the wrong one: over a few turns a caller
 * hears the same cycle in the same order, which sounds like a recording rather than a
 * person. Random alone can repeat immediately, which sounds worse than either.
 *
 * Avoiding only the immediately preceding phrase was not enough. Eight acknowledgements
 * across a twelve-turn call means the caller hears "Mm-hm" three or four times, and one
 * repeat inside a single call is more damaging than a slightly less apt phrase — a person
 * does not have eight stock noises, but they do not reuse one either. So a picker is one
 * per call and remembers everything it has said.
 *
 * When the pool is exhausted it starts again rather than falling silent. Silence where the
 * caller expects a sound is the failure R6.2 exists to prevent, and it is a worse outcome
 * than a repeat on the ninth wait of one conversation.
 */
export interface FillerPicker {
  next(pool: readonly string[]): string | null;
}

export const createFillerPicker = (random: () => number = Math.random): FillerPicker => {
  let last: string | null = null;
  const used = new Set<string>();

  return {
    next(pool) {
      if (pool.length === 0) return null;
      if (pool.length === 1) return pool[0] ?? null;

      const fresh = pool.filter((p) => !used.has(p));
      /* Everything in this tier has been said. Forget the tier and start over rather than
         going quiet — and only this tier, because the other tiers have not been used up
         and their memory is still doing its job. */
      if (fresh.length === 0) for (const phrase of pool) used.delete(phrase);

      const choices = (fresh.length === 0 ? pool : fresh).filter((p) => p !== last);
      const picked = choices[Math.floor(random() * choices.length)] ?? choices[0] ?? null;
      if (picked !== null) used.add(picked);
      last = picked;
      return picked;
    },
  };
};
