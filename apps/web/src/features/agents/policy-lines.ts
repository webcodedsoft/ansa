/**
 * Making "one per line" true rather than merely asked for.
 *
 * The three policy lists are textareas with a hint under them reading "One per line.", and a
 * hint is not a rule. Nothing stopped somebody pasting a numbered list out of a staff handbook
 * and publishing "1. Issue a refund within 14 days" as the literal text of one entry, or typing
 * three rules on one line and getting one long entry the model reads as a single instruction.
 *
 * It cannot be fixed by validating, and that is the whole design constraint. "Refund the order,
 * minus shipping" is one entry and "Issue refunds, explain the timeline" is two, and nothing in
 * the text tells them apart — a rule that guessed would be wrong often enough that people would
 * learn to write around it, which is worse than the hint. So this module does the two things
 * that are safe instead:
 *
 * - **Paste is normalised**, because paste is unambiguous. Bullets, numbering and CRLF are
 *   somebody else's formatting arriving with the words; stripping them is what the person
 *   pasting meant to happen and would otherwise do by hand.
 * - **A line that looks like several is reported, never split.** The suggestion comes with the
 *   parts it would produce, so a wrong guess costs a glance rather than an entry.
 *
 * The one hard limit is still `MAX_LINE`, enforced where it was already: an over-long line
 * blocks publishing in `policy-tab.tsx` rather than being silently cut.
 */

/**
 * Somebody else's list formatting.
 *
 * Only a *leading* marker counts, so a dash inside a sentence survives — see the round-trip
 * test in `policy-text.test.ts`, which pins exactly that. The letter and digit forms require
 * their `.` or `)`, so "a refund is issued" keeps its "a".
 */
const BULLET = /^\s*(?:[-–—*•·]+|\(?\d{1,2}[.)]|\(?[a-z][.)])\s+/i;

export const stripBullet = (line: string): string => line.replace(BULLET, "");

/**
 * Pasted text as entries.
 *
 * Blank lines go because a handbook double-spaces its list and nobody means an empty rule by it.
 * This runs on paste only — typing stays forgiving, so a trailing newline somebody left while
 * thinking is not deleted under the cursor.
 */
export const splitPasted = (text: string): string[] =>
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => stripBullet(line).trim())
    .filter((line) => line !== "");

/** Non-empty entries, which is what the count under the box reports. */
export const countEntries = (text: string): number =>
  text.split("\n").filter((line) => line.trim() !== "").length;

export interface LineAdvice {
  /** 0-based index into the textarea's lines, so the caller can rewrite just that one. */
  readonly index: number;
  readonly reason: "semicolons" | "commas" | "too-long";
  /** What splitting would produce. Empty when there is no defensible place to cut. */
  readonly parts: readonly string[];
}

const partsOn = (line: string, separator: string): string[] =>
  line
    .split(separator)
    .map((part) => stripBullet(part).trim())
    .filter((part) => part !== "");

/**
 * Long enough that a comma is more likely to be joining rules than qualifying one.
 *
 * Under this, "Refund the order, minus shipping" is the common shape and suggesting a split
 * would be noise. It is a threshold on a guess either way, which is why the guess is only ever
 * shown and never applied.
 */
const COMMA_LENGTH = 80;

export const adviseLine = (line: string, index: number, maxLine: number): LineAdvice | null => {
  const semicolons = partsOn(line, ";");
  if (semicolons.length > 1) return { index, reason: "semicolons", parts: semicolons };

  const commas = partsOn(line, ",");
  if (commas.length > 2 && line.length > COMMA_LENGTH) {
    return { index, reason: "commas", parts: commas };
  }

  /* Reported last and with nowhere to cut: this one already blocks publishing, so the value
     here is naming which line rather than offering to fix it. */
  if (line.length > maxLine) return { index, reason: "too-long", parts: [] };

  return null;
};

export const adviseLines = (text: string, maxLine: number): readonly LineAdvice[] =>
  text
    .split("\n")
    .map((line, index) => adviseLine(line.trim(), index, maxLine))
    .filter((advice): advice is LineAdvice => advice !== null);

/** Replace one line with several, keeping every other line exactly as it was. */
export const applySplit = (text: string, advice: LineAdvice): string => {
  if (advice.parts.length < 2) return text;
  const lines = text.split("\n");
  return [
    ...lines.slice(0, advice.index),
    ...advice.parts,
    ...lines.slice(advice.index + 1),
  ].join("\n");
};
