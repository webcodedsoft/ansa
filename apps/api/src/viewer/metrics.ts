import type { CallRecord, MetricEvent, ReviewedTranscript } from "@ansa/db";

/**
 * Quality, as numbers (R8, R9.2.6).
 *
 * The point of this file is that a provider change, a prompt change or a threshold change
 * can be scored instead of argued about. Every definition here is deliberately blunt and
 * written down, because a metric whose definition is folklore is worse than no metric: two
 * people read the same dashboard and disagree about what it says.
 *
 * It is pure arithmetic over the event log. Nothing here touches the database, which is
 * what lets the same code score a recorded call and a scenario test — see
 * `apps/api/src/scenarios`. A metric computed one way in SQL for the viewer and another
 * way in TypeScript for the tests is two metrics with one name.
 */

/** Nearest-rank, and honest about how many samples it had. */
export interface Percentiles {
  readonly p50: number | null;
  readonly p95: number | null;
  readonly samples: number;
}

export interface QualityMetrics {
  readonly calls: number;
  readonly callerTurns: number;
  readonly agentTurns: number;

  /**
   * Transcripts a human has ruled on. Recording a verdict stamps `corrected_at` whether
   * or not the text changed, so this is the denominator every accuracy figure needs.
   */
  readonly reviewed: number;
  /** Share of reviewed transcripts the transcriber got word-for-word right. */
  readonly sttExactMatch: number | null;
  /** 1 − WER against the reviewer's text, pooled across every reviewed turn. */
  readonly sttWordAccuracy: number | null;
  /** Share of reviewed transcripts a human had to change. The complement of exact match. */
  readonly correctionRate: number | null;

  /** Share of caller turns that triggered a readback (R4.3.1). */
  readonly confirmationRate: number | null;
  /**
   * Share of readbacks the caller rejected — the agent read a number back wrong.
   *
   * The number R10 tracks as "number-string capture accuracy, first try" is its
   * complement, and it is the metric most sensitive to a transcriber change.
   */
  readonly readbackRejectionRate: number | null;
  /** Values the caller confirmed, over readbacks opened. */
  readonly captureCompletionRate: number | null;

  /** Interruptions per agent turn. Above ~0.5 means the echo guard is letting audio through. */
  readonly bargeInRate: number | null;
  /** Caller stopped speaking → first byte of the reply reached the carrier (R5.5, 800ms). */
  readonly responseLatencyMs: Percentiles;

  /** Calls that reached "escalated to a human". R10 wants this under 50%. */
  readonly transferRate: number | null;
  /**
   * Calls where the caller never took a turn: they heard the greeting and went.
   *
   * The plainest reading the event log actually supports. A caller who hangs up
   * frustrated halfway through looks identical to one whose business was finished, and
   * inventing a threshold to separate them would be a number with a definition nobody
   * could defend.
   */
  readonly abandonmentRate: number | null;

  /** Transcripts the speech gate threw away as invented. Not a rate: any at all is news. */
  readonly hallucinationsDiscarded: number;
}

const rate = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

const detailOf = (event: MetricEvent): Record<string, unknown> =>
  typeof event.detail === "object" && event.detail !== null
    ? (event.detail as Record<string, unknown>)
    : {};

const percentiles = (values: readonly number[]): Percentiles => {
  if (values.length === 0) return { p50: null, p95: null, samples: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => {
    const rank = Math.ceil(q * sorted.length) - 1;
    return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] ?? 0;
  };
  return { p50: at(0.5), p95: at(0.95), samples: sorted.length };
};

/**
 * Comparison is on words, lower-cased, punctuation stripped.
 *
 * "Adebayo." and "adebayo" are the same transcription and counting them as an error
 * would flatter every provider that happens to punctuate differently.
 */
const words = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);

/**
 * Word-level edit distance — substitutions, insertions and deletions, as WER is defined.
 *
 * Two rows rather than a full matrix: a turn is short, but a corpus is not, and this runs
 * over every reviewed turn the tenant has.
 */
const editDistance = (a: readonly string[], b: readonly string[]): number => {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_v, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i, ...Array.from({ length: b.length }, () => 0)];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
};

/** Exposed because the corpus view scores one pair at a time. */
export const wordErrorRate = (heard: string, corrected: string): number | null => {
  const reference = words(corrected);
  if (reference.length === 0) return null;
  return editDistance(words(heard), reference) / reference.length;
};

const isExact = (t: ReviewedTranscript): boolean =>
  words(t.heard).join(" ") === words(t.corrected).join(" ");

export const scoreCalls = (records: readonly CallRecord[]): QualityMetrics => {
  let callerTurns = 0;
  let agentTurns = 0;
  let reviewed = 0;
  let exact = 0;
  let errorWords = 0;
  let referenceWords = 0;
  let confirmationsOpened = 0;
  let readbacksRejected = 0;
  let valuesConfirmed = 0;
  let bargeIns = 0;
  let transferred = 0;
  let abandoned = 0;
  let hallucinations = 0;
  const latencies: number[] = [];

  for (const call of records) {
    callerTurns += call.callerTurns;
    agentTurns += call.agentTurns;
    if (call.callerTurns === 0) abandoned += 1;

    for (const transcript of call.reviewed) {
      reviewed += 1;
      if (isExact(transcript)) exact += 1;
      const reference = words(transcript.corrected);
      referenceWords += reference.length;
      errorWords += editDistance(words(transcript.heard), reference);
    }

    let escalated = false;
    for (const event of call.events) {
      const detail = detailOf(event);
      switch (event.kind) {
        case "latency": {
          // The one stage R5.5 is written against: the caller stopped, and this is how
          // long until they heard something. The component stages are diagnosis, not
          // the number a tenant is promised.
          if (detail["stage"] === "turn_to_audio") latencies.push(Number(detail["ms"] ?? 0));
          break;
        }
        case "barge-in":
          bargeIns += 1;
          break;
        case "confirmation_requested": {
          // Attempt 1 opens a readback; anything after it is the caller saying no.
          if (Number(detail["attempt"] ?? 1) <= 1) confirmationsOpened += 1;
          else readbacksRejected += 1;
          break;
        }
        case "value confirmed":
          valuesConfirmed += 1;
          break;
        case "escalated to a human":
          escalated = true;
          break;
        case "hallucination discarded":
          hallucinations += 1;
          break;
        default:
          break;
      }
    }
    if (escalated) transferred += 1;
  }

  return {
    calls: records.length,
    callerTurns,
    agentTurns,
    reviewed,
    sttExactMatch: rate(exact, reviewed),
    sttWordAccuracy: referenceWords === 0 ? null : 1 - errorWords / referenceWords,
    correctionRate: rate(reviewed - exact, reviewed),
    confirmationRate: rate(confirmationsOpened, callerTurns),
    readbackRejectionRate: rate(readbacksRejected, confirmationsOpened),
    captureCompletionRate: rate(valuesConfirmed, confirmationsOpened),
    bargeInRate: rate(bargeIns, agentTurns),
    responseLatencyMs: percentiles(latencies),
    transferRate: rate(transferred, records.length),
    abandonmentRate: rate(abandoned, records.length),
    hallucinationsDiscarded: hallucinations,
  };
};
