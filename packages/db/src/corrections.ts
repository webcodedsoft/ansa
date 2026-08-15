import type { OrganizationId } from "@ansa/shared";

import type { Db } from "./data-source";
import { withOrganization, type OrganizationScope } from "./organization-scope";

/**
 * The R9.2 review loop, as two queries.
 *
 * `transcripts.corrected_text` and `corrected_at` have existed since schema v1 and
 * nothing has ever written them. They are the mechanism the whole quality story rests on:
 * production audio has no ground truth until a human supplies it (R9.2.3), and a
 * correction is what turns one caller's mishearing into a keyterm, a normalizer test case
 * and a regression test for every organization (R9.2.4, R9.2.5).
 *
 * **A review verdict is recorded even when nothing was wrong.** Submitting the text
 * unchanged stamps `corrected_at` with `corrected_text` equal to `text`. Without that,
 * "corrected" and "reviewed" are the same set and no accuracy rate can be computed from
 * the table: a hundred perfect transcripts and a hundred unreviewed ones look identical.
 */

export interface TranscriptCorrection {
  readonly transcriptId: string;
  /** What the human heard on the recording. Equal to `text` when the transcriber was right. */
  readonly correctedText: string;
  /**
   * The call the reviewer believes this transcript belongs to, when the caller knows one.
   *
   * The dashboard addresses a transcript through its call — `/calls/{callId}/transcripts/
   * {transcriptId}/corrections` — and a transcript id from a different call arriving on
   * that path is a client bug, not a verdict to record silently against the wrong turn.
   * Null means "do not constrain", which is the internal viewer, where the reviewer is
   * looking at one rendered page and the id came off it.
   */
  readonly callId?: string | null;
}

/** One recorded verdict, as the reviewer's screen should now show it. */
export interface ReviewVerdict {
  readonly transcriptId: string;
  readonly callId: string;
  /** What the transcriber heard. Unchanged by a correction — the pair is the evidence. */
  readonly text: string;
  readonly correctedText: string;
  readonly correctedAt: string;
  /** False when the reviewer submitted the transcriber's own words back. Still a verdict. */
  readonly changed: boolean;
}

/**
 * Records one reviewer's verdict on one transcript, inside a scope the caller already has.
 *
 * Two statements rather than one `update … returning`, and not for taste: TypeORM's
 * Postgres driver special-cases UPDATE and DELETE and hands back `[rows, affectedCount]`
 * instead of the rows, so `(await scope.query("update … returning id")).length > 0` is
 * always true — and a cross-organization correction RLS had correctly refused reported success.
 * `scope.mutate` unwraps that shape, but the select still leads, because it is also what
 * decides whether the transcript is on the call the caller named and what the transcriber
 * originally heard. Both statements run in the same organization-scoped transaction, so the
 * check and the write cannot disagree.
 *
 * Null when the row is not theirs, not there, or not on that call. The three are one
 * answer on purpose.
 */
export const applyTranscriptCorrection = async (
  scope: OrganizationScope,
  correction: TranscriptCorrection,
): Promise<ReviewVerdict | null> => {
  const existing = await scope.query<{ id: string; call_id: string; text: string }>(
    "select id, call_id, text from transcripts where id = $1",
    [correction.transcriptId],
  );
  const row = existing[0];
  if (row === undefined) return null;
  const wanted = correction.callId ?? null;
  if (wanted !== null && row.call_id !== wanted) return null;

  const stamped = await scope.mutate<{ corrected_at: Date }>(
    `update transcripts set corrected_text = $2, corrected_at = now()
      where id = $1 returning corrected_at`,
    [correction.transcriptId, correction.correctedText],
  );
  const correctedAt = stamped[0]?.corrected_at;
  // The select found it a moment ago in this same transaction, so no row here means the
  // driver handed back something other than what it claims to. Louder than a false null.
  if (correctedAt === undefined) throw new Error("the correction updated no row");

  return {
    transcriptId: row.id,
    callId: row.call_id,
    text: row.text,
    correctedText: correction.correctedText,
    correctedAt: correctedAt.toISOString(),
    changed: correction.correctedText !== row.text,
  };
};

/**
 * The same verdict, for a caller that has a organization id rather than a scope.
 *
 * The internal viewer, which is told which organisation to act for because there is no
 * session there to infer one from. One implementation underneath, so the dashboard and the
 * viewer cannot record a correction two different ways.
 */
export const recordTranscriptCorrection = async (
  dataSource: Db,
  organizationId: OrganizationId,
  correction: TranscriptCorrection,
): Promise<boolean> =>
  withOrganization(
    dataSource,
    organizationId,
    async (scope) => (await applyTranscriptCorrection(scope, correction)) !== null,
  );

