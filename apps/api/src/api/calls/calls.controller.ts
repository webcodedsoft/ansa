import {
  applyTranscriptCorrection,
  listCallPage,
  loadCallDetail,
  readCallRecords,
  readStageLatencies,
  type CallFilters,
  type LatencyRange,
} from "@ansa/db";
import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Post,
  UnprocessableEntityException,
} from "@nestjs/common";

import { catchphrases } from "../../viewer/fingerprint";
import { scoreCalls, stagePercentiles } from "../../viewer/metrics";
// Aliased: the handler below is also called `reviewQueue`, and a reader should not have to
// work out that a bare call inside a method resolves to the module import and not to `this`.
import { reviewQueue as rankForReview } from "../../viewer/review";
import { trendByConfigVersion } from "../../viewer/trends";
import { Endpoint } from "../http/endpoint";
import { PAGE_PROPS, pageResponse, toPageBody, toPageRequest } from "../http/pagination";
import { apiRoute, FromBody, FromPath, FromQuery } from "../http/request";
import {
  flag,
  integer,
  list,
  map,
  nullable,
  object,
  optional,
  text,
  type Infer,
} from "../http/schema";
import { timestamp, uuid } from "../schemas";
import { OrganizationContext } from "../tenancy/organization-context";

/**
 * The organisation's own call history — the organization-facing half of the internal viewer.
 *
 * **This is the file to copy from**: a capability-gated, paginated read of a table the
 * call path writes and the dashboard only reads. Worth noticing what is not here. `calls`
 * predates this whole layer, is written by the media gateway, and has `organization_id` on every
 * row — and no handler below contains a organization id, a `where organization_id = …`, or any way to
 * supply one. The scope is the organization. An endpoint over any other existing table looks
 * exactly like this.
 *
 * Three things about it are worth reading before changing it.
 *
 * **Route order is load-bearing.** Nest matches in declaration order, so `metrics` is
 * declared before `:callId` or it is read as a call id — and since that path parameter is
 * a uuid, the symptom would be a 422 complaining the word "metrics" is not a uuid rather
 * than anything that points here.
 *
 * **The quality figures are not computed here.** They come from `readCallRecords` and
 * `scoreCalls`, which are the same two functions the internal viewer's metrics page uses.
 * A second implementation would be a second set of numbers with the same names, and the
 * first argument about which dashboard was right would be unresolvable.
 *
 * **There is no audio.** See the note above the correction endpoint.
 */

const call = object({
  id: uuid(),
  direction: text({ maxLength: 16 }),
  dialled: text({ maxLength: 32 }),
  caller: nullable(text({ maxLength: 32 })),
  answeredAt: nullable(timestamp()),
  endedAt: nullable(timestamp()),
  endReason: nullable(text({ maxLength: 64 })),
  durationSeconds: nullable(integer({ minimum: 0 })),
  createdAt: timestamp(),
  /**
   * Median caller-stopped-to-first-audio for this call, in milliseconds.
   *
   * Null means unmeasured, never fast: a call that never completed a turn — an
   * unanswered outbound, or one that ended mid-sentence — records no latency
   * event to take a median of.
   */
  responseP50Ms: nullable(integer({ minimum: 0 })),
});

const callPage = pageResponse(call);

/**
 * The filters, on top of the pagination every list shares.
 *
 * Chosen from what a reviewer actually opens this list to do: find the calls from an
 * afternoon that went wrong, find every call from one number, and work through the ones
 * nobody has ruled on yet. Each is an equality or a range the `(organization_id, created_at)`
 * index already supports. Anything that would need a scan — substring search over
 * transcripts, for instance — is deliberately absent rather than quietly slow.
 */
const callQuery = object({
  ...PAGE_PROPS,
  from: optional(timestamp()),
  to: optional(timestamp()),
  endReason: optional(text({ maxLength: 64 })),
  /**
   * Calls this agent handled (migration 0018).
   *
   * Not the same question as `dialled`. A number can be moved between agents, so filtering
   * by number asks "calls to this line" and this asks "calls this agent handled" — the one
   * that stays true after a reassignment.
   */
  agentId: optional(uuid()),
  caller: optional(text({ maxLength: 32 })),
  dialled: optional(text({ maxLength: 32 })),
  minDurationSeconds: optional(integer({ minimum: 0 })),
  reviewed: optional(flag()),
});

