import {
  applyTranscriptCorrection,
  listCallPage,
  loadCallDetail,
  readCallRecords,
  type CallFilters,
} from "@ansa/db";
import { Controller, Get, Inject, NotFoundException, Post } from "@nestjs/common";

import { scoreCalls } from "../../viewer/metrics";
import { Endpoint } from "../http/endpoint";
import { PAGE_PROPS, pageResponse, toPageBody, toPageRequest } from "../http/pagination";
import { apiRoute, FromBody, FromPath, FromQuery } from "../http/request";
import {
  flag,
  integer,
  list,
  nullable,
  object,
  optional,
  text,
  type Infer,
} from "../http/schema";
import { timestamp, uuid } from "../schemas";
import { TenantContext } from "../tenancy/tenant-context";

/**
 * The organisation's own call history — the tenant-facing half of the internal viewer.
 *
 * **This is the file to copy from**: a capability-gated, paginated read of a table the
 * call path writes and the dashboard only reads. Worth noticing what is not here. `calls`
 * predates this whole layer, is written by the media gateway, and has `tenant_id` on every
 * row — and no handler below contains a tenant id, a `where tenant_id = …`, or any way to
 * supply one. The scope is the tenant. An endpoint over any other existing table looks
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
});

const callPage = pageResponse(call);

/**
 * The filters, on top of the pagination every list shares.
 *
 * Chosen from what a reviewer actually opens this list to do: find the calls from an
 * afternoon that went wrong, find every call from one number, and work through the ones
 * nobody has ruled on yet. Each is an equality or a range the `(tenant_id, created_at)`
 * index already supports. Anything that would need a scan — substring search over
 * transcripts, for instance — is deliberately absent rather than quietly slow.
 */
const callQuery = object({
  ...PAGE_PROPS,
  from: optional(timestamp()),
  to: optional(timestamp()),
  endReason: optional(text({ maxLength: 64 })),
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
 * orchestrator wrote — the caller's sentence, the policy number they read out, a tenant id
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
  recoveryLines: integer({ minimum: 0 }),
  recoveryRate: ratio(),

  toolCalls: integer({ minimum: 0 }),
  /** Timeouts, adapter errors and open circuits. A refused irreversible tool is not one. */
  toolFailureRate: ratio(),
});

/** How many recent calls a score is computed over. The same window the viewer uses. */
const METRIC_WINDOW = 200;

const toFilters = (query: Infer<typeof callQuery>): CallFilters => ({
  from: query.from ?? null,
  to: query.to ?? null,
  endReason: query.endReason ?? null,
  caller: query.caller ?? null,
  dialled: query.dialled ?? null,
  minDurationSeconds: query.minDurationSeconds ?? null,
  reviewed: query.reviewed ?? null,
});

@Controller(apiRoute("calls"))
export class CallsController {
  constructor(@Inject(TenantContext) private readonly db: TenantContext) {}

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
    return toPageBody(await this.db.tx((scope) => listCallPage(scope, page, filters)));
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
        p95: round(scored.responseLatencyMs.p95),
        samples: scored.responseLatencyMs.samples,
      },
      transferRate: asRatio(scored.transferRate),
      abandonmentRate: asRatio(scored.abandonmentRate),
      hallucinationsDiscarded: scored.hallucinationsDiscarded,
      recoveryLines: scored.recoveryLines,
      recoveryRate: asRatio(scored.recoveryRate),
      toolCalls: scored.toolCalls,
      toolFailureRate: asRatio(scored.toolFailureRate),
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
   * `tenants.audio_retention_days`, and playable by nothing without transcoding. Exposing
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
