import {
  TOTAL_COLUMN,
  pageOrder,
  pageParams,
  toSlice,
  type WithTotal,
  type PageRequest,
  type PageSlice,
} from "./paging";
import type { OrganizationScope } from "./organization-scope";

/**
 * Call history for the dashboard.
 *
 * Deliberately not `listCalls` from `call-log.ts`. That one takes `(Db, organizationId, limit)`
 * and opens its own transaction, which is right for the internal viewer, where the organization
 * arrives as a query parameter and there is no session to infer it from. The dashboard's
 * organization comes from the credential and its request already holds a scope, so this takes
 * the scope and paginates. Same table, two callers with genuinely different inputs.
 */

export interface CallPageItem {
  readonly id: string;
  readonly direction: string;
  readonly dialled: string;
  readonly caller: string | null;
  readonly answeredAt: string | null;
  readonly endedAt: string | null;
  readonly endReason: string | null;
  readonly durationSeconds: number | null;
  readonly createdAt: string;
  /**
   * Median time from the caller finishing a turn to the first byte of the
   * agent's reply, over this one call. Null when the call produced no such
   * event — an unanswered outbound, or a call that ended before a turn
   * completed. Null is "not measured", never "fast".
   */
  readonly responseP50Ms: number | null;
}

interface CallPageRow {
  readonly id: string;
  readonly direction: string;
  readonly dialled: string;
  readonly caller: string | null;
  readonly answered_at: Date | null;
  readonly ended_at: Date | null;
  readonly end_reason: string | null;
  readonly duration_seconds: number | string | null;
  readonly created_at: Date;
  readonly response_p50_ms: number | string | null;
}

type CallPageRowWithTotal = CallPageRow & WithTotal;

/**
 * What a reviewer narrows a call list by.
 *
 * Every field is nullable rather than optional, so "no filter" is a value and not an
 * absent key — `NO_CALL_FILTERS` below is the whole default and a caller cannot half-fill
 * it by mistake. All of them AND together; none of them can widen the result, because the
 * organization boundary is the scope and not a clause anything here writes.
 */
export interface CallFilters {
  /** Inclusive. ISO 8601, compared against `created_at`. */
  readonly from: string | null;
  /** Exclusive, so consecutive days do not both contain a call on the boundary. */
  readonly to: string | null;
  readonly endReason: string | null;
  /**
   * Which agent handled the call (migration 0018).
   *
   * Distinct from `dialled`, and both are needed: a number can be moved from one agent to
   * another, so filtering by number answers "calls to this line" while this answers "calls
   * this agent handled" — which is the one that stays true after a reassignment.
   */
  readonly agentId: string | null;
  readonly caller: string | null;
  readonly dialled: string | null;
  readonly minDurationSeconds: number | null;
  /**
   * Whether a human has ruled on any transcript of the call.
   *
   * True is the review queue's "already done" and false is its backlog. The pair only
   * separates because submitting an unchanged transcript still stamps `corrected_at` —
   * see `corrections.ts`.
   */
  readonly reviewed: boolean | null;
}

/** Not exported: it is this function's default, and a caller with no filters omits them. */
const NO_CALL_FILTERS: CallFilters = {
  from: null,
  to: null,
  endReason: null,
  agentId: null,
  caller: null,
  dialled: null,
  minDurationSeconds: null,
  reviewed: null,
};

/**
 * The filter clauses, bound positionally after the two the page request uses.
 *
 * The binder appends and returns its own placeholder rather than counting by hand, because
 * a filter added in the middle would otherwise renumber every one after it — and an
 * off-by-one there is a query that compares the wrong column to the wrong value rather
 * than a query that fails.
 */