const callPath = object({ callId: uuid() });

/**
 * `transcripts.id` is a bigserial, so the id is digits and nothing else.
 *
 * Checked here rather than left to Postgres: an unconstrained string reaches the query as
 * a parameter compared against a bigint, and the driver's "invalid input syntax" comes
 * back as a 500 — the caller's typo, reported as our fault.
 */
const transcriptPath = object({
  callId: uuid(),
  transcriptId: text({ maxLength: 19, pattern: /^[1-9][0-9]{0,18}$/ }),
});

/**
 * A transcript, and whether anybody has ruled on it.
 *
 * `correctedAt` set with `correctedText` equal to `text` is the reviewer saying the
 * transcriber was right, which is a different thing from nobody having looked — and the
 * difference is the denominator of every accuracy figure on the metrics endpoint.
 */
const transcript = object({
  id: text({ maxLength: 19 }),
  // No maxLength on what came out of the database. A bound on a response field is not a
  // guard, it is a way to turn one unusually long turn into a 500 for the whole call:
  // the interceptor projects through this schema and a failure there is ours, not the
  // caller's. Bounds belong on input, where `correction` has one.
  text: text(),
  correctedText: nullable(text()),
  correctedAt: nullable(timestamp()),
  confidence: nullable(text({ maxLength: 24 })),
  offsetMs: integer({ minimum: 0 }),
  provider: text({ maxLength: 64 }),
});

const turn = object({
  seq: integer({ minimum: 0 }),
  speaker: text({ maxLength: 16 }),
  startedOffsetMs: integer({ minimum: 0 }),
  endedOffsetMs: nullable(integer({ minimum: 0 })),
  bargedInAtMs: nullable(integer({ minimum: 0 })),
});

/**
 * One event on the call's timeline.
 *
 * `detail` is a fixed set of scalars rather than the `jsonb` column, and the projection
 * happens in `@ansa/db` where the row is read. The column carries whatever the
 * orchestrator wrote — the caller's sentence, the policy number they read out, a organization id
 * — and publishing it whole would put this response outside the allowlist every other
 * response in this API sits behind. What the caller said is in `transcripts`, which is the
 * field a reviewer corrects and the one place this API publishes speech.
 */
const callEvent = object({
  kind: text(),
  offsetMs: nullable(integer()),
  at: timestamp(),
  detail: object({
    stage: nullable(text()),
    ms: nullable(integer()),
    seq: nullable(integer()),
    attempt: nullable(integer()),
    reason: nullable(text()),
    subject: nullable(text()),
    outcome: nullable(text()),
    tool: nullable(text()),
    chars: nullable(integer()),
  }),
});

const callDetail = object({
  id: uuid(),
  carrierCallId: text({ maxLength: 128 }),
  direction: text({ maxLength: 16 }),
  dialled: text({ maxLength: 32 }),
  caller: nullable(text({ maxLength: 32 })),
  answeredAt: nullable(timestamp()),
  endedAt: nullable(timestamp()),
  endReason: nullable(text({ maxLength: 64 })),
  durationSeconds: nullable(integer({ minimum: 0 })),
  configVersion: nullable(integer()),
  createdAt: timestamp(),
  /**
   * Median caller-stopped-to-first-audio for this call, in milliseconds.
   *
   * Null means unmeasured, never fast: a call that never completed a turn — an
   * unanswered outbound, or one that ended mid-sentence — records no latency
   * event to take a median of.
   */
  responseP50Ms: nullable(integer({ minimum: 0 })),
  turns: list(turn),
  transcripts: list(transcript),
  events: list(callEvent),
});

const correction = object({
  /**
   * What the reviewer heard. Submitting the transcriber's own words back is the point:
   * that is the verdict "this one was right", and without it there is no denominator.
   */
  correctedText: text({ maxLength: 8_000 }),
});

