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
 * Picks at random but never the same one twice running.
 *
 * Round-robin was the obvious choice and is the wrong one: over a few turns a caller
 * hears the same cycle in the same order, which sounds like a recording rather than a
 * person. Random alone can repeat immediately, which sounds worse than either.
 */
export interface FillerPicker {
  next(pool: readonly string[]): string | null;
}

export const createFillerPicker = (random: () => number = Math.random): FillerPicker => {
  let last: string | null = null;

  return {
    next(pool) {
      if (pool.length === 0) return null;
      if (pool.length === 1) return pool[0] ?? null;

      const choices = pool.filter((p) => p !== last);
      const picked = choices[Math.floor(random() * choices.length)] ?? choices[0] ?? null;
      last = picked;
      return picked;
    },
  };
};