const filterClauses = (
  filters: CallFilters,
  params: unknown[],
): readonly string[] => {
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const clauses: string[] = [];

  if (filters.from !== null) clauses.push(`c.created_at >= ${bind(filters.from)}::timestamptz`);
  if (filters.to !== null) clauses.push(`c.created_at < ${bind(filters.to)}::timestamptz`);
  if (filters.endReason !== null) clauses.push(`c.end_reason = ${bind(filters.endReason)}`);
  // Which agent took the call (migration 0018). Null on calls answered before that
  // migration, so this filter genuinely excludes them rather than guessing.
  if (filters.agentId !== null) clauses.push(`c.agent_id = ${bind(filters.agentId)}::uuid`);
  if (filters.caller !== null) clauses.push(`c.caller = ${bind(filters.caller)}`);
  if (filters.dialled !== null) clauses.push(`c.dialled = ${bind(filters.dialled)}`);
  if (filters.minDurationSeconds !== null) {
    clauses.push(`c.duration_seconds >= ${bind(filters.minDurationSeconds)}`);
  }
  if (filters.reviewed !== null) {
    const reviewed = `exists (select 1 from transcripts t
                               where t.call_id = c.id and t.corrected_at is not null)`;
    clauses.push(filters.reviewed ? reviewed : `not ${reviewed}`);
  }

  return clauses;
};

/**
 * The median of a set of measurements, or null when there are none.
 *
 * Lifted out so the detail view computes response latency the same way the list
 * query does. The list does it in SQL because it would otherwise be a query per
 * row; the detail view does it here because it has already loaded the events.
 * Two implementations of one statistic is how a number comes to disagree with
 * itself across two screens.
 */
const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (upper === undefined) return null;
  // `percentile_cont` interpolates, and an even count must match it.
  return Math.round(sorted.length % 2 === 1 || lower === undefined ? upper : (lower + upper) / 2);
};

export const listCallPage = async (
  scope: OrganizationScope,
  page: PageRequest,
  filters: CallFilters = NO_CALL_FILTERS,
): Promise<PageSlice<CallPageItem>> => {
  const params = [...pageParams(page)];
  const clauses = filterClauses(filters, params);
  const where = clauses.length === 0 ? "true" : clauses.join(" and ");

  const rows = await scope.query<CallPageRowWithTotal>(
    /*
     * The latency column is a lateral rather than a join-and-group, so adding
     * it cannot change how many rows come back — a call with no latency events
     * still appears, with null.
     *
     * The event log and not `latencies`, which is written to as of migration
     * 0042 and would serve this faster. Deliberate: every call recorded before
     * that migration has its timings only here, and a call list where the older
     * half of the page reads null would look like a regression rather than like
     * history. `/calls/latency` reads the table, because a range across a week
     * is the query the event log cannot serve.
     *
     * No `organization_id` predicate inside the lateral. `call_events` is behind the
     * same row-level policy as `calls`, so the scope already applies; adding
     * one would suggest the safety came from the predicate.
     */
    `select c.id, c.direction, c.dialled, c.caller, c.answered_at, c.ended_at, c.end_reason,
            c.duration_seconds, c.created_at, lat.p50 as response_p50_ms, ${TOTAL_COLUMN}
       from calls c
       left join lateral (
         select percentile_cont(0.5) within group (order by (e.detail->>'ms')::numeric) as p50
           from call_events e
          where e.call_id = c.id
            and e.kind = 'latency'
            and e.detail->>'stage' = 'turn_to_audio'
            and e.detail ? 'ms'
       ) lat on true
      where ${where}
      ${pageOrder("c.created_at", "c.id")}`,
    params,
  );

  return toSlice(
    rows,
    (row): CallPageItem => ({
      id: row.id,
      direction: row.direction,
      dialled: row.dialled,
      caller: row.caller,
      answeredAt: row.answered_at?.toISOString() ?? null,
      endedAt: row.ended_at?.toISOString() ?? null,
      endReason: row.end_reason,
      durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
      createdAt: row.created_at.toISOString(),
      responseP50Ms:
        row.response_p50_ms === null ? null : Math.round(Number(row.response_p50_ms)),
    }),
  );
};

// ---------------------------------------------------------------------------
// One call, turn by turn
// ---------------------------------------------------------------------------

