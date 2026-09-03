import { asOrganizationId } from "@ansa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDataSource, type Db } from "./data-source";
import { withOrganization } from "./organization-scope";
import { purgeExpiredCallContent } from "./retention";
import { loadDotEnv } from "./test-env";

loadDotEnv();

/**
 * Deleting what a caller said, against the real schema.
 *
 * Not a pure function like the audio policy, because this policy is a `where` clause. The
 * three things that can go wrong are all in the SQL: deleting a call that was inside its
 * window, keeping one that was outside it, and taking the `calls` row down with the words.
 * The last is the one that would be found late and hurt most — call history and every
 * latency percentile are supposed to outlive the transcript, and a fake would agree with
 * whatever the query did.
 *
 * Connects as the application role. The function is SECURITY DEFINER precisely because a
 * sweep has no organisation, so running it as the owner would prove nothing about whether
 * `ansa_app` can actually invoke it in production.
 */

const url = process.env["DATABASE_URL"];
if (url === undefined) {
  throw new Error("DATABASE_URL must be set: this test needs a database");
}

/**
 * Unique to this file. Vitest runs suites in parallel against one database and
 * `caller-history.test.ts` records what reusing another file's ids costs.
 */
const BRIEF = asOrganizationId("c8c8c8c8-c8c8-4c8c-8c8c-c8c8c8c8c8c8");
const PATIENT = asOrganizationId("c9c9c9c9-c9c9-4c9c-8c9c-c9c9c9c9c9c9");

const OLD_CALL = "ca110000-0000-4000-8000-000000000001";
const FRESH_CALL = "ca110000-0000-4000-8000-000000000002";
const KEPT_CALL = "ca110000-0000-4000-8000-000000000003";

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

let db: Db;

const seedCall = async (organization: typeof BRIEF, id: string, endedAt: string): Promise<void> => {
  await withOrganization(db, organization, async (scope) => {
    await scope.query(
      `insert into calls (id, organization_id, carrier_call_id, dialled, caller, created_at, ended_at)
       values ($1, $2, $3, '+10000000077', '+2348000000077', $4, $4)`,
      [id, organization, `CA-retention-${id.slice(-4)}`, endedAt],
    );
    // The words, in all three places they are kept.
    await scope.query(
      `insert into transcripts (organization_id, call_id, kind, text, confidence, offset_ms, provider)
       values ($1, $2, 'final', 'my NIN is 12345678901', 0.71, 900, 'openai')`,
      [organization, id],
    );
    await scope.query(
      `insert into call_events (organization_id, call_id, kind, offset_ms, detail)
       values ($1, $2, 'caller said', 900, '{"text":"my NIN is 12345678901"}'::jsonb)`,
      [organization, id],
    );
    await scope.query(
      `insert into tool_invocations
         (organization_id, call_id, name, risk_tier, args, result, latency_ms, outcome)
       values ($1, $2, 'policy_lookup', 'read', '{"reference":"AB1234"}'::jsonb,
               '{"status":"active"}'::jsonb, 120, 'ok')`,
      [organization, id],
    );
    // The timings, which must survive the words.
    await scope.query(
      `insert into turns (organization_id, call_id, seq, speaker, started_offset_ms, ended_offset_ms)
       values ($1, $2, 1, 'caller', 100, 900)`,
      [organization, id],
    );
    await scope.query(
      `insert into latencies (organization_id, call_id, stage, ms)
       values ($1, $2, 'turn_to_audio', 740)`,
      [organization, id],
    );
  });
};

const countsFor = async (
  organization: typeof BRIEF,
  callId: string,
): Promise<Record<string, number>> =>
  withOrganization(db, organization, async (scope) => {
    const rows = (await scope.query(
      `select
         (select count(*) from transcripts where call_id = $1)       as transcripts,
         (select count(*) from call_events where call_id = $1)       as events,
         (select count(*) from tool_invocations where call_id = $1)  as invocations,
         (select count(*) from calls where id = $1)                  as calls,
         (select count(*) from turns where call_id = $1)             as turns,
         (select count(*) from latencies where call_id = $1)         as latencies`,
      [callId],
    )) as Record<string, string>[];
    const row = rows[0] ?? {};
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
  });

beforeAll(async () => {
  db = await createDataSource({ url, poolSize: 2 }).initialize();

  for (const [organization, name, days] of [
    [BRIEF, "Retention Brief", 1],
    [PATIENT, "Retention Patient", 365],
  ] as const) {
    await withOrganization(db, organization, async (scope) => {
      await scope.query(
        `insert into organizations (id, name, transcript_retention_days)
         values ($1, $2, $3)
           on conflict (id) do update set transcript_retention_days = excluded.transcript_retention_days`,
        [organization, name, days],
      );
    });
  }

  // Five days old against a one-day window: past it.
  await seedCall(BRIEF, OLD_CALL, daysAgo(5));
  // Ended a few hours ago against the same one-day window: inside it.
  await seedCall(BRIEF, FRESH_CALL, new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
  // Five days old too, but this organisation chose to keep a year.
  await seedCall(PATIENT, KEPT_CALL, daysAgo(5));
});

afterAll(async () => {
  for (const organization of [BRIEF, PATIENT]) {
    await withOrganization(db, organization, async (scope) => {
      await scope.query("delete from calls where organization_id = $1", [organization]);
      await scope.query("delete from organizations where id = $1", [organization]);
    });
  }
  await db?.destroy();
});

describe("purging call content past its retention window", () => {
  it("deletes the words and keeps the call", async () => {
    const before = await countsFor(BRIEF, OLD_CALL);
    expect(before).toMatchObject({ transcripts: 1, events: 1, invocations: 1 });

    const purged = await purgeExpiredCallContent(db);
    expect(purged.transcripts).toBeGreaterThanOrEqual(1);

    const after = await countsFor(BRIEF, OLD_CALL);
    expect(after).toMatchObject({ transcripts: 0, events: 0, invocations: 0 });

    /* The half that makes this affordable. A call whose transcript is gone is still a call:
       the history still lists it, its duration is still right, and every latency percentile
       still counts it. If this ever goes to zero the sweep has become a call-log deleter. */
    expect(after).toMatchObject({ calls: 1, turns: 1, latencies: 1 });
  });

  it("leaves a call that is still inside its own window", async () => {
    await purgeExpiredCallContent(db);
    expect(await countsFor(BRIEF, FRESH_CALL)).toMatchObject({
      transcripts: 1,
      events: 1,
      invocations: 1,
    });
  });

  it("honours a longer window rather than one global default", async () => {
    /* Same age as the deleted call, different organisation, different policy. This is the
       case a sweep written against a constant gets wrong — and gets wrong silently, by
       deleting evidence an organisation is paying to keep. */
    await purgeExpiredCallContent(db);
    expect(await countsFor(PATIENT, KEPT_CALL)).toMatchObject({
      transcripts: 1,
      events: 1,
      invocations: 1,
    });
  });

  it("reports nothing when there is nothing left to take", async () => {
    await purgeExpiredCallContent(db);
    const second = await purgeExpiredCallContent(db);
    expect(second).toEqual({ transcripts: 0, events: 0, invocations: 0 });
  });
});
