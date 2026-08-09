import type { CallRecord, MetricEvent } from "@ansa/db";

/**
 * The automatic post-call quality scan, and the queue it feeds (R9.2.1, R9.2.2).
 *
 * Pure arithmetic over the same `CallRecord[]` that `scoreCalls` and `priceUsage` read, for
 * the same reason those are: a second telemetry path defined "for review" would be a second
 * set of numbers with the same names, and the first argument about which one was right
 * would be unresolvable. Nothing here touches the database and nothing here writes.
 *
 * **What this is for.** `docs/MULTI_TENANT_ARCHITECTURE.md` §2 argues that edge cases are
 * captured, not imagined, and that the review loop is the product's actual moat. The moat
 * only exists if the calls worth reviewing float to the top of a list, because nobody
 * reviews four hundred calls to find the six that went wrong.
 *
 * **What a signal is.** Every one below is an event the pipeline already writes, chosen
 * because it is a moment the call *demonstrably* went sideways — not a proxy for one. A
 * heuristic that fires on a healthy call trains a reviewer to ignore the queue, which is
 * worse than having no queue.
 *
 * **What severity is not.** It is not a probability, a percentage or a grade. It is a sum
 * of weights whose only meaning is ordering: a call at 20 should be opened before a call at
 * 8. Two calls at 8 are not equally bad, they are equally next.
 */

/**
 * The heuristics R9.2.1 names, one enum member each, so a queue row can say why it is
 * there in the reviewer's language rather than in the event log's.
 */
export type ReviewSignalKind =
  | "hallucination"
  | "escalated"
  | "repeated-confirmation"
  | "low-confidence"
  | "barge-in-storm"
  | "recovery-line"
  | "sentence-dropped"
  | "capture-fallback"
  | "long-silence"
  | "tool-failure"
  | "pipeline-failure"
  | "no-caller-turn";

export interface ReviewSignal {
  readonly kind: ReviewSignalKind;
  /** How many times it happened. One for the signals that can only happen once a call. */
  readonly count: number;
  /** What this signal contributed to `severity`, after the per-signal cap below. */
  readonly weight: number;
  /** What a reviewer should expect to find, in one sentence. */
  readonly why: string;
}

export interface ReviewScore {
  readonly callId: string;
  readonly carrierCallId: string;
  readonly createdAt: string;
  readonly endReason: string | null;
  readonly durationSeconds: number | null;
  readonly configVersion: number | null;
  /** Higher is worse. Ordering only — see the note above. */
  readonly severity: number;
  /** Final turns nobody has ruled on yet. Zero means the call has been worked through. */
  readonly unreviewed: number;
  readonly reviewed: number;
  /** Empty when nothing fired, which is the normal outcome for a call that went fine. */
  readonly signals: readonly ReviewSignal[];
}

/**
 * What each signal is worth, and the two numbers that decide when one fires at all.
 *
 * Weights are chosen, not derived, and the ordering they encode is the argument: **a call
 * where the caller was handed to a person, or where the agent invented words, outranks a
 * call that was merely slow.** Anyone who disagrees should change the number here rather
 * than add a second scan.
 */
export interface ReviewWeights {
  /** Words invented out of silence and spoken to a caller. The worst thing on the list. */
  readonly hallucination: number;
  /** The agent could not finish the job. R10 wants at least half of calls to avoid this. */
  readonly escalated: number;
  /** The same value read back twice or more: the transcriber is not getting it (R4.3). */
  readonly repeatedConfirmation: number;
  /** A turn the transcriber itself was unsure of — the cheapest correction to collect. */
  readonly lowConfidence: number;
  /** Interruption after interruption, which is usually the echo guard letting audio in. */
  readonly bargeInStorm: number;
  /** A turn produced nothing and a caller was apologised to for asking (PRD §10, <1%). */
  readonly recoveryLine: number;
  /** A sentence the voice never spoke. The caller heard a reply with a hole in it. */
  readonly sentenceDropped: number;
  /** Capture fell through to spelling or the keypad: speech had already failed twice. */
  readonly captureFallback: number;
  /** Over two seconds between the caller stopping and hearing anything (CLAUDE.md). */
  readonly longSilence: number;
  readonly toolFailure: number;
  /** The transcriber or the voice dropped mid-call. Rare, and always worth reading. */
  readonly pipelineFailure: number;
  /** They heard the greeting and left. Not always a failure, always worth a look. */
  readonly noCallerTurn: number;

  /** Below this, a turn counts as low confidence. */
  readonly lowConfidenceBelow: number;
  /** Interruptions per agent turn above which the storm signal fires. */
  readonly bargeInPerAgentTurn: number;
  /** Milliseconds of dead air a caller will read as a dropped call. */
  readonly silenceMs: number;
  /**
   * The most occurrences of one signal that count toward severity.
   *
   * Without it a six-minute call with forty recovery lines buries a two-minute call in
   * which the agent invented a policy number, and the queue sorts by call length. The count
   * is still reported in full; only its contribution is capped.
   *
   * It applies to the signals that genuinely get worse with repetition. Three of them are
   * one fact however many events carry them — escalation, an interruption storm and a
   * caller who never spoke — and those do not scale at all. See `addOnce` below.
   */
  readonly cap: number;
}

