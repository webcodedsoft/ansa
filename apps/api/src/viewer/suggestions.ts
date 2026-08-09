import type { CorpusEntry } from "@ansa/db";

/**
 * What a correction is evidence *for* (R9.2.5) — and why nothing here applies anything.
 *
 * A reviewer fixing "My name is Security" to "My name is Sikiru" has produced more than a
 * corpus entry. They have produced a candidate keyterm, a candidate capture test case, and
 * a data point about which sounds this transcriber loses. R9.2.5 asks for all three to be
 * fed back.
 *
 * **They are suggested and never applied, and that is a decision with a receipt.**
 * `apps/api/src/tenancy/defaults.ts` records the measurement: on identical synthetic audio,
 * three runs each way, perfectly deterministic, boosting a list of ordinary domain words —
 * with no personal name in it — turned "Sikiru" into "Akiro" on Deepgram, and removing the
 * list gave "Sikiru" every time. **Boosting is a bias, not a hint: a listed token wins ties
 * against everything unlisted, including words nobody listed.** A pipeline that promoted
 * corrections into keyterms automatically would therefore take the exact evidence that the
 * transcriber mishears a word and use it to damage the words next to it — and it would do
 * that fastest for the tenants correcting the most, which is backwards.
 *
 * So this file computes candidates with their evidence attached and stops. A human reads
 * the list, decides, and edits the tenant's configuration through the API that already
 * exists. The cost of that is a human in the loop. The cost of the alternative was measured
 * and it was a caller's name.
 *
 * Pure: text in, candidates out, no I/O, no writes, no configuration lookups.
 */

/**
 * Words that carry no information about what the transcriber mishears.
 *
 * A correction changes a whole turn, so the diff between heard and corrected picks up every
 * function word that moved with it. Boosting "the" would be worse than useless. This is the
 * closed class of English, not a domain list — a domain word belongs in the candidates.
 */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "did", "do", "does",
  "for", "from", "had", "has", "have", "he", "her", "him", "his", "how", "i", "if", "in", "is",
  "it", "its", "me", "my", "no", "not", "of", "on", "or", "our", "out", "she", "so", "that",
  "the", "their", "them", "then", "there", "they", "this", "to", "up", "was", "we", "were",
  "what", "when", "where", "which", "who", "will", "with", "would", "you", "your", "yes",
  "okay", "ok", "please", "thank", "thanks", "sorry", "hello", "hi", "am", "im", "ive",
]);

/** Lower-cased, punctuation dropped. The same normalisation `metrics.ts` scores with. */
const words = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);

/** One correction's worth of evidence, kept whole so a human can check the inference. */
export interface CandidateEvidence {
  readonly callId: string;
  readonly carrierCallId: string;
  readonly heard: string;
  readonly corrected: string;
}

export interface KeytermCandidate {
  /** As the reviewer wrote it, capitalisation and all — that is what goes in the list. */
  readonly term: string;
  /** Distinct calls this term was restored on. One is an anecdote; the threshold is two. */
  readonly calls: number;
  readonly evidence: readonly CandidateEvidence[];
  /**
   * True when the term reads like a personal name in the reviewer's own capitalisation.
   *
   * Not a filter. `defaults.ts` shows that a keyterm list with **no** personal name in it
   * still damaged one, so excluding names would not make the rest safe and would hide the
   * single most common thing a Nigerian caller's transcript gets wrong. It is a flag,
   * because a name in a shared vocabulary is a different decision from a product name and
   * a human should see which one they are approving.
   */
  readonly looksLikeAName: boolean;
}

export interface KeytermOptions {
  /** Terms already in the tenant's list or the platform base. Compared case-insensitively. */
  readonly known?: readonly string[];
  /** Distinct calls a term must appear on. Default 2 — a single mishearing is noise. */
  readonly minCalls?: number;
}

/**
 * Words a reviewer put back that the transcriber had not produced (R9.2.5, keyterms).
 *
 * The inference is deliberately narrow: a token that appears in the corrected text and
 * nowhere in the heard text is a word the transcriber missed *on this turn*. It says
 * nothing about whether boosting it would help, which is the measurement nobody has made
 * and the reason this is a candidate list rather than a change.
 */