const verdict = object({
  transcriptId: text({ maxLength: 19 }),
  callId: uuid(),
  text: text(),
  correctedText: text(),
  correctedAt: timestamp(),
  /** False when the reviewer confirmed the transcriber. Still a review, still counted. */
  changed: flag(),
});

const percentiles = object({
  p50: nullable(integer()),
  /** Where a latency problem shows first while still having enough samples to mean something. */
  p90: nullable(integer()),
  p95: nullable(integer()),
  samples: integer({ minimum: 0 }),
});

/**
 * A rate, as text.
 *
 * The schema layer has integers and no decimals, and widening it for this would be the
 * wrong trade: a rate rendered as a string the client parses once is honest about its
 * precision, whereas an integer percentage silently loses the difference between a 0.4%
 * transfer rate and a 0% one. Null where the denominator was zero — "no calls yet" and
 * "no transfers" are not the same reading and must not both show as 0.
 */
const ratio = () => nullable(text({ maxLength: 24 }));

const asRatio = (value: number | null): string | null => (value === null ? null : value.toFixed(4));

const round = (value: number | null): number | null => (value === null ? null : Math.round(value));

/**
 * The definitions travel with the numbers.
 *
 * A metric whose definition is folklore is worse than no metric: two people read the same
 * dashboard and disagree about what it says. Each field's meaning is in
 * `apps/api/src/viewer/metrics.ts`, and the summaries here are the same sentences.
 */
const quality = object({
  /** How many recent calls the window covers. Every rate below is over these. */
  calls: integer({ minimum: 0 }),
  callerTurns: integer({ minimum: 0 }),
  agentTurns: integer({ minimum: 0 }),

  /** Transcripts a human has ruled on, changed or not. The denominator of the two below. */
  reviewed: integer({ minimum: 0 }),
  /** Share of reviewed transcripts the transcriber got word-for-word right. */
  sttExactMatch: ratio(),
  /** 1 − word error rate against the reviewer's text, pooled over every reviewed turn. */
  sttWordAccuracy: ratio(),
  /** Share of reviewed transcripts a human had to change. */
  correctionRate: ratio(),

  /** Share of caller turns that triggered a readback. */
  confirmationRate: ratio(),
  /** Share of readbacks the caller rejected — the agent read a number back wrong. */
  readbackRejectionRate: ratio(),
  /** Values the caller confirmed, over readbacks opened. */
  captureCompletionRate: ratio(),

  /** Interruptions per agent turn. */
  bargeInRate: ratio(),
  /** Caller stopped speaking → first byte of the reply reached the carrier. */
  responseLatencyMs: percentiles,

  /** Calls that reached "escalated to a human". */
  transferRate: ratio(),
  /** Calls where the caller never took a turn: they heard the greeting and went. */
  abandonmentRate: ratio(),

  /** Transcripts the speech gate threw away as invented. Not a rate: any at all is news. */
  hallucinationsDiscarded: integer({ minimum: 0 }),
  /** Turns that produced nothing and had to be covered with an apology. */
  /** Turns the prompt lost: too long, or carrying formatting a voice reads out loud. */
  driftedTurns: integer({ minimum: 0 }),
  recoveryLines: integer({ minimum: 0 }),
  recoveryRate: ratio(),

  toolCalls: integer({ minimum: 0 }),
  /** Timeouts, adapter errors and open circuits. A refused irreversible tool is not one. */
  toolFailureRate: ratio(),
});

/**
 * One flagged call, with the reasons it is on the list (R9.2.1, R9.2.2).
 *
 * `reviewed` and `unreviewed` count final transcripts, not calls: a call somebody has
 * half worked through is the common case and "reviewed: true" would hide it.
 */
const reviewSignal = object({
  /** A stable identifier for the heuristic — safe to switch on in a client. */
  kind: text({ maxLength: 32 }),
  count: integer({ minimum: 0 }),
  /** What this signal contributed to `severity`, after the scan's per-signal cap. */
  weight: integer({ minimum: 0 }),
  why: text({ maxLength: 200 }),
});

