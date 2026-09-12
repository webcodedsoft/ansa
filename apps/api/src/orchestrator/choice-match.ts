/**
 * Which listed answer a caller meant, from what they actually said.
 *
 * A choice question lists its answers — "make a claim", "renew my policy" — and the model is
 * asked to record one of them. Callers do not speak in listed answers. They say "I want to
 * renew", "a claim please", "it's about my premium", and for a while the only accepted
 * record was an exact match, so the model was refused, told the list again, and asked the
 * same question again in the same words. That loop is what this file ends.
 *
 * Three readings, most literal first. The listed answer said whole. A listed answer that
 * contains what was said, or is contained in it. Then a single listed answer that shares a
 * distinctive word with what was said — "pay" finds "pay a premium"; "policy" finds nothing,
 * because three answers have it, and guessing between them would route a caller to the wrong
 * desk with no sign that anything went wrong. Null means "none of these", and the caller's
 * own words are kept instead, which is what a flow's "anything else" branch is for.
 */

/** Words that carry no meaning towards one answer rather than another. */
const NOISE: ReadonlySet<string> = new Set([
  "a", "an", "the", "my", "our", "your", "i", "id", "im", "ive", "we", "it", "its", "is", "am", "are", "to", "of",
  "for", "in", "on", "at", "or", "and", "but", "with", "about", "want", "wanted", "need", "like", "would",
  "please", "just", "get", "have", "has", "do", "can", "could", "me", "you", "this", "that", "some", "one",
  "yes", "no", "so", "um", "uh", "er", "ah", "well", "okay", "ok", "thanks", "thank",
]);

const words = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "" && !NOISE.has(word));

const flat = (text: string): string => words(text).join(" ");

/** The listed answer the caller meant, or null when it is none of them. */
export const closestOption = (options: readonly string[], spoken: string): string | null => {
  const said = spoken.trim().toLowerCase();
  if (said === "") return null;

  const exact = options.find((option) => option.trim().toLowerCase() === said);
  if (exact !== undefined) return exact;

  const saidFlat = flat(said);
  if (saidFlat === "") return null;
  const contained = options.filter((option) => {
    const optionFlat = flat(option);
    return optionFlat !== "" && (saidFlat.includes(optionFlat) || optionFlat.includes(saidFlat));
  });
  if (contained.length === 1) return contained[0] ?? null;
  // Two answers both containing what was said is not a reason to pick either.
  if (contained.length > 1) return null;

  /* The answer sharing the most distinctive words, if one answer is ahead. "cancel my
     policy" shares two with "cancel or change my policy" and one with "renew my policy";
     "my policy details" shares one with three answers, and one is not ahead of another. */
  const saidWords = new Set(words(said));
  const scored = options
    .map((option) => ({ option, shared: words(option).filter((word) => saidWords.has(word)).length }))
    .filter((entry) => entry.shared > 0)
    .sort((a, b) => b.shared - a.shared);
  const best = scored[0];
  if (best === undefined) return null;
  const tied = scored.filter((entry) => entry.shared === best.shared).length > 1;
  return tied ? null : best.option;
};