/**
 * The `detail` of an event, as the dashboard is allowed to see it.
 *
 * `call_events.detail` is jsonb the orchestrator writes freely, and some of it is the
 * caller's own words — `caller said` carries their sentence, `entity_candidate` carries
 * the policy number they just read out, `tool_call` carries the organization id. Handing the
 * column over whole would put the response outside the allowlist the rest of this API is
 * built on: a new event kind that logged a token would leak it through an endpoint nobody
 * had touched.
 *
 * So it is projected onto a fixed set of scalars, here, where the row is read. Not in the
 * response schema, because a projection that runs through the validator turns one
 * unexpected value — a fractional `ms`, a `reason` that arrived as an object — into a 500
 * for the whole call rather than one missing field.
 *
 * What a caller actually said is not lost: it is in `transcripts`, which is the field the
 * review loop corrects and the only place this API publishes speech.
 */
export interface CallEventDetail {
  /** `latency` only: which stage was measured, and how long it took. */
  readonly stage: string | null;
  readonly ms: number | null;
  /** Which agent turn the event belongs to, where the event names one. */
  readonly seq: number | null;
  readonly attempt: number | null;
  readonly reason: string | null;
  readonly subject: string | null;
  readonly outcome: string | null;
  readonly tool: string | null;
  readonly chars: number | null;
  /**
   * The carrier's answering-machine verdict: "human", "machine" or "unknown".
   *
   * Safe to publish here, unlike most of what an event detail can hold — it is the carrier's
   * judgement about who picked up, not anything the caller said. Recorded since migration
   * 0045 and, until this was added, projected away: the console could see that detection had
   * run and never what it concluded.
   */
  readonly answeredBy: string | null;
}

export interface CallEventItem {
  readonly kind: string;
  /** Milliseconds since the media stream opened. Null for events recorded off that clock. */
  readonly offsetMs: number | null;
  readonly at: string;
  readonly detail: CallEventDetail;
}

export interface CallTranscriptItem {
  readonly id: string;
  readonly text: string;
  /** What a reviewer said it was. Null until someone has ruled on it. */
  readonly correctedText: string | null;
  /** Stamped by a verdict whether or not the text changed. This is what "reviewed" means. */
  readonly correctedAt: string | null;
  readonly confidence: number | null;
  readonly offsetMs: number;
  readonly provider: string;
}

export interface CallTurnItem {
  readonly seq: number;
  readonly speaker: string;
  readonly startedOffsetMs: number;
  readonly endedOffsetMs: number | null;
  /** Set when the caller cut this turn off. The unplayed remainder never reached them. */
  readonly bargedInAtMs: number | null;
}

export interface CallDetailView extends CallPageItem {
  readonly carrierCallId: string;
  /** Which version of the organization's configuration served this call (R7.5). */
  readonly configVersion: number | null;
  readonly turns: readonly CallTurnItem[];
  readonly transcripts: readonly CallTranscriptItem[];
  readonly events: readonly CallEventItem[];
}

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Rounded rather than rejected: `ms` is a duration and a fractional one is still one. */
const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;

const detailOf = (raw: unknown): CallEventDetail => {
  const d: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    stage: asString(d["stage"]),
    ms: asNumber(d["ms"]),
    seq: asNumber(d["seq"]),
    attempt: asNumber(d["attempt"]),
    reason: asString(d["reason"]),
    subject: asString(d["subject"]),
    outcome: asString(d["outcome"]),
    tool: asString(d["tool"]),
    chars: asNumber(d["chars"]),
    answeredBy: asString(d["answeredBy"]),
  };
};

interface CallDetailRow extends CallPageRow {
  readonly carrier_call_id: string;
  readonly config_version: number | string | null;
}

/**
 * One call and everything about it, in one organization-scoped transaction.
 *
 * Four statements rather than one join, for the reason `call-records.ts` gives: a call has
 * hundreds of events and a join would repeat every one of them once per transcript.
 *
 * Deliberately not `loadCall` from `call-log.ts`. That one takes `(Db, organizationId, callId)`
 * because the internal viewer is told which organization to act for; here the organization is the
 * scope and there is nowhere to name one. Same tables, two callers with different inputs —
 * exactly the split between `listCalls` and `listCallPage` above.
 */
