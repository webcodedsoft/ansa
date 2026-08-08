import { asTenantId } from "@ansa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadCallRecords } from "./call-records";
import { exportCorpus, recordTranscriptCorrection } from "./corrections";
import { createDataSource, type Db } from "./data-source";
import {
  expiredCallAudio,
  knownCallIds,
  minAudioRetentionDays,
  purgeExpiredAudioSegments,
} from "./retention";
import { withTenant } from "./tenant-scope";
import { loadDotEnv } from "./test-env";

loadDotEnv();

/**
 * The review loop and the retention sweep, against the real schema.
 *
 * Both are new columns and functions rather than new tables, and both are the kind of
 * thing that reads correctly and enforces nothing — `corrected_text` sat in the schema
 * for two slices with no writer, and `audio_retention_days` for longer than that with no
 * reader. A unit test against a fake would have proved neither.
 *
 * Deliberately connects as the application role, not the owner: the retention functions
 * are SECURITY DEFINER and the grant is half the point.
 */

const url = process.env["DATABASE_URL"];
if (url === undefined) {
  throw new Error("DATABASE_URL must be set: this test needs a database");
}

const TENANT = asTenantId("33333333-3333-4333-8333-333333333333");
const OTHER = asTenantId("44444444-4444-4444-8444-444444444444");
const CALL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OLD_CALL = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let db: Db;
let transcriptId: string;

beforeAll(async () => {
  db = await createDataSource({ url, poolSize: 2 }).initialize();

  await withTenant(db, TENANT, async (scope) => {
    await scope.query(
      `insert into tenants (id, name, audio_retention_days) values ($1, 'Review Test', 1)
         on conflict (id) do update set audio_retention_days = 1`,
      [TENANT],
    );
    await scope.query(
      `insert into calls (id, tenant_id, carrier_call_id, dialled, caller, answered_at, ended_at)
       values ($1, $2, 'CA-review', '+10000000003', '+2348000000003', now(), now())
         on conflict do nothing`,
      [CALL, TENANT],
    );
    // Three days old against a one-day policy: its audio should not still exist.
    await scope.query(
      `insert into calls (id, tenant_id, carrier_call_id, dialled, caller, answered_at, ended_at)
       values ($1, $2, 'CA-review-old', '+10000000003', '+2348000000003',
               now() - interval '3 days', now() - interval '3 days')
         on conflict do nothing`,
      [OLD_CALL, TENANT],
    );
    await scope.query(
      `insert into turns (tenant_id, call_id, seq, speaker, started_offset_ms)
       values ($1, $2, 1, 'caller', 100), ($1, $2, 2, 'agent', 200)
         on conflict do nothing`,
      [TENANT, CALL],
    );
    await scope.query(
      `insert into call_events (tenant_id, call_id, kind, offset_ms, detail)
       values ($1, $2, 'latency', 1000, '{"stage":"turn_to_audio","ms":740}'::jsonb),
              ($1, $2, 'barge-in', 2000, '{"reason":"caller interrupted"}'::jsonb)`,
      [TENANT, CALL],
    );
    const rows = await scope.query<{ id: string }>(
      `insert into transcripts (tenant_id, call_id, kind, text, confidence, offset_ms, provider)
       values ($1, $2, 'final', 'My name is Security', 0.4, 1000, 'openai')
       returning id`,
      [TENANT, CALL],
    );
    transcriptId = String(rows[0]?.id);
  });
});

afterAll(async () => {
  for (const tenant of [TENANT, OTHER]) {
    await withTenant(db, tenant, async (scope) => {
      await scope.query("delete from calls where tenant_id = $1", [tenant]);
      await scope.query("delete from tenants where id = $1", [tenant]);
    });
  }
  await db.destroy();
});