const flaggedCall = object({
  id: uuid(),
  carrierCallId: text({ maxLength: 128 }),
  createdAt: timestamp(),
  endReason: nullable(text({ maxLength: 64 })),
  durationSeconds: nullable(integer({ minimum: 0 })),
  configVersion: nullable(integer()),
  /**
   * Higher is worse, and it means nothing beyond ordering.
   *
   * Not a percentage, not a grade, and deliberately not normalised into one: a 0–100 score
   * invites "we are at 94% quality", which this number cannot support. It is a sum of
   * weights whose only job is to decide which call is opened next.
   */
  severity: integer({ minimum: 0 }),
  reviewed: integer({ minimum: 0 }),
  unreviewed: integer({ minimum: 0 }),
  signals: list(reviewSignal),
});

const reviewQueueResponse = object({
  /** How many recent calls were scanned. The denominator for `flagged`. */
  scanned: integer({ minimum: 0 }),
  flagged: integer({ minimum: 0 }),
  calls: list(flaggedCall),
});

const reviewQueueQuery = object({
  /** Calls scoring below this are left out. Default 1, which is "anything at all fired". */
  minSeverity: optional(integer({ minimum: 0 })),
  /** `false` is the backlog: calls where no transcript has been ruled on yet. */
  reviewed: optional(flag()),
  limit: optional(integer({ minimum: 1, maximum: 200 })),
});

/** How many recent calls a score is computed over. The same window the viewer uses. */
const METRIC_WINDOW = 200;

/**
 * The window's quality, split by the configuration that served each call (R9.2.6).
 *
 * Four figures rather than all fourteen, chosen because they are the ones that move when
 * something changes: how much of the window got flagged, how much of it a human had to
 * correct, how fast it answered and how often it gave up. The full set is on `/metrics`,
 * which reports the window as a whole.
 */
const configTrend = object({
  /** Null for calls that recorded no version — an unregistered number, or a pre-R7.5 call. */
  configVersion: nullable(integer()),
  calls: integer({ minimum: 0 }),
  firstCallAt: timestamp(),
  lastCallAt: timestamp(),
  /** Calls the scan flagged, over calls served. */
  flaggedRate: ratio(),
  /** Total severity over calls served — how bad the flagged ones were, not just how many. */
  severityPerCall: ratio(),
  reviewed: integer({ minimum: 0 }),
  correctionRate: ratio(),
  sttWordAccuracy: ratio(),
  responseLatencyP50Ms: nullable(integer()),
  transferRate: ratio(),
});

const trendsResponse = object({ versions: list(configTrend) });

// ---------------------------------------------------------------------------
// Latency over a range
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
/** A week, because that is the window somebody looks at after changing a provider. */
const DEFAULT_LATENCY_DAYS = 7;
/**
 * The longest range one request may ask for.
 *
 * Not arbitrary caution: the range is caller-supplied and the row count is traffic, so
 * nothing else bounds the query. A month is long enough to see a regression and short
 * enough that the answer arrives.
 */
const MAX_LATENCY_DAYS = 31;

const latencyQuery = object({
  /** Inclusive. Defaults to seven days before `to`. */
  from: optional(timestamp()),
  /** Exclusive, so two consecutive ranges do not both contain the same turn. Defaults to now. */
  to: optional(timestamp()),
});

const latencyResponse = object({
  /** Echoed back resolved, so a caller who sent neither knows what was measured. */
  from: timestamp(),
  to: timestamp(),
  /**
   * True when the range held more timings than one request returns.
   *
   * Reported rather than swallowed. These are still percentiles, but of the most recent
   * slice of the range instead of all of it, and a truncated sample presented as a whole
   * one is how a dashboard comes to disagree with the database.
   */
  truncated: flag(),
  /**
   * Keyed by stage — `stt_final`, `llm_first_token`, `tts_first_byte`, `turn_to_audio`.
   *
   * A map rather than a fixed set of fields, because the stages are whatever the
   * orchestrator measured. Adding a `mark()` should make a stage appear here without a
   * schema change, and a stage that stops being recorded should disappear rather than
   * report zeros forever.
   */
  stages: map(percentiles, { maxProperties: 64 }),
});