export const keytermCandidates = (
  entries: readonly CorpusEntry[],
  options: KeytermOptions = {},
): readonly KeytermCandidate[] => {
  const known = new Set((options.known ?? []).map((k) => k.toLowerCase()));
  const minCalls = options.minCalls ?? 2;

  // Keyed on the lower-cased token; the surface form is whichever spelling the reviewer
  // used first, because that is a human's rendering and ours would be a guess.
  const found = new Map<
    string,
    { surface: string; calls: Set<string>; evidence: CandidateEvidence[] }
  >();

  for (const entry of entries) {
    const heard = new Set(words(entry.heard));
    const seen = new Set<string>();
    for (const raw of entry.corrected.split(/\s+/)) {
      const token = raw.replace(/[^A-Za-z0-9'-]/g, "");
      const key = token.toLowerCase();
      if (key.length < 3) continue;
      if (FUNCTION_WORDS.has(key) || known.has(key)) continue;
      // A number is a capture problem, not a vocabulary one — boosting digits does nothing
      // and `captureCases` below is where those turns go instead.
      if (/[0-9]/.test(key)) continue;
      if (heard.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);

      const record = found.get(key) ?? { surface: token, calls: new Set<string>(), evidence: [] };
      record.calls.add(entry.callId);
      record.evidence.push({
        callId: entry.callId,
        carrierCallId: entry.carrierCallId,
        heard: entry.heard,
        corrected: entry.corrected,
      });
      found.set(key, record);
    }
  }

  return [...found.values()]
    .filter((record) => record.calls.size >= minCalls)
    .map(
      (record): KeytermCandidate => ({
        term: record.surface,
        calls: record.calls.size,
        evidence: record.evidence,
        // The reviewer's own capitalisation, mid-sentence, is the only signal available
        // and it is the reviewer's — not an inference this file made about a person's name.
        looksLikeAName: /^[A-Z][a-z]/.test(record.surface),
      }),
    )
    .sort((a, b) => b.calls - a.calls || a.term.localeCompare(b.term));
};

/**
 * A turn where the digits changed (R9.2.5, test cases).
 *
 * **These are inbound capture cases, not `packages/normalizer` cases, and the distinction
 * matters.** R9.2.5 says "normalizer test cases (anything spoken wrong)", but the normalizer
 * is the outbound path — it turns the agent's text into something a Nigerian would say
 * aloud, and no correction in this table is evidence about it, because a correction is a
 * human's transcript of what the *caller* said. What these pairs test is the inbound half:
 * number capture from speech (R4.3.1), where a caller reads a reference and the system has
 * to get every character. That half has a first-try accuracy target (≥90%, R10) and these
 * are the only real-traffic cases it will ever get.
 *
 * Outbound normalizer cases come from the other direction — a call where the agent said a
 * naira amount wrong — and the event log has no record of that, because nobody transcribes
 * what the agent said back off the line. That gap is real and is named in the slice report.
 */
export interface CaptureCase {
  readonly callId: string;
  readonly carrierCallId: string;
  readonly transcriptId: string;
  readonly heard: string;
  readonly corrected: string;
  /** The digit run the transcriber produced, and the one the reviewer says was spoken. */
  readonly heardDigits: string;
  readonly correctedDigits: string;
}

/** Every digit in order. Grouping is a rendering habit and differs by provider. */
const digitsOf = (text: string): string => text.replace(/[^0-9]/g, "");

export const captureCases = (entries: readonly CorpusEntry[]): readonly CaptureCase[] =>
  entries
    .map((entry) => ({
      entry,
      heardDigits: digitsOf(entry.heard),
      correctedDigits: digitsOf(entry.corrected),
    }))
    // Both sides empty means the turn was prose and nothing here is about it. Equal digits
    // mean the transcriber got the number right even if it got a word wrong, and a case
    // that already passes is not a case — it is in the corpus, which is where it belongs.
    .filter(
      ({ heardDigits, correctedDigits }) =>
        (heardDigits !== "" || correctedDigits !== "") && heardDigits !== correctedDigits,
    )
    .map(
      ({ entry, heardDigits, correctedDigits }): CaptureCase => ({
        callId: entry.callId,
        carrierCallId: entry.carrierCallId,
        transcriptId: entry.transcriptId,
        heard: entry.heard,
        corrected: entry.corrected,
        heardDigits,
        correctedDigits,
      }),
    );