export const loadCallDetail = async (
  scope: OrganizationScope,
  callId: string,
): Promise<CallDetailView | null> => {
  const calls = await scope.query<CallDetailRow>(
    `select id, carrier_call_id, direction, dialled, caller, answered_at, ended_at,
            end_reason, duration_seconds, config_version, created_at
       from calls where id = $1`,
    [callId],
  );
  const call = calls[0];
  // Not theirs and not there are the same answer, because under RLS they are the same row
  // count and telling them apart would confirm the id exists somewhere.
  if (call === undefined) return null;

  const turns = await scope.query<{
    seq: number | string;
    speaker: string;
    started_offset_ms: number | string;
    ended_offset_ms: number | string | null;
    barged_in_at_ms: number | string | null;
  }>(
    `select seq, speaker, started_offset_ms, ended_offset_ms, barged_in_at_ms
       from turns where call_id = $1 order by seq`,
    [callId],
  );

  const transcripts = await scope.query<{
    id: string | number;
    text: string;
    corrected_text: string | null;
    corrected_at: Date | null;
    confidence: number | string | null;
    offset_ms: number | string;
    provider: string;
  }>(
    `select id, text, corrected_text, corrected_at, confidence, offset_ms, provider
       from transcripts where call_id = $1 and kind = 'final' order by offset_ms, id`,
    [callId],
  );

  // Ordered by the media clock, which is the only clock the caller experienced. `at` is
  // the insert time and events are written in batches, so several unrelated ones share it.
  // The handful recorded off that clock — the configuration line, the hang-up request —
  // have no offset at all and sort last in the order they were written, because giving
  // them a position would be inventing one.
  const events = await scope.query<{
    kind: string;
    offset_ms: number | string | null;
    detail: unknown;
    at: Date;
  }>(
    `select kind, offset_ms, detail, at
       from call_events where call_id = $1
      order by offset_ms asc nulls last, id asc`,
    [callId],
  );

  const responseP50Ms = median(
    events
      .filter((event) => {
        if (event.kind !== "latency") return false;
        const detail: unknown = event.detail;
        return (
          typeof detail === "object" &&
          detail !== null &&
          (detail as Record<string, unknown>)["stage"] === "turn_to_audio"
        );
      })
      .map((event) => Number((event.detail as Record<string, unknown>)["ms"]))
      .filter((ms) => Number.isFinite(ms)),
  );

  return {
    id: call.id,
    responseP50Ms,
    carrierCallId: call.carrier_call_id,
    direction: call.direction,
    dialled: call.dialled,
    caller: call.caller,
    answeredAt: call.answered_at?.toISOString() ?? null,
    endedAt: call.ended_at?.toISOString() ?? null,
    endReason: call.end_reason,
    durationSeconds: call.duration_seconds === null ? null : Number(call.duration_seconds),
    configVersion: call.config_version === null ? null : Number(call.config_version),
    createdAt: call.created_at.toISOString(),
    turns: turns.map((t) => ({
      seq: Number(t.seq),
      speaker: t.speaker,
      startedOffsetMs: Number(t.started_offset_ms),
      endedOffsetMs: t.ended_offset_ms === null ? null : Number(t.ended_offset_ms),
      bargedInAtMs: t.barged_in_at_ms === null ? null : Number(t.barged_in_at_ms),
    })),
    transcripts: transcripts.map((t) => ({
      id: String(t.id),
      text: t.text,
      correctedText: t.corrected_text,
      correctedAt: t.corrected_at?.toISOString() ?? null,
      confidence: t.confidence === null ? null : Number(t.confidence),
      offsetMs: Number(t.offset_ms),
      provider: t.provider,
    })),
    events: events.map((e) => ({
      kind: e.kind,
      offsetMs: e.offset_ms === null ? null : Number(e.offset_ms),
      at: e.at.toISOString(),
      detail: detailOf(e.detail),
    })),
  };
};