/**
 * One reviewed turn, in the shape the eval corpus wants.
 *
 * `heard` is what the transcriber produced and `corrected` is the truth. A pair where the
 * two differ is a test case; a pair where they agree is a passing one, and both belong in
 * the corpus — a corpus of only the failures scores every provider at zero.
 */
export interface CorpusEntry {
  readonly transcriptId: string;
  readonly callId: string;
  readonly carrierCallId: string;
  readonly offsetMs: number;
  readonly provider: string;
  readonly confidence: number | null;
  readonly heard: string;
  readonly corrected: string;
  readonly correctedAt: Date;
}

/**
 * Every corrected transcript for one organization, newest first — the eval corpus, exported.
 *
 * Deliberately not filtered to the mistakes. R9.1.9 blocks a provider change on
 * number-accuracy regression, and a regression is only measurable against turns the
 * incumbent got right as well as the ones it got wrong.
 */
const toCorpusEntry = (r: Record<string, unknown>): CorpusEntry => ({
  transcriptId: String(r["id"]),
  callId: String(r["call_id"]),
  carrierCallId: String(r["carrier_call_id"]),
  offsetMs: Number(r["offset_ms"]),
  provider: String(r["provider"]),
  confidence: r["confidence"] === null ? null : Number(r["confidence"]),
  heard: String(r["text"]),
  corrected: String(r["corrected_text"]),
  correctedAt: r["corrected_at"] as Date,
});

export const exportCorpus = async (
  dataSource: Db,
  organizationId: OrganizationId,
  limit = 500,
): Promise<readonly CorpusEntry[]> =>
  withOrganization(dataSource, organizationId, async (scope) => {
    const rows = await scope.query<Record<string, unknown>>(
      `select t.id, t.call_id, c.carrier_call_id, t.offset_ms, t.provider, t.confidence,
              t.text, t.corrected_text, t.corrected_at
         from transcripts t
         join calls c on c.id = t.call_id
        where t.corrected_at is not null
        order by t.corrected_at desc
        limit $1`,
      [Math.min(limit, 5_000)],
    );
    return rows.map(toCorpusEntry);
  });

/**
 * One call's reviewed turns, together with the listen configuration that produced them.
 *
 * This is what an `eval/` claim file is assembled from, and the second half is why it is a
 * separate read from `exportCorpus`. `eval/verdict.py` refuses to score a configuration
 * whose `provider`, `model`, `encoding`, `sample_rate`, `language` or `endpointing` is
 * missing, on the grounds that a result nobody can reproduce cannot be compared with
 * anything. The orchestrator already writes all of that down once per call as the `call
 * configuration` event — precisely so a transcript is interpretable later — and this is the
 * reader that finally uses it.
 *
 * `listenConfig` is the event's detail verbatim, and that is safe to hand out because the
 * event carries settings and no speech: provider, model, encoding, sample rate, endpointing
 * thresholds, and for Deepgram the *number* of keyterms rather than the keyterms. Nothing a
 * caller said reaches it. What a caller said is in `entries`, which is the corrected pairs
 * a human has already read.
 */
export interface ClaimSource {
  readonly callId: string;
  readonly carrierCallId: string;
  /** Which configuration version served the call (R7.5), for the claim's provenance note. */
  readonly configVersion: number | null;
  /** Null when the call predates the `call configuration` event, or never started one. */
  readonly listenConfig: Readonly<Record<string, unknown>> | null;
  readonly entries: readonly CorpusEntry[];
}

/** Null when the call is not theirs or not there — the same answer, as everywhere else. */
export const readClaimSource = async (
  dataSource: Db,
  organizationId: OrganizationId,
  callId: string,
): Promise<ClaimSource | null> =>
  withOrganization(dataSource, organizationId, async (scope) => {
    const calls = await scope.query<Record<string, unknown>>(
      "select id, carrier_call_id, config_version from calls where id = $1",
      [callId],
    );
    const call = calls[0];
    if (call === undefined) return null;

    const configured = await scope.query<{ detail: unknown }>(
      `select detail from call_events
        where call_id = $1 and kind = 'call configuration'
        order by id limit 1`,
      [callId],
    );
    const detail = configured[0]?.detail;

    const rows = await scope.query<Record<string, unknown>>(
      `select t.id, t.call_id, c.carrier_call_id, t.offset_ms, t.provider, t.confidence,
              t.text, t.corrected_text, t.corrected_at
         from transcripts t
         join calls c on c.id = t.call_id
        where t.call_id = $1 and t.corrected_at is not null
        order by t.offset_ms, t.id`,
      [callId],
    );

    return {
      callId: String(call["id"]),
      carrierCallId: String(call["carrier_call_id"]),
      configVersion: call["config_version"] === null ? null : Number(call["config_version"]),
      listenConfig:
        typeof detail === "object" && detail !== null && !Array.isArray(detail)
          ? (detail as Record<string, unknown>)
          : null,
      entries: rows.map(toCorpusEntry),
    };
  });