export const DEFAULT_REVIEW_WEIGHTS: ReviewWeights = {
  hallucination: 8,
  escalated: 6,
  repeatedConfirmation: 5,
  lowConfidence: 2,
  bargeInStorm: 3,
  recoveryLine: 5,
  sentenceDropped: 3,
  captureFallback: 4,
  longSilence: 3,
  toolFailure: 3,
  pipelineFailure: 4,
  noCallerTurn: 2,

  // 0.6 rather than a rounder number because 8kHz telephony confidence sits lower than the
  // same provider's confidence on wideband audio, and a threshold at 0.8 flags every call.
  // It is a starting point to be moved once there are enough real calls to plot — see the
  // report at the end of this slice for what that needs.
  lowConfidenceBelow: 0.6,
  // `metrics.ts` already notes that above ~0.5 interruptions per agent turn the echo guard
  // is letting the agent's own voice back in. The same number, once.
  bargeInPerAgentTurn: 0.5,
  // CLAUDE.md: "Any gap over 2s must produce sound." A gap that long is the failure, and
  // the recovery line that usually follows it is a second, separate signal.
  silenceMs: 2_000,
  cap: 5,
};

const detailOf = (event: MetricEvent): Record<string, unknown> =>
  typeof event.detail === "object" && event.detail !== null
    ? (event.detail as Record<string, unknown>)
    : {};

const textOf = (detail: Record<string, unknown>, key: string): string => {
  const value = detail[key];
  return typeof value === "string" ? value : "";
};

/**
 * The reasons `sayNow` records when capture has run out of spoken attempts.
 *
 * `agent said` is the only event that distinguishes them — capture's own state machine
 * emits no event of its own — so this is a coupling to a string the orchestrator writes.
 * It is checked by `review.test.ts` against the literal the orchestrator passes, so a
 * rename breaks a test rather than silently emptying this signal.
 */
const CAPTURE_FALLBACK_REASONS: readonly string[] = ["readback:spelling", "readback:keypad"];

/**
 * How many distinct entities the caller had to repeat themselves about.
 *
 * Counted per subject rather than per event, because `confirmation_requested` fires once
 * per attempt and a policy number read three times is one problem with one value, not
 * three problems. Attempt 1 is the readback every capture opens with and is not a signal;
 * anything after it is the caller saying no.
 */
const repeatedSubjects = (events: readonly MetricEvent[]): number => {
  const repeated = new Set<string>();
  for (const event of events) {
    if (event.kind !== "confirmation_requested") continue;
    const detail = detailOf(event);
    if (Number(detail["attempt"] ?? 1) <= 1) continue;
    // A subject the orchestrator did not name still happened; it groups under one bucket
    // rather than being dropped, which would make an unnamed repeat invisible.
    repeated.add(textOf(detail, "subject") || "(unnamed)");
  }
  return repeated.size;
};

/**
 * One call, scanned (R9.2.1).
 *
 * Deliberately returns a score for every call, including the clean ones — `severity` 0 with
 * no signals. A function that only returns the bad calls cannot be used to say what share of
 * calls are bad, and that share is the number R9.2.6 exists to track.
 */
