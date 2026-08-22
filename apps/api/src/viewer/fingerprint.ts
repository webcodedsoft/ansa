import type { CallRecord } from "@ansa/db";

/**
 * The sentences the agent has started saying to everybody.
 *
 * Models converge on favourite phrasings, and over a few hundred calls an agent develops a
 * catchphrase nobody chose. The prompt tells it to vary its wording, and the prompt will
 * lose slowly, in a way no single call reveals — which is exactly the kind of drift that
 * has to be counted rather than noticed.
 *
 * Pure arithmetic over the same `CallRecord[]` that `scoreCalls` and `priceUsage` read, and
 * **nothing is added to the call path for it.** Every agent utterance has been recorded as
 * an `agent said` event carrying its text since the event log existed, and
 * `readCallRecords` already selects that kind. So this is a read: it costs a live call
 * nothing, and it works on calls already on disk rather than only on ones placed after it
 * shipped.
 *
 * **No hash, unlike the brief.** It reaches for sha1 because it writes a fingerprint per
 * call and wants the column small. Computing at read time removes that constraint, and the
 * normalised phrase is a better key than its digest for the same reason a name beats an id:
 * the entire output here is a list somebody reads and acts on, and a page of hex would need
 * a second lookup before it meant anything.
 */

/**
 * Words carried by almost every sentence, which say nothing about its shape.
 *
 * Kept short on purpose. Strip too much and "let me check that" and "let me see" collapse
 * into one phrase, reporting a catchphrase nobody said; strip too little and "one moment"
 * and "just one moment" count separately, hiding one somebody did.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "to",
  "of",
  "and",
  "or",
  "for",
  "on",
  "at",
  "in",
  "it",
  "that",
  "this",
  "your",
  "you",
  "i",
  "we",
]);

/**
 * A sentence reduced to its shape.
 *
 * Numbers become `#` because the digits vary and the structure does not: "your balance is
 * twelve thousand naira" and "your balance is four hundred naira" are one phrasing said
 * twice, and counting them apart would hide every catchphrase that quotes a figure.
 *
 * Returns an empty string when nothing is left, which the caller drops — a turn that was
 * only a number is not a phrasing.
 */
export const phraseShape = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) => (/^[0-9]+$/.test(word) ? "#" : word))
    .filter((word) => !STOPWORDS.has(word))
    .join(" ")
    .trim()
    /* A shape made only of flattened numbers is not a phrasing. "447" reduces to "#" and
       would otherwise be the commonest catchphrase there is — every call in which the agent
       read a reference back. Found by a test asserting it came out empty; it did not. */
    .replace(/^[#\s]+$/, "");

export interface Catchphrase {
  /** The normalised shape, which is also the grouping key. */
  readonly shape: string;
  /** One utterance as it was actually said, so the report reads like speech. */
  readonly example: string;
  /** How many distinct calls contained it. Calls, never utterances — see below. */
  readonly calls: number;
  /** That count over the calls scanned, as a fraction. */
  readonly share: number;
}

export interface CatchphraseReport {
  readonly callsScanned: number;
  /** Worst first. Empty is the healthy answer and the one to hope for. */
  readonly phrases: readonly Catchphrase[];
}

/**
 * Above this it is a catchphrase rather than a coincidence.
 *
 * The brief's number, and a defensible one: some repetition is inevitable and desirable —
 * an agent that never says "one moment" is an agent straining for variety — but a phrasing
 * in one call out of six is something a regular caller will notice.
 */
export const CATCHPHRASE_SHARE = 0.15;

/**
 * Counted per call, not per utterance, and that is the whole measurement.
 *
 * An agent that says "let me check" three times in one difficult call has had one awkward
 * call. An agent that says it once in every call has a catchphrase. Counting utterances
 * conflates the two and reports the first as the second, which sends somebody off to
 * rewrite a prompt that was working.
 */
export const catchphrases = (
  records: readonly CallRecord[],
  threshold = CATCHPHRASE_SHARE,
): CatchphraseReport => {
  if (records.length === 0) return { callsScanned: 0, phrases: [] };

  const callsWith = new Map<string, number>();
  const example = new Map<string, string>();

  for (const call of records) {
    const seenHere = new Set<string>();
    for (const event of call.events) {
      if (event.kind !== "agent said") continue;
      const detail = event.detail;
      if (typeof detail !== "object" || detail === null) continue;
      const text = (detail as Record<string, unknown>)["text"];
      if (typeof text !== "string") continue;

      const shape = phraseShape(text);
      if (shape === "") continue;
      /* The first utterance of a shape anywhere is the example kept. Any of them would do;
         taking the first makes the report stable between runs. */
      if (!example.has(shape)) example.set(shape, text.trim());
      seenHere.add(shape);
    }
    for (const shape of seenHere) callsWith.set(shape, (callsWith.get(shape) ?? 0) + 1);
  }

  const phrases = [...callsWith.entries()]
    .map(([shape, calls]) => ({
      shape,
      example: example.get(shape) ?? shape,
      calls,
      share: calls / records.length,
    }))
    .filter((phrase) => phrase.share > threshold)
    /* Worst first, then alphabetically, so two phrases on the same count do not swap places
       between requests and read as though something had changed. */
    .sort((a, b) => b.calls - a.calls || a.shape.localeCompare(b.shape));

  return { callsScanned: records.length, phrases };
};
