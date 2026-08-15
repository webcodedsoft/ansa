import type { CallRecord } from "@ansa/db";

import { scoreCalls, type QualityMetrics } from "./metrics";
import { scoreCallForReview, type ReviewWeights } from "./review";

/**
 * Movement, attributed to the thing that caused it (R9.2.6).
 *
 * The requirement is that a provider or prompt change can be credited with a measurable
 * change rather than a feeling. That needs two things the codebase already has and had
 * never joined: `scoreCalls`, which turns an event log into numbers, and
 * `calls.config_version`, which records which version of the organization's configuration served
 * each call. Grouping the first by the second is the whole mechanism.
 *
 * **What this cannot tell you.** A configuration version covers persona, greeting,
 * keyterms, tools and hours. It does not cover the provider — `LISTEN_PROVIDER`, the model
 * and the endpointing thresholds are deployment environment, not organization config, and two
 * versions either side of a provider switch will differ for a reason this table cannot
 * name. The `call configuration` event records those settings per call and the claim
 * exporter reads them; a provider comparison belongs in `eval/`, against ground truth,
 * three runs at a time. This table says *something moved between v3 and v4*. It does not
 * say what changed, and it must not be read as if it did.
 */

export interface ConfigVersionTrend {
  /** Null for calls that recorded no version — an unregistered number, or a call before R7.5. */
  readonly configVersion: number | null;
  readonly calls: number;
  /** The window this version's calls span. Two versions can overlap during a rollout. */
  readonly firstCallAt: string;
  readonly lastCallAt: string;
  /** Calls the scan flagged, over calls served. The one number that summarises the rest. */
  readonly flaggedRate: number | null;
  /** Total severity over calls served: how bad the flagged ones were, not just how many. */
  readonly severityPerCall: number | null;
  readonly metrics: QualityMetrics;
}

/**
 * One row per configuration version, newest version first.
 *
 * Nulls sort last rather than as zero: "no version recorded" is not version 0, and putting
 * it at the top would make an unregistered number look like the oldest configuration.
 */
export const trendByConfigVersion = (
  records: readonly CallRecord[],
  weights?: ReviewWeights,
): readonly ConfigVersionTrend[] => {
  const byVersion = new Map<number | null, CallRecord[]>();
  for (const record of records) {
    const list = byVersion.get(record.configVersion) ?? [];
    list.push(record);
    byVersion.set(record.configVersion, list);
  }

  const trends = [...byVersion].map(([configVersion, calls]): ConfigVersionTrend => {
    const times = calls.map((c) => c.createdAt).sort();
    const scores = calls.map((c) => scoreCallForReview(c, weights));
    const flagged = scores.filter((s) => s.severity > 0).length;
    const severity = scores.reduce((total, s) => total + s.severity, 0);
    return {
      configVersion,
      calls: calls.length,
      firstCallAt: times[0] ?? "",
      lastCallAt: times[times.length - 1] ?? "",
      flaggedRate: calls.length === 0 ? null : flagged / calls.length,
      severityPerCall: calls.length === 0 ? null : severity / calls.length,
      metrics: scoreCalls(calls),
    };
  });

  return trends.sort((a, b) => {
    if (a.configVersion === b.configVersion) return 0;
    if (a.configVersion === null) return 1;
    if (b.configVersion === null) return -1;
    return b.configVersion - a.configVersion;
  });
};
