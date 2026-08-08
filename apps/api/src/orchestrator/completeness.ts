/**
 * Whether a caller's turn ended mid-thought.
 *
 * Turn detectors commit on silence and prosody, not on syntax, so a caller who pauses to
 * remember something gets cut. On a live call the transcript was "Hi. Good morning. My
 * name is." — the detector fired on a dangling copula, the agent started talking, and it
 * talked straight over the name. The caller's experience was giving their name and being
 * ignored; the name never reached a transcript at all.
 *
 * Waiting a beat on a syntactically impossible ending costs a fraction of a second on the
 * rare false positive and saves the whole utterance on a true one.
 */

/**
 * Words an English utterance essentially cannot end on.
 *
 * Deliberately conservative. "can", "do", "will" and "would" are absent even though they
 * dangle just as often, because "yes I can", "what do you do" and "I will" are complete
 * turns and making every one of them wait would add latency to ordinary conversation for
 * no gain.
 */
const CANNOT_END: ReadonlySet<string> = new Set([
  // copulas and auxiliaries
  "is", "are", "am", "was", "were", "be", "being", "been",
  // determiners and possessives
  "my", "your", "his", "her", "its", "our", "their", "the", "a", "an",
  // prepositions and conjunctions
  "to", "of", "for", "and", "but", "or", "with", "at", "in", "on", "from",
  "about", "than", "into", "onto", "upon",
  // pronouns and contractions that must be followed by something
  "i", "im", "ive", "id", "thats", "its", "theres", "wheres",
  // verbs that take an obligatory complement
  "called", "named", "spelt", "spelled",
]);

/**
 * `text` must already be normalised — lower case, punctuation flattened — by the same
 * `normalise` the rest of the turn loop uses.
 */
export const endsMidThought = (text: string): boolean => {
  const words = text.trim().split(/\s+/).filter((w) => w !== "");
  const last = words[words.length - 1];
  if (last === undefined) return false;

  // A lone dangling word is a false start, not an unfinished sentence — answering "and?"
  // with silence would be its own bug.
  if (words.length < 2) return false;

  return CANNOT_END.has(last);
};
