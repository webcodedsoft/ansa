import type { OrganizationId } from "@ansa/shared";

import type { Db } from "./data-source";
import { withOrganization, type OrganizationScope } from "./organization-scope";

/**
 * The event log, read back in the shape a metric is computed from.
 *
 * Read-only, and deliberately narrow. It pulls the handful of event kinds the quality
 * metrics are defined over and the reviewed transcript pairs, and nothing else — no
 * caller text beyond what a reviewer has already read, because "count the barge-ins"
 * should not drag every policy number the organization's callers ever read aloud into memory.
 *
 * The arithmetic lives in `apps/api/src/viewer/metrics.ts` rather than in SQL, so the
 * same definitions score a recorded call and a scenario test. A metric defined twice is
 * two metrics.
 */

/**
 * The kinds a metric is computed from. Anything else stays in the database.
 *
 * **This list was three readers short and every one of them silently read zero.**
 * `metrics.ts` counts `recovery_line` and `tool_call`; `cost.ts` prices `call
 * configuration`, `tts_start`, `llm_start` and `agent said`. None of those kinds was
 * selected here, so the viewer's silence rate, tool failure rate and entire cost table
 * showed zeros against a database full of the events they are defined over — while the
 * scenario tests passed, because a harness hands `scoreCalls` its events directly and
 * never comes through this query. A filter that drops the row a metric is made of does not
 * fail; it agrees with you.
 *
 * So the rule for this list is now explicit: **a kind belongs here if any consumer of
 * `CallRecord` reads it, and adding a `case` to one of those files without adding the kind
 * here is a no-op.** The consumers are `apps/api/src/viewer/{metrics,cost,review}.ts`.
 */
const METRIC_EVENT_KINDS: readonly string[] = [
  // Quality (metrics.ts)
  "latency",
  "barge-in",
  "confirmation_requested",
  "value confirmed",
  "escalated to a human",
  "hallucination discarded",
  "recovery_line",
  "tool_call",
  // Cost (cost.ts) — which vendors listened, and how much each stage was asked to do.
  "call configuration",
  "tts_start",
  "llm_start",
  "agent said",
  /* Replies that had to be rescued — too long, or carrying screen-only formatting. Listed
     here or `readCallRecords` silently drops them and every consumer reads zero, which is
     the failure this list's own comment records. */
  "drift",
  /* What the carrier said answered an outbound call. Registered here or `readCallRecords`
     drops it and the human-answer rate reads zero against a table full of them — which is
     the failure this list's own comment records having happened three times already. */
  "answered_by",
  /* Somebody asking never to be called again. A rising rate is the alarm the brief names,
     and the suppression row itself carries no call and no direction — so the only way to
     attribute one to the call that caused it is to record it as an event there. */
  "do_not_call_recorded",
  // The post-call review scan (review.ts). `agent said` above carries the readback reason
  // that says capture fell through to spelling or the keypad, so it is not repeated here.
  "tts_sentence_dropped",
  "tts_failed",
  "listen_failed",
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
  /** The carrier's id. What a reviewer searches by, and what the recording is named after. */
  readonly carrierCallId: string;
  readonly createdAt: string;
  /**
   * Who rang whom.
   *
   * Carried because the outbound figures are meaningless mixed with inbound ones: an
   * inbound call is answered by definition, so a connect rate computed over both is a
   * measure of how much inbound traffic there was.
   */
  readonly direction: string;
  /**
   * Which version of the organization's configuration served this call (R7.5).
   *
   * Carried so a quality figure can be sliced by the configuration that produced it — that
   * is the whole of R9.2.6, and without this column a provider change is attributable only
   * to the date it happened to ship on.
   */
  readonly configVersion: number | null;
  readonly endReason: string | null;
  readonly durationSeconds: number | null;
  readonly callerTurns: number;
  readonly agentTurns: number;
  readonly events: readonly MetricEvent[];
  readonly reviewed: readonly ReviewedTranscript[];
  /**
   * The transcriber's confidence in each final turn, and nothing else about it.
   *
   * A low-confidence turn is one of R9.2.1's flagging heuristics, and it has to be visible
   * for turns *nobody has reviewed yet* — that is the entire point of a queue. Carrying the
   * numbers rather than the text keeps that possible without dragging every unreviewed
   * sentence a caller has ever spoken into a metrics read. Null where the provider
   * reported none, which is not the same as low and must not be counted as one.
   */
  readonly confidences: readonly (number | null)[];
}

