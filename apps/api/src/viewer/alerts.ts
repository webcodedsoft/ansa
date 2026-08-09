import type { QualityMetrics } from "./metrics";

/**
 * When a number stops being informational and starts being a problem (Slice 8).
 *
 * Nothing here computes anything. It reads `QualityMetrics` — the same object the viewer's
 * metrics page already renders, from the same `scoreCalls` over the same event log — and
 * says which of those numbers is outside the range the product promised. A second
 * measurement path defined "for alerting" is how a dashboard and a pager come to disagree
 * about whether the system is up.
 *
 * Every threshold below is cited. Three come from the PRD and one does not, and the one
 * that does not says so plainly rather than borrowing authority it has not got.
 */

export interface AlertThresholds {
  /**
   * PRD §5.5: under 800ms p50 is the target, over 1.5s p95 is the hard fail. Both are
   * carried because they say different things — the p50 is whether the system is fast and
   * the p95 is what a caller remembers.
   */
  readonly responseLatencyP50Ms: number;
  readonly responseLatencyP95Ms: number;
  /** PRD §10: at least half of calls resolved without a human, so at most half transferred. */
  readonly transferRate: number;
  /**
   * PRD §10: under 1% of calls where the agent went silent.
   *
   * Measured against caller turns rather than calls, and it is worth being precise about
   * why: a recovery line is a per-turn event and dividing it by calls would let one bad
   * six-minute call and one bad thirty-second call score identically. The rate is therefore
   * stricter than the requirement it comes from, which is the safe direction.
   */
  readonly recoveryRate: number;
  /**
   * **Not from the PRD.** Nothing states a tool failure budget, so this is chosen rather
   * than cited, and the reasoning is written down so the next person can disagree with it:
   * the dispatcher's circuit breaker opens after four consecutive failures on one endpoint,
   * which means a tenant's system is expected to be reliable enough that failures are
   * isolated. A sustained rate above one in ten is not isolated — at that point callers
   * regularly hear an apology instead of an answer, and the tenant needs telling.
   */
  readonly toolFailureRate: number;
  /**
   * Below this many calls, nothing fires.
   *
   * Two calls, one of which transferred, is a 50% transfer rate and means nothing at all.
   * An alerting rule without a floor pages somebody every Monday morning.
   */
  readonly minimumCalls: number;
}

const DEFAULTS: AlertThresholds = {
  responseLatencyP50Ms: 800,
  responseLatencyP95Ms: 1_500,
  transferRate: 0.5,
  recoveryRate: 0.01,
  toolFailureRate: 0.1,
  minimumCalls: 20,
};

export interface Alert {
  readonly name: string;
  /** What the metric read, and what it had to beat. Both, so the page needs no lookup. */
  readonly observed: number;
  readonly threshold: number;
  /** How to read the pair: a latency is over, a rate is over, nothing here is under. */
  readonly unit: "ms" | "rate";
  /** What it means and what to do about it, in one sentence. */
  readonly meaning: string;
}

const over = (
  name: string,
  observed: number | null,
  threshold: number,
  unit: Alert["unit"],
  meaning: string,
): Alert | null =>
  observed === null || observed <= threshold
    ? null
    : { name, observed, threshold, unit, meaning };

/**
 * Every threshold this window breaches, worst first is deliberately *not* the order — they
 * are in the order they are defined, because "worst" across a latency and a rate is a
 * comparison with no meaning.
 *
 * An empty array is the normal answer and is not the same as "not enough data": when there
 * are too few calls to judge, the array is empty and `sampleTooSmall` says why.
 */
export const alertsFor = (
  metrics: QualityMetrics,
  thresholds: AlertThresholds = DEFAULTS,
): { readonly alerts: readonly Alert[]; readonly sampleTooSmall: boolean } => {
  if (metrics.calls < thresholds.minimumCalls) {
    return { alerts: [], sampleTooSmall: true };
  }

  const alerts = [
    over(
      "Response latency p50",
      metrics.responseLatencyMs.p50,
      thresholds.responseLatencyP50Ms,
      "ms",
      "callers are waiting past the target after they stop speaking (PRD §5.5)",
    ),
    over(
      "Response latency p95",
      metrics.responseLatencyMs.p95,
      thresholds.responseLatencyP95Ms,
      "ms",
      "the tail is past the hard fail: one turn in twenty reads as a dropped call (PRD §5.5)",
    ),
    over(
      "Silence recovered",
      metrics.recoveryRate,
      thresholds.recoveryRate,
      "rate",
      "turns that produced nothing and needed an apology — read the reasons before the calls (PRD §10)",
    ),
    over(
      "Transfer rate",
      metrics.transferRate,
      thresholds.transferRate,
      "rate",
      "fewer than half of calls are being resolved without a person (PRD §10)",
    ),
    over(
      "Tool failure rate",
      metrics.toolFailureRate,
      thresholds.toolFailureRate,
      "rate",
      "an organisation's endpoint is failing often enough that callers hear it",
    ),
  ];

  return { alerts: alerts.filter((a): a is Alert => a !== null), sampleTooSmall: false };
};