/**
 * Resolve the range, or refuse it.
 *
 * Refusing loudly rather than clamping quietly: a caller who asks for a year and receives
 * a month has no way to tell, and would read the answer as a year's percentiles.
 */
const toLatencyRange = (query: Infer<typeof latencyQuery>): LatencyRange => {
  const to = query.to === undefined ? new Date() : new Date(query.to);
  const from =
    query.from === undefined ? new Date(to.getTime() - DEFAULT_LATENCY_DAYS * DAY_MS) : new Date(query.from);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new UnprocessableEntityException("from and to must be timestamps");
  }
  if (from.getTime() >= to.getTime()) {
    throw new UnprocessableEntityException("from must be before to");
  }
  if (to.getTime() - from.getTime() > MAX_LATENCY_DAYS * DAY_MS) {
    throw new UnprocessableEntityException(
      `the range must be ${MAX_LATENCY_DAYS} days or less, ask for a shorter one`,
    );
  }
  return { from: from.toISOString(), to: to.toISOString() };
};

const catchphrase = object({
  /** The normalised shape, which is what groups two differently-worded turns as one. */
  shape: text({ maxLength: 400 }),
  /** One utterance as it was said, so the report reads like speech rather than like a key. */
  example: text({ maxLength: 400 }),
  /** Distinct calls containing it. Calls, never utterances — three in one call is one call. */
  calls: integer({ minimum: 0 }),
  /** That count over the calls scanned. A string for the reason `ratio` is; see below. */
  share: text({ maxLength: 8 }),
});

const catchphraseResponse = object({
  callsScanned: integer({ minimum: 0 }),
  /** Worst first. Empty is the healthy answer. */
  phrases: list(catchphrase),
});

const toFilters = (query: Infer<typeof callQuery>): CallFilters => ({
  from: query.from ?? null,
  to: query.to ?? null,
  endReason: query.endReason ?? null,
  agentId: query.agentId ?? null,
  caller: query.caller ?? null,
  dialled: query.dialled ?? null,
  minDurationSeconds: query.minDurationSeconds ?? null,
  reviewed: query.reviewed ?? null,
});

@Controller(apiRoute("calls"))
export class CallsController {
  constructor(@Inject(OrganizationContext) private readonly db: OrganizationContext) {}

  @Get()
  @Endpoint({
    summary: "List this organisation's calls, newest first",
    description:
      "Filters combine with AND. `from` is inclusive and `to` exclusive, so two consecutive ranges do not both contain a call on the boundary. `reviewed` selects calls where somebody has ruled on at least one transcript.",
    capability: "calls:read",
    query: callQuery,
    response: callPage,
  })
  async list(@FromQuery() query: Infer<typeof callQuery>): Promise<Infer<typeof callPage>> {
    const page = toPageRequest(query);
    const filters = toFilters(query);
    return toPageBody(await this.db.tx((scope) => listCallPage(scope, page, filters)), query);
  }

