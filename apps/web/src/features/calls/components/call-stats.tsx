import { Stat } from "@/components/ui";

import type { CallDetail } from "../calls.service";

export interface CallStatsSummary {
  readonly responseP50Ms: number | null;
  readonly interruptions: number;
  readonly longestSilenceMs: number | null;
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return null;
  if (sorted.length % 2 !== 0) return upper;
  const lower = sorted[mid - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
};

/**
 * What this one call shows about pace and quiet — not the organisation's aggregate.
 *
 * There is no per-call latency field in the API, only turns with their own offsets. Response
 * time is the gap between a caller turn ending and the next agent turn starting; silence is
 * the longest gap between any two consecutive turns, whoever they belong to. Both are
 * derived here because the API already gives everything they are built from — asking it for
 * two subtractions would be a second source of truth for the same numbers.
 */
export const computeCallStats = (call: CallDetail): CallStatsSummary => {
  const turns = [...call.turns].sort((left, right) => left.seq - right.seq);

  const responseLatencies: number[] = [];
  const gaps: number[] = [];

  for (let index = 0; index < turns.length - 1; index += 1) {
    const current = turns[index];
    const next = turns[index + 1];
    if (current === undefined || next === undefined || current.endedOffsetMs === null) continue;

    const gap = Math.max(0, next.startedOffsetMs - current.endedOffsetMs);
    gaps.push(gap);
    if (current.speaker === "caller" && next.speaker !== "caller") responseLatencies.push(gap);
  }

  return {
    responseP50Ms: median(responseLatencies),
    interruptions: call.turns.filter((turn) => turn.bargedInAtMs !== null).length,
    longestSilenceMs: gaps.length === 0 ? null : Math.max(...gaps),
  };
};

const formatGap = (value: number | null): string => {
  if (value === null) return "—";
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
};

export const CallStats = ({ stats }: { readonly stats: CallStatsSummary }) => (
  <div className="mb-3.5 grid grid-cols-1 gap-3 sm:grid-cols-3">
    <Stat label="Response time (p50)" value={formatGap(stats.responseP50Ms)} />
    <Stat label="Interruptions" value={stats.interruptions} />
    <Stat label="Longest silence" value={formatGap(stats.longestSilenceMs)} />
  </div>
);
