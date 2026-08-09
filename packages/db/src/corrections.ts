import type { TenantId } from "@ansa/shared";

import type { Db } from "./data-source";
import { withTenant, type TenantScope } from "./tenant-scope";

/**
 * The R9.2 review loop, as two queries.
 *
 * `transcripts.corrected_text` and `corrected_at` have existed since schema v1 and
 * nothing has ever written them. They are the mechanism the whole quality story rests on:
 * production audio has no ground truth until a human supplies it (R9.2.3), and a
 * correction is what turns one caller's mishearing into a keyterm, a normalizer test case
 * and a regression test for every tenant (R9.2.4, R9.2.5).
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
 * always true — and a cross-tenant correction RLS had correctly refused reported success.
 * `scope.mutate` unwraps that shape, but the select still leads, because it is also what
 * decides whether the transcript is on the call the caller named and what the transcriber
 * originally heard. Both statements run in the same tenant-scoped transaction, so the
 * check and the write cannot disagree.
 *
 * Null when the row is not theirs, not there, or not on that call. The three are one
 * answer on purpose.
 */
export const applyTranscriptCorrection = async (
  scope: TenantScope,
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
 * The same verdict, for a caller that has a tenant id rather than a scope.
 *
 * The internal viewer, which is told which organisation to act for because there is no
 * session there to infer one from. One implementation underneath, so the dashboard and the
 * viewer cannot record a correction two different ways.
 */
export const recordTranscriptCorrection = async (
  dataSource: Db,
  tenantId: TenantId,
  correction: TranscriptCorrection,
): Promise<boolean> =>
  withTenant(
    dataSource,
    tenantId,
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
 * Every corrected transcript for one tenant, newest first — the eval corpus, exported.
 *
 * Deliberately not filtered to the mistakes. R9.1.9 blocks a provider change on
 * number-accuracy regression, and a regression is only measurable against turns the
 * incumbent got right as well as the ones it got wrong.
 */
export const exportCorpus = async (
  dataSource: Db,
  tenantId: TenantId,
  limit = 500,
): Promise<readonly CorpusEntry[]> =>
  withTenant(dataSource, tenantId, async (scope) => {
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
    return rows.map((r) => ({
      transcriptId: String(r["id"]),
      callId: String(r["call_id"]),
      carrierCallId: String(r["carrier_call_id"]),
      offsetMs: Number(r["offset_ms"]),
      provider: String(r["provider"]),
      confidence: r["confidence"] === null ? null : Number(r["confidence"]),
      heard: String(r["text"]),
      corrected: String(r["corrected_text"]),
      correctedAt: r["corrected_at"] as Date,
    }));
  });