  /**
   * Declared before `:callId`, and that is not a preference — Nest matches routes in
   * declaration order, so below it this path is read as a call id and answers 422.
   */
  @Get("metrics")
  @Endpoint({
    summary: "Quality metrics over this organisation's recent calls",
    description:
      "Computed over the last 200 calls, from the same event log and the same arithmetic the internal viewer uses. Rates are strings so their precision is not rounded away, and null where the denominator was zero — no calls yet and no transfers are different readings.",
    capability: "calls:read",
    response: quality,
  })
  async metrics(): Promise<Infer<typeof quality>> {
    const records = await this.db.tx((scope) => readCallRecords(scope, METRIC_WINDOW));
    const scored = scoreCalls(records);
    return {
      calls: scored.calls,
      callerTurns: scored.callerTurns,
      agentTurns: scored.agentTurns,
      reviewed: scored.reviewed,
      sttExactMatch: asRatio(scored.sttExactMatch),
      sttWordAccuracy: asRatio(scored.sttWordAccuracy),
      correctionRate: asRatio(scored.correctionRate),
      confirmationRate: asRatio(scored.confirmationRate),
      readbackRejectionRate: asRatio(scored.readbackRejectionRate),
      captureCompletionRate: asRatio(scored.captureCompletionRate),
      bargeInRate: asRatio(scored.bargeInRate),
      responseLatencyMs: {
        // Rounded because the schema says integer and a stage measured in fractions of a
        // millisecond would otherwise fail the projection and 500 the whole page.
        p50: round(scored.responseLatencyMs.p50),
        p90: round(scored.responseLatencyMs.p90),
        p95: round(scored.responseLatencyMs.p95),
        samples: scored.responseLatencyMs.samples,
      },
      transferRate: asRatio(scored.transferRate),
      abandonmentRate: asRatio(scored.abandonmentRate),
      hallucinationsDiscarded: scored.hallucinationsDiscarded,
      driftedTurns: scored.driftedTurns,
      recoveryLines: scored.recoveryLines,
      recoveryRate: asRatio(scored.recoveryRate),
      toolCalls: scored.toolCalls,
      toolFailureRate: asRatio(scored.toolFailureRate),
    };
  }

  /**
   * The review queue (R9.2.2), and why it is not a filter on the list above.
   *
   * "Worth looking at first" is computed in `apps/api/src/viewer/review.ts` from the event
   * log — the same file, the same weights and the same window the internal viewer's queue
   * uses. Expressing it as a `?flagged=true` clause on `listCallPage` would mean writing
   * the heuristics a second time in SQL, and the day the two spellings drifted the
   * dashboard and the viewer would disagree about which calls went wrong. That is the
   * mistake `metrics.ts` was written to avoid and it is not worth repeating for a filter.
   *
   * So this is a separate ranked read over a bounded window, exactly like `/metrics`, and
   * for the same reason: severity is arithmetic over events, and neither the ordering nor
   * the threshold exists as a column anything could page over.
   *
   * Declared before `:callId` or Nest reads the path as a call id and answers 422.
   */
  /**
   * Per-stage response times over a date range.
   *
   * Separate from `/metrics` and not folded into it, because the two answer different
   * questions from different sources. `/metrics` scores the last two hundred calls from
   * the event log and reports one number — caller stopped, agent started. This reports
   * every stage over a range the caller chooses, from the `latencies` table, which is the
   * only one indexed for that. A regression lives in a stage; the single number only tells
   * you there is one.
   *
   * Declared before `:callId` for the reason at the top of this file.
   */
  @Get("latency")
  @Endpoint({
    summary: "Response time per pipeline stage, as percentiles",
    description:
      "Percentiles, never averages: a mean hides the calls that make somebody hang up. `from` is inclusive and `to` exclusive; both default to the last seven days, and a range longer than 31 days is refused rather than clamped. `stages` is keyed by whatever the orchestrator measured — typically `stt_final`, `llm_first_token`, `tts_first_byte` and `turn_to_audio`.",
    capability: "calls:read",
    query: latencyQuery,
    response: latencyResponse,
  })
  async latency(@FromQuery() query: Infer<typeof latencyQuery>): Promise<Infer<typeof latencyResponse>> {
    const range = toLatencyRange(query);
    const measured = await this.db.tx((scope) => readStageLatencies(scope, range));
    const stages: Record<string, Infer<typeof percentiles>> = {};
    for (const [stage, p] of Object.entries(stagePercentiles(measured.rows))) {
      // Rounded for the same reason `/metrics` rounds: the schema says integer.
      stages[stage] = { p50: round(p.p50), p90: round(p.p90), p95: round(p.p95), samples: p.samples };
    }
    return { from: range.from, to: range.to, truncated: measured.truncated, stages };
  }