export const scoreCallForReview = (
  call: CallRecord,
  weights: ReviewWeights = DEFAULT_REVIEW_WEIGHTS,
): ReviewScore => {
  let hallucinations = 0;
  let escalations = 0;
  let bargeIns = 0;
  let recoveries = 0;
  let dropped = 0;
  let fallbacks = 0;
  let silences = 0;
  let toolFailures = 0;
  let pipelineFailures = 0;

  for (const event of call.events) {
    const detail = detailOf(event);
    switch (event.kind) {
      case "hallucination discarded":
        hallucinations += 1;
        break;
      case "escalated to a human":
        escalations += 1;
        break;
      case "barge-in":
        bargeIns += 1;
        break;
      case "recovery_line":
        recoveries += 1;
        break;
      case "tts_sentence_dropped":
        dropped += 1;
        break;
      case "agent said":
        if (CAPTURE_FALLBACK_REASONS.includes(textOf(detail, "reason"))) fallbacks += 1;
        break;
      case "latency":
        // The one stage R5.5 is written against, and the same one `scoreCalls` takes its
        // percentiles from: the caller stopped, and this is how long until they heard
        // anything. The component stages are diagnosis and would double-count.
        if (detail["stage"] === "turn_to_audio" && Number(detail["ms"] ?? 0) > weights.silenceMs) {
          silences += 1;
        }
        break;
      case "tool_call":
        if (detail["outcome"] === "failed") toolFailures += 1;
        break;
      case "tts_failed":
      case "listen_failed":
        pipelineFailures += 1;
        break;
      default:
        break;
    }
  }

  const lowConfidence = call.confidences.filter(
    (c): c is number => c !== null && c < weights.lowConfidenceBelow,
  ).length;
  const repeats = repeatedSubjects(call.events);
  // A rate over zero agent turns is not zero, it is undefined — and a call with no agent
  // turn cannot have been interrupted anyway.
  const bargeInStorm =
    call.agentTurns > 0 && bargeIns / call.agentTurns > weights.bargeInPerAgentTurn;

  const signals: ReviewSignal[] = [];

  /** Signals that get worse the more often they happen, up to the cap. */
  const add = (kind: ReviewSignalKind, count: number, each: number, why: string): void => {
    if (count <= 0) return;
    signals.push({ kind, count, weight: Math.min(count, weights.cap) * each, why });
  };

  /**
   * Signals that are one fact however many events carry them.
   *
   * A call handed to a person twice is still one call that needed a person, and a storm of
   * twenty interruptions is one broken echo guard rather than twenty problems. Scaling
   * either would let call length decide the ordering — the same failure the cap exists to
   * stop, arriving through the other door. The count is still reported, because "twice" and
   * "twenty times" tell a reviewer what they are about to read.
   */
  const addOnce = (kind: ReviewSignalKind, count: number, weight: number, why: string): void => {
    if (count <= 0) return;
    signals.push({ kind, count, weight, why });
  };

  add(
    "hallucination",
    hallucinations,
    weights.hallucination,
    "the speech gate threw away words the transcriber invented from silence",
  );
  addOnce(
    "escalated",
    escalations,
    weights.escalated,
    "the call was handed to a person — read what the agent could not do",
  );
  add(
    "repeated-confirmation",
    repeats,
    weights.repeatedConfirmation,
    "the caller had to repeat a value the agent read back wrong",
  );
  add(
    "low-confidence",
    lowConfidence,
    weights.lowConfidence,
    `the transcriber scored a turn below ${weights.lowConfidenceBelow} — the cheapest correction to collect`,
  );
  addOnce(
    "barge-in-storm",
    bargeInStorm ? bargeIns : 0,
    weights.bargeInStorm,
    "interrupted more often than every other turn, which usually means the agent heard itself",
  );
  add(
    "recovery-line",
    recoveries,
    weights.recoveryLine,
    "a turn produced nothing and the caller was apologised to instead of answered",
  );
  add(
    "sentence-dropped",
    dropped,
    weights.sentenceDropped,
    "a sentence never reached the caller — they heard a reply with a hole in it",
  );
  add(
    "capture-fallback",
    fallbacks,
    weights.captureFallback,
    "capture fell through to spelling or the keypad, so speech had already failed twice",
  );
  add(
    "long-silence",
    silences,
    weights.longSilence,
    `over ${weights.silenceMs}ms of dead air after the caller stopped speaking`,
  );
  add(
    "tool-failure",
    toolFailures,
    weights.toolFailure,
    "a tool timed out, errored or found its circuit open",
  );
  add(
    "pipeline-failure",
    pipelineFailures,
    weights.pipelineFailure,
    "the transcriber or the voice dropped mid-call",
  );
  addOnce(
    "no-caller-turn",
    call.callerTurns === 0 ? 1 : 0,
    weights.noCallerTurn,
    "the caller never took a turn: they heard the greeting and went",
  );

  return {
    callId: call.callId,
    carrierCallId: call.carrierCallId,
    createdAt: call.createdAt,
    endReason: call.endReason,
    durationSeconds: call.durationSeconds,
    configVersion: call.configVersion,
    severity: signals.reduce((total, signal) => total + signal.weight, 0),
    unreviewed: call.confidences.length - call.reviewed.length,
    reviewed: call.reviewed.length,
    signals,
  };
};

export interface ReviewQueueFilter {
  /** Calls scoring below this are not worth a reviewer's attention. Default 1: any signal. */
  readonly minSeverity?: number;
  /**
   * `false` hides calls somebody has already worked through, `true` shows only those.
   *
   * Undefined shows both, which is the right default for a page whose other job is
   * checking that a correction actually landed.
   */
  readonly reviewed?: boolean;
  readonly limit?: number;
}

/**
 * The queue (R9.2.2): every flagged call, worst first.
 *
 * Ties break on recency rather than on call id, because two calls with the same severity
 * are equally next and the newer one is the one whose configuration is still in production.
 */
export const reviewQueue = (
  records: readonly CallRecord[],
  filter: ReviewQueueFilter = {},
  weights: ReviewWeights = DEFAULT_REVIEW_WEIGHTS,
): readonly ReviewScore[] => {
  const minSeverity = filter.minSeverity ?? 1;
  const scored = records
    .map((record) => scoreCallForReview(record, weights))
    .filter((score) => score.severity >= minSeverity)
    .filter((score) => filter.reviewed === undefined || filter.reviewed === (score.reviewed > 0))
    .sort((a, b) => b.severity - a.severity || b.createdAt.localeCompare(a.createdAt));
  return filter.limit === undefined ? scored : scored.slice(0, filter.limit);
};