/**
 * The most recent calls, with the events and review verdicts a score needs.
 *
 * Three statements in one organization-scoped transaction rather than one join: a call has
 * hundreds of events and a join would return every one of them once per transcript.
 *
 * This is the scope-taking half, for the dashboard API, whose request already holds one
 * and has no way to name a organization. `loadCallRecords` below is the same query for the
 * internal viewer, which is told the organization. One body, because the quality figures the two
 * surfaces publish have to be the same figures — a metric computed from two different
 * reads is two metrics with one name, which is the mistake `metrics.ts` exists to avoid.
 */
export const readCallRecords = async (
  scope: OrganizationScope,
  limit = 200,
): Promise<readonly CallRecord[]> => {
  const calls = await scope.query<Record<string, unknown>>(
    `select c.id, c.carrier_call_id, c.created_at, c.direction, c.config_version,
            c.end_reason, c.duration_seconds,
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
  // Every final turn, for its confidence — but its text only once a human has ruled on it.
  // The `case` is the whole reason this is one statement rather than two: an unreviewed
  // turn contributes a number to the scan and no speech to anything.
  const reviewed = await scope.query<Record<string, unknown>>(
    `select call_id, confidence,
            case when corrected_at is not null then text end as text,
            corrected_text
       from transcripts
      where call_id = any($1) and kind = 'final'
      order by offset_ms, id`,
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
  const confidenceByCall = new Map<string, (number | null)[]>();
  for (const t of reviewed) {
    const callId = String(t["call_id"]);
    const confidences = confidenceByCall.get(callId) ?? [];
    confidences.push(t["confidence"] === null ? null : Number(t["confidence"]));
    confidenceByCall.set(callId, confidences);

    // `text` is null exactly when nobody has ruled on the turn, which is the same condition
    // as `corrected_text` being null. Both are checked rather than one, because a verdict
    // that stamped one column and not the other would otherwise reach `scoreCalls` as the
    // string "null" and score as an error against the reviewer.
    const heard = t["text"];
    const corrected = t["corrected_text"];
    if (typeof heard !== "string" || typeof corrected !== "string") continue;
    const list = reviewedByCall.get(callId) ?? [];
    list.push({ heard, corrected });
    reviewedByCall.set(callId, list);
  }

  return calls.map((c) => {
    const callId = String(c["id"]);
    return {
      callId,
      carrierCallId: String(c["carrier_call_id"]),
      createdAt: (c["created_at"] as Date).toISOString(),
      direction: String(c["direction"]),
      configVersion: c["config_version"] === null ? null : Number(c["config_version"]),
      endReason: c["end_reason"] === null ? null : String(c["end_reason"]),
      durationSeconds: c["duration_seconds"] === null ? null : Number(c["duration_seconds"]),
      callerTurns: Number(c["caller_turns"] ?? 0),
      agentTurns: Number(c["agent_turns"] ?? 0),
      events: eventsByCall.get(callId) ?? [],
      reviewed: reviewedByCall.get(callId) ?? [],
      confidences: confidenceByCall.get(callId) ?? [],
    };
  });
};

/** The same read, for the internal viewer, which is told which organisation to act for. */
export const loadCallRecords = async (
  dataSource: Db,
  organizationId: OrganizationId,
  limit = 200,
): Promise<readonly CallRecord[]> =>
  withOrganization(dataSource, organizationId, async (scope) => readCallRecords(scope, limit));

// ---------------------------------------------------------------------------
// Stage timings over a range
// ---------------------------------------------------------------------------

/** One stage of one turn, timed. Nothing identifies the turn — see `RecordedLatency`. */
export interface StageLatency {
  readonly stage: string;
  readonly ms: number;
}

export interface LatencyRange {
  /** Inclusive, ISO 8601, compared against `created_at`. */
  readonly from: string;
  /** Exclusive, so two consecutive ranges do not both contain the same turn. */
  readonly to: string;
}

/**
 * How many rows one range may return.
 *
 * The cap exists because the range is caller-supplied and the row count is traffic, so
 * there is no argument that bounds it. It is not silent: the reader reports whether it
 * bit, and the endpoint passes that on, because a percentile computed over a truncated
 * sample and one computed over the whole range are different numbers with the same name.
 */
const LATENCY_ROW_CAP = 200_000;

export interface StageLatencies {
  readonly rows: readonly StageLatency[];
  /**
   * True when the cap bit, meaning these are the most recent `LATENCY_ROW_CAP` timings in
   * the range rather than all of them. The percentiles are still percentiles — of a
   * recency-biased sample.
   */
  readonly truncated: boolean;
}

/**
 * Raw timings, not percentiles.
 *
 * The arithmetic stays in `apps/api/src/viewer/metrics.ts` with every other metric
 * definition, for the reason at the top of this file: a percentile computed once in SQL
 * for the dashboard and once in TypeScript for the scenario harness is two metrics with
 * one name. What SQL is doing here is the part SQL is actually better at — an index-only
 * scan over a date range (migration 0042) instead of dragging a week of `call_events`
 * through the driver to filter it in Node.
 */
export const readStageLatencies = async (
  scope: OrganizationScope,
  range: LatencyRange,
): Promise<StageLatencies> => {
  const rows = await scope.query<Record<string, unknown>>(
    /* No `organization_id` predicate. `latencies` is behind the same row-level policy as
       `calls`, so the scope already applies, and adding one would suggest the isolation
       came from the predicate rather than from the policy. */
    `select stage, ms
       from latencies
      where created_at >= $1 and created_at < $2
      order by created_at desc
      limit $3`,
    [range.from, range.to, LATENCY_ROW_CAP + 1],
  );

  const truncated = rows.length > LATENCY_ROW_CAP;
  return {
    rows: (truncated ? rows.slice(0, LATENCY_ROW_CAP) : rows).map((r) => ({
      stage: String(r["stage"]),
      ms: Number(r["ms"]),
    })),
    truncated,
  };
};

// ---------------------------------------------------------------------------
// Who this caller is to us
// ---------------------------------------------------------------------------

/**
 * What this number has done before, as three facts and no inference.
 *
 * The point is the prompt line "I can see this has come up before — let me get you
 * straight to someone rather than going through it again." A caller re-explaining an issue
 * to a system that already holds the answer is the most infuriating experience in customer
 * service, and it is entirely avoidable from data already on disk.
 */
export interface CallerHistory {
  /**
   * Whole days since their previous call, or null when there is none inside the window.
   *
   * Null is "we have not spoken recently", not "never" — the window below is finite, and a
   * caller last seen eighteen months ago is a first-time caller for every purpose the
   * agent has.
   */
  readonly lastContactDaysAgo: number | null;
  /** Calls from this number in the seven days before this one. Excludes this one. */
  readonly contactsThisWeek: number;
  /**
   * Their last call ended with a person taking over.
   *
   * Named for what it is rather than for what the brief asked for. The brief wanted
   * `priorIssueUnresolved`, and nothing in the schema knows whether an issue was resolved:
   * `end_reason` on an inbound call is the media stream's close reason — "carrier sent
   * stop", "caller hung up" — written whether or not a transfer happened, so it cannot
   * answer the question. What is recorded, and what this reads, is the
   * `escalated to a human` event. A handover is a fact; "unresolved" would be a guess
   * dressed as one, and the agent would act on it.
   */
  /**
   * Roughly what they rang about last time, in their own words.
   *
   * Read from the transcripts of the previous call rather than stored on it: nothing wrote
   * a subject anywhere, and a column would need something to fill it — which means either
   * a model deciding what a call was about, or a heuristic pretending to. The caller's own
   * first substantive sentence needs neither and is what they would say again if made to
   * start over, which is the thing this exists to prevent.
   *
   * Null when the window holds no prior call, when its transcripts have aged out under
   * `transcript_retention_days`, or when everything they said was hello.
   */
  readonly lastCallAbout: string | null;
  readonly lastCallHandedOver: boolean;
}

export interface CallerHistoryRequest {
  /** E.164, as the carrier gave it. Withheld numbers must not reach here — see below. */
  readonly caller: string;
  /**
   * This call's own carrier id, excluded from its own history.
   *
   * The row already exists by the time this runs: `recordCallStarted` fires at ingress and
   * this fires beside it. Without the exclusion every caller is told they have rung once
   * already today, and the one they rang is this one.
   */
  readonly carrierCallId: string;
  readonly now: Date;
}

/** Beyond this nothing is read. See `lastContactDaysAgo`. */
const HISTORY_WINDOW_DAYS = 90;
/**
 * A caller who has rung more than this in the window is well past every threshold the
 * agent reasons about, so counting further buys nothing and bounds the scan.
 */
const HISTORY_ROW_CAP = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Read it once, as the call connects.
 *
 * Two statements in one organisation-scoped transaction, for the same reason
 * `readCallRecords` uses three: the second only ever concerns one row, and an `exists`
 * correlated across the whole window would run the subquery fifty times to answer a
 * question about the newest.
 *
 * **This is not on the real-time path and must never move onto it.** It is a database read
 * with a caller mid-greeting; the orchestrator holds whatever has arrived and renders
 * nothing when that is nothing. A turn must never wait for it.
 */
/**
 * The openings that are not what a call was about.
 *
 * A greeting, a name and a courtesy are how every call starts and tell you nothing about
 * why this one was made. Matched clause by clause rather than whole-line, because a caller
 * says all of it in one breath and it arrives as one transcript: "Hi. Good evening. My name
 * is Sikiru. How are you doing? I want to book a viewing." Skipping whole lines would drop
 * that entire turn and find nothing.
 *
 * Loose on purpose. These read 8kHz telephony transcripts and half of them are approximate.
 */
const OPENING_CLAUSE: readonly RegExp[] = [
  /^(hi|hello|hey|yo)\b/i,
  /^good (morning|afternoon|evening|day)\b/i,
  /^(yes|yeah|no|okay|ok|sure|please|thanks|thank you|sorry)\b/i,
  /^(my name is|this is|it s|i m)\s+\S+\s*$/i,
  /^how (are you|far|you dey|body|is it going)\b/i,
  /^hope you( a| )re well\b/i,
];

/** Long enough to be a reason, short enough to be said back in one breath. */
const SUBJECT_MAX_CHARS = 120;

/** Two words is a fragment the agent would have to guess around. Guessing is worse than silence. */
const SUBJECT_MIN_WORDS = 3;

const wordsIn = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

export const subjectOf = (lines: readonly string[]): string | null => {
  for (const line of lines) {
    const kept = line
      .split(/(?<=[.!?])\s+/)
      .map((clause) => clause.trim())
      .filter((clause) => clause !== "" && !OPENING_CLAUSE.some((p) => p.test(clause)))
      .join(" ")
      .trim();
    if (wordsIn(kept) < SUBJECT_MIN_WORDS) continue;
    return kept.length <= SUBJECT_MAX_CHARS
      ? kept
      : `${kept.slice(0, SUBJECT_MAX_CHARS).trimEnd()}…`;
  }
  return null;
};

export const readCallerHistory = async (
  scope: OrganizationScope,
  request: CallerHistoryRequest,
): Promise<CallerHistory> => {
  const since = new Date(request.now.getTime() - HISTORY_WINDOW_DAYS * DAY_MS);

  const prior = await scope.query<Record<string, unknown>>(
    /* No `organization_id` predicate: `calls` is behind the same row-level policy as
       everything else here, so the scope already applies and adding one would suggest the
       isolation came from the predicate. The partial index this uses excludes null
       callers, which is also why a withheld number never gets this far. */
    `select c.id, c.created_at
       from calls c
      where c.caller = $1
        and c.carrier_call_id <> $2
        and c.created_at >= $3
      order by c.created_at desc
      limit $4`,
    [request.caller, request.carrierCallId, since.toISOString(), HISTORY_ROW_CAP],
  );

  const newest = prior[0];
  if (newest === undefined) {
    return {
      lastContactDaysAgo: null,
      contactsThisWeek: 0,
      lastCallAbout: null,
      lastCallHandedOver: false,
    };
  }

  const handover = await scope.query<{ handed_over: boolean }>(
    `select exists (
              select 1 from call_events e
               where e.call_id = $1 and e.kind = 'escalated to a human'
            ) as handed_over`,
    [String(newest["id"])],
  );

  /* Their own words from last time, shortest useful form.
   *
   * Ordered by offset and taken in one go rather than filtered in SQL, because "was it
   * substantive" is a judgement about language and belongs beside the words that make it
   * — see `SUBJECT_SKIP`. Four rows is enough: somebody who has said four things has said
   * the reason for the call. */
  const said = await scope.query<{ text: string }>(
    `select t.text
       from transcripts t
      where t.call_id = $1 and t.kind = 'final'
      order by t.offset_ms
      limit 4`,
    [String(newest["id"])],
  );

  const weekAgo = request.now.getTime() - 7 * DAY_MS;
  return {
    /* Floored, so a call twenty hours ago is "today" rather than "yesterday". The agent
       says this out loud, and rounding the wrong way makes it sound like it is guessing. */
    lastContactDaysAgo: Math.max(
      0,
      Math.floor((request.now.getTime() - (newest["created_at"] as Date).getTime()) / DAY_MS),
    ),
    contactsThisWeek: prior.filter((row) => (row["created_at"] as Date).getTime() >= weekAgo)
      .length,
    lastCallAbout: subjectOf(said.map((row) => row.text)),
    lastCallHandedOver: handover[0]?.handed_over ?? false,
  };
};
