import type { TenantId } from "@ansa/shared";

import type { Db } from "./data-source";
import { withTenant, type TenantScope } from "./tenant-scope";

/**
 * The event log, read back in the shape a metric is computed from.
 *
 * Read-only, and deliberately narrow. It pulls the handful of event kinds the quality
 * metrics are defined over and the reviewed transcript pairs, and nothing else — no
 * caller text beyond what a reviewer has already read, because "count the barge-ins"
 * should not drag every policy number the tenant's callers ever read aloud into memory.
 *
 * The arithmetic lives in `apps/api/src/viewer/metrics.ts` rather than in SQL, so the
 * same definitions score a recorded call and a scenario test. A metric defined twice is
 * two metrics.
 */

/** The kinds a metric is computed from. Anything else stays in the database. */
const METRIC_EVENT_KINDS: readonly string[] = [
  "latency",
  "barge-in",
  "confirmation_requested",
  "value confirmed",
  "escalated to a human",
  "hallucination discarded",
];

export interface MetricEvent {
  readonly kind: string;
  readonly detail: unknown;
}

/** What the transcriber heard and what the reviewer said it was (R9.2.3). */
export interface ReviewedTranscript {
  readonly heard: string;
  readonly corrected: string;
}

export interface CallRecord {
  readonly callId: string;
  readonly endReason: string | null;
  readonly durationSeconds: number | null;
  readonly callerTurns: number;
  readonly agentTurns: number;
  readonly events: readonly MetricEvent[];
  readonly reviewed: readonly ReviewedTranscript[];
}

/**
 * The most recent calls, with the events and review verdicts a score needs.
 *
 * Three statements in one tenant-scoped transaction rather than one join: a call has
 * hundreds of events and a join would return every one of them once per transcript.
 *
 * This is the scope-taking half, for the dashboard API, whose request already holds one
 * and has no way to name a tenant. `loadCallRecords` below is the same query for the
 * internal viewer, which is told the tenant. One body, because the quality figures the two
 * surfaces publish have to be the same figures — a metric computed from two different
 * reads is two metrics with one name, which is the mistake `metrics.ts` exists to avoid.
 */
export const readCallRecords = async (
  scope: TenantScope,
  limit = 200,
): Promise<readonly CallRecord[]> => {
  const calls = await scope.query<Record<string, unknown>>(
    `select c.id, c.end_reason, c.duration_seconds,
            (select count(*) from turns t
              where t.call_id = c.id and t.speaker = 'caller') as caller_turns,
            (select count(*) from turns t
              where t.call_id = c.id and t.speaker = 'agent') as agent_turns
       from calls c
      order by c.created_at desc
      limit $1`,
    [Math.min(limit, 1_000)],
  );
  if (calls.length === 0) return [];

  const ids = calls.map((c) => String(c["id"]));

  const events = await scope.query<Record<string, unknown>>(
    `select call_id, kind, detail
       from call_events
      where call_id = any($1) and kind = any($2)
      order by id`,
    [ids, METRIC_EVENT_KINDS],
  );
  const reviewed = await scope.query<Record<string, unknown>>(
    `select call_id, text, corrected_text
       from transcripts
      where call_id = any($1) and corrected_at is not null`,
    [ids],
  );

  const eventsByCall = new Map<string, MetricEvent[]>();
  for (const e of events) {
    const callId = String(e["call_id"]);
    const list = eventsByCall.get(callId) ?? [];
    list.push({ kind: String(e["kind"]), detail: e["detail"] });
    eventsByCall.set(callId, list);
  }

  const reviewedByCall = new Map<string, ReviewedTranscript[]>();
  for (const t of reviewed) {
    const callId = String(t["call_id"]);
    const list = reviewedByCall.get(callId) ?? [];
    list.push({ heard: String(t["text"]), corrected: String(t["corrected_text"]) });
    reviewedByCall.set(callId, list);
  }

  return calls.map((c) => {
    const callId = String(c["id"]);
    return {
      callId,
      endReason: c["end_reason"] === null ? null : String(c["end_reason"]),
      durationSeconds: c["duration_seconds"] === null ? null : Number(c["duration_seconds"]),
      callerTurns: Number(c["caller_turns"] ?? 0),
      agentTurns: Number(c["agent_turns"] ?? 0),
      events: eventsByCall.get(callId) ?? [],
      reviewed: reviewedByCall.get(callId) ?? [],
    };
  });
};

/** The same read, for the internal viewer, which is told which organisation to act for. */
export const loadCallRecords = async (
  dataSource: Db,
  tenantId: TenantId,
  limit = 200,
): Promise<readonly CallRecord[]> =>
  withTenant(dataSource, tenantId, async (scope) => readCallRecords(scope, limit));
