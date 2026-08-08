import type { TenantId } from "@ansa/shared";

import type { Db } from "./data-source";
import { withTenant } from "./tenant-scope";

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
}

/**
 * Records one reviewer's verdict on one transcript.
 *
 * Scoped like every other write: the `where` clause names the row, RLS decides whether
 * this tenant may touch it. Returns false when the row is not theirs, which is
 * indistinguishable from "no such row" on purpose.
 */
export const recordTranscriptCorrection = async (
  dataSource: Db,
  tenantId: TenantId,
  correction: TranscriptCorrection,
): Promise<boolean> =>
  withTenant(dataSource, tenantId, async (scope) => {
    // Two statements rather than `update … returning`, and not for taste: TypeORM's
    // Postgres driver special-cases UPDATE and DELETE and hands back
    // `[rows, affectedCount]` instead of the rows. `rows.length > 0` on that is always
    // true, so a cross-tenant correction RLS had correctly refused reported success.
    // Both statements run inside the same tenant-scoped transaction, so the check and
    // the write cannot disagree.
    const existing = await scope.query<{ id: string }>(
      "select id from transcripts where id = $1",
      [correction.transcriptId],
    );
    if (existing.length === 0) return false;

    await scope.query(
      "update transcripts set corrected_text = $2, corrected_at = now() where id = $1",
      [correction.transcriptId, correction.correctedText],
    );
    return true;
  });

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