  /**
   * Phrasings the agent has started using on most calls.
   *
   * Nothing on the call path feeds this. Every agent utterance has been recorded with its
   * text since the event log existed, so this is a read over calls already on disk — which
   * also means it had something to say the day it shipped rather than in a month.
   *
   * Declared before `:callId` for the reason at the top of this file.
   */
  @Get("catchphrases")
  @Endpoint({
    summary: "Phrasings appearing in more than 15% of recent calls",
    description:
      "Counted per call rather than per utterance: saying something three times in one difficult call is one awkward call, and saying it once in every call is a catchphrase. Numbers are flattened to `#` so a phrasing that quotes a figure still groups with itself. An empty list is the healthy answer.",
    capability: "calls:read",
    response: catchphraseResponse,
  })
  async catchphrases(): Promise<Infer<typeof catchphraseResponse>> {
    const records = await this.db.tx((scope) => readCallRecords(scope, METRIC_WINDOW));
    const report = catchphrases(records);
    return {
      callsScanned: report.callsScanned,
      phrases: report.phrases.map((phrase) => ({
        shape: phrase.shape,
        example: phrase.example,
        calls: phrase.calls,
        // Text, for the same reason every other rate here is text: four decimal places
        // survive the trip without the schema layer rounding them away.
        share: phrase.share.toFixed(4),
      })),
    };
  }

  @Get("review-queue")
  @Endpoint({
    summary: "Calls worth reviewing first, worst rated highest",
    description:
      "Scanned over the last 200 calls against the failure heuristics in R9.2.1: invented speech, escalations, repeated readbacks, low-confidence turns, interruption storms, recovery lines, dropped sentences, capture falling through to spelling or the keypad, dead air over two seconds, tool failures and calls where the caller never spoke. `severity` orders the list and means nothing else.",
    capability: "calls:read",
    query: reviewQueueQuery,
    response: reviewQueueResponse,
  })
  async reviewQueue(
    @FromQuery() query: Infer<typeof reviewQueueQuery>,
  ): Promise<Infer<typeof reviewQueueResponse>> {
    const records = await this.db.tx((scope) => readCallRecords(scope, METRIC_WINDOW));
    const queue = rankForReview(records, {
      minSeverity: query.minSeverity,
      reviewed: query.reviewed,
      limit: query.limit,
    });
    return {
      scanned: records.length,
      flagged: queue.length,
      calls: queue.map((score) => ({
        id: score.callId,
        carrierCallId: score.carrierCallId,
        createdAt: score.createdAt,
        endReason: score.endReason,
        durationSeconds: score.durationSeconds,
        configVersion: score.configVersion,
        severity: score.severity,
        reviewed: score.reviewed,
        unreviewed: score.unreviewed,
        signals: score.signals.map((signal) => ({
          kind: signal.kind,
          count: signal.count,
          weight: signal.weight,
          why: signal.why,
        })),
      })),
    };
  }

  /**
   * Quality over the window, sliced by the configuration that served each call (R9.2.6).
   *
   * The point is attribution: a prompt or persona change publishes a new `config_version`,
   * every call records which one answered it, and the difference between two rows is the
   * only honest way to say a change moved anything. What it cannot say is *what* changed —
   * provider, model and endpointing are deployment settings and identical across versions
   * on the same deploy. See the note in `viewer/trends.ts`.
   *
   * Declared before `:callId`, as above.
   */
  @Get("trends")
  @Endpoint({
    summary: "Quality over recent calls, by configuration version",
    description:
      "One row per `config_version` in the last 200 calls, newest version first, with the calls that recorded no version last. A version with few calls is included with its count rather than hidden, because a rollout that looks like it had no effect for an hour is worse than a small denominator.",
    capability: "calls:read",
    response: trendsResponse,
  })
  async trends(): Promise<Infer<typeof trendsResponse>> {
    const records = await this.db.tx((scope) => readCallRecords(scope, METRIC_WINDOW));
    return {
      versions: trendByConfigVersion(records).map((trend) => ({
        configVersion: trend.configVersion,
        calls: trend.calls,
        firstCallAt: trend.firstCallAt,
        lastCallAt: trend.lastCallAt,
        flaggedRate: asRatio(trend.flaggedRate),
        severityPerCall: asRatio(trend.severityPerCall),
        reviewed: trend.metrics.reviewed,
        correctionRate: asRatio(trend.metrics.correctionRate),
        sttWordAccuracy: asRatio(trend.metrics.sttWordAccuracy),
        responseLatencyP50Ms: round(trend.metrics.responseLatencyMs.p50),
        transferRate: asRatio(trend.metrics.transferRate),
      })),
    };
  }