describe("recording a human's correction (R9.2.3)", () => {
  it("writes the correction and stamps when it was made", async () => {
    const applied = await recordTranscriptCorrection(db, TENANT, {
      transcriptId,
      correctedText: "My name is Sikiru",
    });
    expect(applied).toBe(true);

    const rows = await withTenant(db, TENANT, async (scope) =>
      scope.query<{ corrected_text: string; corrected_at: Date | null }>(
        "select corrected_text, corrected_at from transcripts where id = $1",
        [transcriptId],
      ),
    );
    expect(rows[0]?.corrected_text).toBe("My name is Sikiru");
    expect(rows[0]?.corrected_at).not.toBeNull();
  });

  it("refuses a correction from another tenant, and says nothing about why", async () => {
    // The most damaging thing this table holds is what a caller read aloud. A reviewer
    // for one tenant editing another's transcript is the same leak as reading it.
    await withTenant(db, OTHER, async (scope) => {
      await scope.query("insert into tenants (id, name) values ($1, 'Other') on conflict do nothing", [
        OTHER,
      ]);
    });

    const applied = await recordTranscriptCorrection(db, OTHER, {
      transcriptId,
      correctedText: "something else entirely",
    });
    expect(applied).toBe(false);

    const rows = await withTenant(db, TENANT, async (scope) =>
      scope.query<{ corrected_text: string }>(
        "select corrected_text from transcripts where id = $1",
        [transcriptId],
      ),
    );
    expect(rows[0]?.corrected_text).toBe("My name is Sikiru");
  });

  it("exports the corrected turn as corpus, mishearing and truth together", async () => {
    const corpus = await exportCorpus(db, TENANT);
    const entry = corpus.find((e) => e.transcriptId === transcriptId);

    expect(entry?.heard).toBe("My name is Security");
    expect(entry?.corrected).toBe("My name is Sikiru");
    expect(entry?.provider).toBe("openai");
    expect(entry?.carrierCallId).toBe("CA-review");
  });

  it("shows another tenant nothing of that corpus", async () => {
    const corpus = await exportCorpus(db, OTHER);
    expect(corpus.map((e) => e.transcriptId)).not.toContain(transcriptId);
  });
});

describe("reading the log back to score it", () => {
  it("returns the events and review verdicts a metric is computed from", async () => {
    const records = await loadCallRecords(db, TENANT, 50);
    const record = records.find((r) => r.callId === CALL);

    expect(record?.callerTurns).toBe(1);
    expect(record?.agentTurns).toBe(1);
    expect(record?.events.map((e) => e.kind)).toContain("barge-in");
    expect(record?.reviewed[0]?.corrected).toBe("My name is Sikiru");
  });
});

describe("enforcing audio_retention_days", () => {
  it("reports a call past its tenant's window, and not one inside it", async () => {
    const expired = await expiredCallAudio(db);
    const ids = expired.map((e) => e.carrierCallId);

    expect(ids).toContain("CA-review-old");
    expect(ids).not.toContain("CA-review");
  });

  it("tells the sweep which recordings belong to a call at all", async () => {
    // The third answer. Without it a 40-day-old recording belonging to a tenant who chose
    // ninety days is indistinguishable from one belonging to nobody.
    const known = await knownCallIds(db, ["CA-review", "CA-does-not-exist"]);
    expect(known.has("CA-review")).toBe(true);
    expect(known.has("CA-does-not-exist")).toBe(false);
  });

  it("reports the strictest policy anyone configured", async () => {
    expect(await minAudioRetentionDays(db)).toBe(1);
  });

  it("deletes audio segments past their own expiry", async () => {
    await withTenant(db, TENANT, async (scope) => {
      await scope.query(
        `insert into audio_segments
           (tenant_id, call_id, source, storage_key, encoding, sample_rate, bytes,
            start_offset_ms, expires_at)
         values ($1, $2, 'caller', 'k', 'mulaw', 8000, 16, 0, now() - interval '1 day')`,
        [TENANT, CALL],
      );
    });

    expect(await purgeExpiredAudioSegments(db)).toBeGreaterThan(0);

    const left = await withTenant(db, TENANT, async (scope) =>
      scope.query<{ n: string }>("select count(*) as n from audio_segments where call_id = $1", [
        CALL,
      ]),
    );
    expect(Number(left[0]?.n ?? 0)).toBe(0);
  });
});