  @Get(":callId")
  @Endpoint({
    summary: "One call, turn by turn",
    description:
      "Turns with their barge-in offsets, final transcripts with confidence and the provider that produced them, the event timeline ordered by offset, and the configuration version that served the call. There is no audio; see the API README.",
    capability: "calls:read",
    params: callPath,
    response: callDetail,
  })
  async detail(@FromPath() path: Infer<typeof callPath>): Promise<Infer<typeof callDetail>> {
    const detail = await this.db.tx((scope) => loadCallDetail(scope, path.callId));
    // 404 rather than 403 for another organisation's call, as everywhere else: under RLS
    // "not yours" and "not there" are one query result, and answering differently would
    // confirm the id exists.
    if (detail === null) throw new NotFoundException();
    return {
      ...detail,
      transcripts: detail.transcripts.map((t) => ({
        ...t,
        // Postgres `real`, so it arrives as a float. Rendered rather than rounded for the
        // same reason the rates are: 0.62 and 0.6 are different evidence about a turn.
        confidence: t.confidence === null ? null : t.confidence.toFixed(3),
      })),
    };
  }

  /**
   * Records a reviewer's verdict on one transcript (R9.2.3).
   *
   * **Submitting the text unchanged is also a verdict.** It stamps `corrected_at` with
   * `corrected_text` equal to `text`, and without that "reviewed" and "wrong" are the same
   * set: a hundred perfect transcripts and a hundred nobody has opened look identical, and
   * no accuracy rate exists. That is why this is a plain POST with the text in it rather
   * than an endpoint you only call when something is wrong.
   *
   * **Why there is no audio here, or anywhere on this controller.** A reviewer would
   * obviously like to hear the turn. What exists is a raw µ-law byte stream written to the
   * process's own disk under `RECORD_AUDIO_DIR` — an operator diagnostic that is off by
   * default, keyed by the carrier's call id rather than by anything in this API, swept on
   * `organizations.audio_retention_days`, and playable by nothing without transcoding. Exposing
   * it would mean this API grew a media path, and the endpoint would answer 404 for almost
   * every call because the flag was off when it happened.
   *
   * That is the practical objection. The real one is that the recording is a caller
   * reading their policy number aloud — the most sensitive thing the system holds. Serving
   * it needs expiring single-use URLs that are not a guessable path, and a record of who
   * listened to whose voice and when. That is a slice, with its own decisions; it is not a
   * field added to a response. The review loop this endpoint serves works without it,
   * because the question a reviewer answers is "is this text what was said", and the text
   * plus the transcriber's confidence is what that question is about.
   *
   * The corrected text is never logged. It is the sentence the caller spoke.
   */
  @Post(":callId/transcripts/:transcriptId/corrections")
  @Endpoint({
    summary: "Record a review verdict on one transcript",
    description:
      "Submitting the transcriber's own words back is a verdict, not a no-op: it marks the transcript reviewed and correct. `changed` says which it was.",
    capability: "calls:write",
    params: transcriptPath,
    body: correction,
    response: verdict,
  })
  async correct(
    @FromPath() path: Infer<typeof transcriptPath>,
    @FromBody() body: Infer<typeof correction>,
  ): Promise<Infer<typeof verdict>> {
    const recorded = await this.db.tx((scope) =>
      applyTranscriptCorrection(scope, {
        transcriptId: path.transcriptId,
        // Named, so a transcript id from a different call is refused rather than filed
        // against the turn the reviewer was not looking at.
        callId: path.callId,
        correctedText: body.correctedText,
      }),
    );
    if (recorded === null) throw new NotFoundException();
    return recorded;
  }
}
