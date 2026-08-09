import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createDataSource, type Db } from "@ansa/db";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiModule } from "../api.module";
import { hashPassword } from "../auth/password";

/**
 * The call history endpoints, against a real database over real HTTP.
 *
 * Not unit tests with a fake scope, for the reason `isolation.test.ts` gives: a fake agrees
 * with whatever the code does, and the two properties worth proving here are both about
 * things outside the handler. That a correction is refused across a tenant boundary is a
 * fact about RLS. That submitting an unchanged transcript still counts as reviewed is a
 * fact about what `corrected_at` ends up holding and what the metric then divides by.
 */

/** The app takes configuration from the real environment; only tests read the file. */
const loadEnv = (): void => {
  try {
    for (const line of readFileSync(resolve(process.cwd(), "../../.env"), "utf8").split("\n")) {
      const trimmed = line.trim();
      const eq = trimmed.indexOf("=");
      if (trimmed === "" || trimmed.startsWith("#") || eq === -1) continue;
      const key = trimmed.slice(0, eq);
      process.env[key] ??= trimmed.slice(eq + 1);
    }
  } catch {
    // CI supplies them directly.
  }
};

loadEnv();

const ownerUrl = process.env["MIGRATION_DIRECT_URL"];
const appUrl = process.env["DATABASE_URL"];

interface Person {
  readonly email: string;
  readonly password: string;
  readonly userId: string;
  token: string;
}

interface Organisation {
  readonly tenantId: string;
  readonly owner: Person;
  readonly reviewer: Person;
  /** The call everything below is about: two turns, one barged into, three events. */
  readonly callId: string;
  readonly otherCallId: string;
  transcriptId: string;
  otherTranscriptId: string;
}

let owner: Db;
let app: INestApplication;
let baseUrl: string;
const tenants: string[] = [];
const users: string[] = [];

const person = async (label: string): Promise<Person> => {
  const userId = randomUUID();
  const email = `${label}-${userId}@invalid.test`;
  const password = `${randomUUID()}-${randomUUID()}`;
  await owner.query(
    "insert into users (id, email, password_hash, display_name) values ($1, $2, $3, $4)",
    [userId, email, await hashPassword(password), `Person ${label}`],
  );
  users.push(userId);
  return { userId, email, password, token: "" };
};

/**
 * One organisation with a call worth reading back.
 *
 * Seeded as the database owner rather than through the API, because none of this is
 * writable through the API and should not be: `calls`, `turns`, `call_events` and
 * `transcripts` are the media gateway's, and the dashboard's only write is a verdict.
 */
const seed = async (label: string): Promise<Organisation> => {
  const tenantId = randomUUID();
  const callId = randomUUID();
  const otherCallId = randomUUID();

  await owner.query("insert into tenants (id, name) values ($1, $2)", [tenantId, `Org ${label}`]);
  tenants.push(tenantId);

  const orgOwner = await person(`${label}-owner`);
  const reviewer = await person(`${label}-member`);
  await owner.query("insert into memberships (tenant_id, user_id, role) values ($1, $2, 'owner')", [
    tenantId,
    orgOwner.userId,
  ]);
  await owner.query(
    "insert into memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantId, reviewer.userId],
  );

  await owner.query(
    `insert into calls
       (id, tenant_id, carrier_call_id, direction, dialled, caller, answered_at, ended_at,
        end_reason, duration_seconds, config_version, created_at)
     values ($1, $2, $3, 'inbound', $4, $5, now(), now(), 'caller hung up', 61, 7,
             now() - interval '1 hour')`,
    [callId, tenantId, `probe-${callId}`, `+2341000000${label.length}`, "+2348000000001"],
  );
  await owner.query(
    `insert into calls
       (id, tenant_id, carrier_call_id, direction, dialled, caller, answered_at, ended_at,
        end_reason, duration_seconds, created_at)
     values ($1, $2, $3, 'inbound', $4, $5, now(), now(), 'escalated', 12, now() - interval '9 days')`,
    [otherCallId, tenantId, `probe-${otherCallId}`, `+2341000000${label.length}`, "+2348000000002"],
  );

  await owner.query(
    `insert into turns (tenant_id, call_id, seq, speaker, started_offset_ms, ended_offset_ms,
                        barged_in_at_ms)
     values ($1, $2, 1, 'caller', 100, 900, null),
            ($1, $2, 2, 'agent', 1000, 4000, 2500)`,
    [tenantId, callId],
  );

  await owner.query(
    `insert into call_events (tenant_id, call_id, kind, offset_ms, detail)
     values ($1, $2, 'caller said', 900, '{"text":"my policy number is AB1234"}'::jsonb),
            ($1, $2, 'latency', 1000, '{"stage":"turn_to_audio","ms":740}'::jsonb),
            ($1, $2, 'barge-in', 2500, '{"reason":"caller interrupted","seq":2}'::jsonb),
            ($1, $2, 'call configuration', null, '{"listenProvider":"openai"}'::jsonb)`,
    [tenantId, callId],
  );

  // The second call is the one the review scan should rank first: the agent invented words
  // and then gave up. Written as events rather than as an `end_reason` because that is what
  // the pipeline writes and what the scan reads.
  await owner.query(
    `insert into call_events (tenant_id, call_id, kind, offset_ms, detail)
     values ($1, $2, 'hallucination discarded', 400, '{"text":"thank you","speechMs":0}'::jsonb),
            ($1, $2, 'escalated to a human', 800, '{"text":"let me get a colleague"}'::jsonb)`,
    [tenantId, otherCallId],
  );

  const first = await owner.query<{ id: string }[]>(
    `insert into transcripts (tenant_id, call_id, kind, text, confidence, offset_ms, provider)
     values ($1, $2, 'final', 'my policy number is AB1234', 0.62, 900, 'openai')
     returning id`,
    [tenantId, callId],
  );
  const second = await owner.query<{ id: string }[]>(
    `insert into transcripts (tenant_id, call_id, kind, text, confidence, offset_ms, provider)
     values ($1, $2, 'final', 'yes that is right', 0.91, 300, 'openai')
     returning id`,
    [tenantId, otherCallId],
  );

  return {
    tenantId,
    owner: orgOwner,
    reviewer,
    callId,
    otherCallId,
    transcriptId: String(first[0]?.id),
    otherTranscriptId: String(second[0]?.id),
  };
};

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const request = async (
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Reply> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
};

const signIn = async (organisation: Organisation, who: Person): Promise<string> => {
  const reply = await request("POST", "/api/v1/auth/sessions", {
    body: { email: who.email, password: who.password, organisationId: organisation.tenantId },
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return String(reply.body["token"]);
};

const items = (reply: Reply): Record<string, unknown>[] =>
  reply.body["items"] as Record<string, unknown>[];

let alpha: Organisation;
let beta: Organisation;

describe.skipIf(ownerUrl === undefined || appUrl === undefined)("the call history endpoints", () => {
  beforeAll(async () => {
    owner = await createDataSource({ url: ownerUrl ?? "", poolSize: 2 }).initialize();
    alpha = await seed("alpha");
    beta = await seed("beta");

    app = await NestFactory.create(ApiModule, { logger: false });
    await app.listen(0);
    baseUrl = await app.getUrl();

    alpha.owner.token = await signIn(alpha, alpha.owner);
    alpha.reviewer.token = await signIn(alpha, alpha.reviewer);
    beta.owner.token = await signIn(beta, beta.owner);
  });

  afterAll(async () => {
    await app?.close();
    for (const tenantId of tenants) await owner.query("delete from tenants where id = $1", [tenantId]);
    for (const userId of users) await owner.query("delete from users where id = $1", [userId]);
    await owner?.destroy();
  });

  describe("listing", () => {
    it("narrows by how the call ended, and by the number that dialled in", async () => {
      const escalated = await request("GET", "/api/v1/calls?endReason=escalated", {
        token: alpha.owner.token,
      });
      expect(escalated.status).toBe(200);
      expect(items(escalated).map((c) => c["id"])).toEqual([alpha.otherCallId]);

      const byCaller = await request("GET", "/api/v1/calls?caller=%2B2348000000001", {
        token: alpha.owner.token,
      });
      expect(byCaller.status).toBe(200);
      expect(items(byCaller).map((c) => c["id"])).toEqual([alpha.callId]);
    });

    /** `from` is inclusive and `to` exclusive, so two adjacent ranges cannot both match. */
    it("narrows by a time range without double-counting the boundary", async () => {
      const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const recent = await request(`GET`, `/api/v1/calls?from=${encodeURIComponent(since)}`, {
        token: alpha.owner.token,
      });
      expect(items(recent).map((c) => c["id"])).toEqual([alpha.callId]);

      const older = await request("GET", `/api/v1/calls?to=${encodeURIComponent(since)}`, {
        token: alpha.owner.token,
      });
      expect(items(older).map((c) => c["id"])).toEqual([alpha.otherCallId]);
    });

    it("refuses a filter it does not recognise rather than ignoring it", async () => {
      const reply = await request("GET", "/api/v1/calls?ednReason=escalated", {
        token: alpha.owner.token,
      });
      expect(reply.status).toBe(422);
      expect((reply.body["errors"] as { path: string }[])[0]?.path).toBe("query.ednReason");
    });

    it("still shows an organisation only its own calls, filtered or not", async () => {
      const reply = await request("GET", "/api/v1/calls?endReason=escalated", {
        token: beta.owner.token,
      });
      expect(items(reply).map((c) => c["id"])).toEqual([beta.otherCallId]);
    });
  });

  describe("one call, turn by turn", () => {
    it("returns the turns, the transcripts and the configuration that served it", async () => {
      const reply = await request("GET", `/api/v1/calls/${alpha.callId}`, {
        token: alpha.owner.token,
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(reply.body["configVersion"]).toBe(7);

      const turns = reply.body["turns"] as Record<string, unknown>[];
      expect(turns.map((t) => t["seq"])).toEqual([1, 2]);
      // The agent's turn was cut off. The unplayed remainder never reached the caller, and
      // a reviewer reading the transcript has to be able to see where.
      expect(turns[1]?.["bargedInAtMs"]).toBe(2500);

      const transcripts = reply.body["transcripts"] as Record<string, unknown>[];
      expect(transcripts[0]?.["provider"]).toBe("openai");
      expect(transcripts[0]?.["confidence"]).toBe("0.620");
      expect(transcripts[0]?.["correctedAt"]).toBeNull();
    });

    it("puts the events on one timeline in offset order", async () => {
      const reply = await request("GET", `/api/v1/calls/${alpha.callId}`, {
        token: alpha.owner.token,
      });
      const events = reply.body["events"] as Record<string, unknown>[];
      // Offsets ascending, and the one recorded off the media clock last rather than
      // pretending to a position it never had.
      expect(events.map((e) => e["kind"])).toEqual([
        "caller said",
        "latency",
        "barge-in",
        "call configuration",
      ]);
      expect((events[1]?.["detail"] as Record<string, unknown>)["ms"]).toBe(740);
      expect((events[1]?.["detail"] as Record<string, unknown>)["stage"]).toBe("turn_to_audio");
    });

    /**
     * The allowlist, one level deeper than the response schema.
     *
     * `caller said` carries the sentence in its detail column. The timeline publishes the
     * event, not the sentence — what the caller said belongs to `transcripts`, which is
     * the field a reviewer corrects.
     */
    it("does not publish the caller's words through an event's detail", async () => {
      const reply = await request("GET", `/api/v1/calls/${alpha.callId}`, {
        token: alpha.owner.token,
      });
      const events = reply.body["events"] as Record<string, unknown>[];
      expect(JSON.stringify(events)).not.toContain("AB1234");
      expect(Object.keys(events[0]?.["detail"] as object)).not.toContain("text");
    });

    it("answers 404 for another organisation's call, not 403", async () => {
      const reply = await request("GET", `/api/v1/calls/${alpha.callId}`, {
        token: beta.owner.token,
      });
      expect(reply.status).toBe(404);
      expect(reply.body["type"]).toBe("urn:ansa:problem:not-found");
    });
  });

  describe("recording a verdict", () => {
    it("counts an unchanged transcript as reviewed and correct", async () => {
      const before = await request("GET", "/api/v1/calls/metrics", { token: alpha.owner.token });
      const reviewedBefore = Number(before.body["reviewed"]);

      const reply = await request(
        "POST",
        `/api/v1/calls/${alpha.otherCallId}/transcripts/${alpha.otherTranscriptId}/corrections`,
        { token: alpha.owner.token, body: { correctedText: "yes that is right" } },
      );
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      // The whole point. "Reviewed and right" is a verdict, not a no-op, and without it
      // there is no denominator to divide the corrections by.
      expect(reply.body["changed"]).toBe(false);
      expect(reply.body["correctedAt"]).not.toBeNull();
      expect(reply.body["text"]).toBe("yes that is right");

      const after = await request("GET", "/api/v1/calls/metrics", { token: alpha.owner.token });
      expect(Number(after.body["reviewed"])).toBe(reviewedBefore + 1);
      expect(after.body["correctionRate"]).not.toBeNull();
    });

    it("records what the reviewer heard when the transcriber was wrong", async () => {
      const reply = await request(
        "POST",
        `/api/v1/calls/${alpha.callId}/transcripts/${alpha.transcriptId}/corrections`,
        { token: alpha.owner.token, body: { correctedText: "my policy number is AB1243" } },
      );
      expect(reply.status).toBe(200);
      expect(reply.body["changed"]).toBe(true);
      expect(reply.body["text"]).toBe("my policy number is AB1234");

      const detail = await request("GET", `/api/v1/calls/${alpha.callId}`, {
        token: alpha.owner.token,
      });
      const transcripts = detail.body["transcripts"] as Record<string, unknown>[];
      expect(transcripts[0]?.["correctedText"]).toBe("my policy number is AB1243");
      expect(transcripts[0]?.["correctedAt"]).not.toBeNull();
    });

    /** The verdict is what makes the review queue a queue: it has to change the filter. */
    it("moves the call out of the unreviewed list", async () => {
      const backlog = await request("GET", "/api/v1/calls?reviewed=false", {
        token: alpha.owner.token,
      });
      expect(items(backlog).map((c) => c["id"])).not.toContain(alpha.callId);

      const done = await request("GET", "/api/v1/calls?reviewed=true", {
        token: alpha.owner.token,
      });
      expect(items(done).map((c) => c["id"])).toContain(alpha.callId);
    });

    it("refuses a transcript that belongs to a different call", async () => {
      const reply = await request(
        "POST",
        `/api/v1/calls/${alpha.otherCallId}/transcripts/${alpha.transcriptId}/corrections`,
        { token: alpha.owner.token, body: { correctedText: "filed against the wrong turn" } },
      );
      expect(reply.status).toBe(404);
    });

    /**
     * The one that matters most. A transcript is where a caller reads their policy number
     * aloud; a reviewer for one organisation editing another's is the same breach as
     * reading it, and it has to fail without saying which of the two reasons it failed for.
     */
    it("refuses a correction across the tenant boundary, and says nothing about why", async () => {
      const reply = await request(
        "POST",
        `/api/v1/calls/${alpha.callId}/transcripts/${alpha.transcriptId}/corrections`,
        { token: beta.owner.token, body: { correctedText: "something else entirely" } },
      );
      expect(reply.status).toBe(404);

      const untouched = await request("GET", `/api/v1/calls/${alpha.callId}`, {
        token: alpha.owner.token,
      });
      const transcripts = untouched.body["transcripts"] as Record<string, unknown>[];
      expect(transcripts[0]?.["correctedText"]).toBe("my policy number is AB1243");
    });

    it("lets a member read the call but not rule on it", async () => {
      expect(
        (await request("GET", `/api/v1/calls/${alpha.callId}`, { token: alpha.reviewer.token }))
          .status,
      ).toBe(200);

      const refused = await request(
        "POST",
        `/api/v1/calls/${alpha.callId}/transcripts/${alpha.transcriptId}/corrections`,
        { token: alpha.reviewer.token, body: { correctedText: "not mine to say" } },
      );
      expect(refused.status).toBe(403);
      expect(refused.body["type"]).toBe("urn:ansa:problem:forbidden");
    });

    it("rejects a transcript id that is not one, rather than failing in the driver", async () => {
      const reply = await request(
        "POST",
        `/api/v1/calls/${alpha.callId}/transcripts/not-a-number/corrections`,
        { token: alpha.owner.token, body: { correctedText: "x" } },
      );
      expect(reply.status).toBe(422);
    });
  });

  describe("metrics", () => {
    it("is read as a page of its own and not as a call id", async () => {
      const reply = await request("GET", "/api/v1/calls/metrics", { token: alpha.owner.token });
      expect(reply.status).toBe(200);
      expect(reply.body).toHaveProperty("bargeInRate");
      expect(reply.body).toHaveProperty("transferRate");
      expect(reply.body).toHaveProperty("abandonmentRate");
    });

    /**
     * The same numbers the internal viewer shows, because they come from the same two
     * functions. A second implementation would be a second set of numbers with one name.
     */
    it("scores this organisation's own calls and nobody else's", async () => {
      const mine = await request("GET", "/api/v1/calls/metrics", { token: alpha.owner.token });
      expect(Number(mine.body["calls"])).toBe(2);
      expect(Number(mine.body["reviewed"])).toBe(2);
      // One of the two reviewed transcripts was changed.
      expect(mine.body["sttExactMatch"]).toBe("0.5000");
      // A latency sample of 740ms, and one barge-in over one agent turn.
      expect((mine.body["responseLatencyMs"] as Record<string, unknown>)["p50"]).toBe(740);
      expect(mine.body["bargeInRate"]).toBe("1.0000");

      const theirs = await request("GET", "/api/v1/calls/metrics", { token: beta.owner.token });
      expect(Number(theirs.body["reviewed"])).toBe(0);
      // Nothing reviewed is not the same reading as nothing wrong, so it is null.
      expect(theirs.body["sttExactMatch"]).toBeNull();
    });
  });

  /**
   * The review queue (R9.2.1, R9.2.2), over HTTP against the real event log.
   *
   * Worth doing here rather than only as a unit test for the reason `isolation.test.ts`
   * gives: the two properties that matter are outside the scoring function. That the scan
   * sees the events at all depends on `readCallRecords` selecting their kinds — it did not,
   * for two slices — and that one organisation's queue holds none of another's is a fact
   * about RLS.
   */
  describe("the review queue", () => {
    const calls = (reply: Reply): Record<string, unknown>[] =>
      reply.body["calls"] as Record<string, unknown>[];

    it("puts the worst call first and says why it is there", async () => {
      const reply = await request("GET", "/api/v1/calls/review-queue", {
        token: alpha.owner.token,
      });
      expect(reply.status).toBe(200);

      const first = calls(reply)[0];
      expect(first?.["id"]).toBe(alpha.otherCallId);
      const signals = (first?.["signals"] as Record<string, unknown>[]).map((s) => s["kind"]);
      expect(signals).toContain("hallucination");
      expect(signals).toContain("escalated");
    });

    it("reports what it scanned, so the flagged count has a denominator", async () => {
      const reply = await request("GET", "/api/v1/calls/review-queue", {
        token: alpha.owner.token,
      });
      expect(Number(reply.body["scanned"])).toBe(2);
      expect(Number(reply.body["flagged"])).toBe(calls(reply).length);
    });

    it("narrows to the calls worth a reviewer's attention", async () => {
      const severe = await request("GET", "/api/v1/calls/review-queue?minSeverity=10", {
        token: alpha.owner.token,
      });
      expect(calls(severe).map((c) => c["id"])).toEqual([alpha.otherCallId]);
    });

    it("is read as a page of its own and not as a call id", async () => {
      const reply = await request("GET", "/api/v1/calls/review-queue", {
        token: alpha.owner.token,
      });
      expect(reply.status).toBe(200);
    });

    it("holds none of another organisation's calls", async () => {
      const theirs = await request("GET", "/api/v1/calls/review-queue", {
        token: beta.owner.token,
      });
      const ids = calls(theirs).map((c) => c["id"]);
      expect(ids).not.toContain(alpha.callId);
      expect(ids).not.toContain(alpha.otherCallId);
    });
  });

  /**
   * Attribution (R9.2.6). The seed answers one call under configuration version 7 and one
   * under none, which is exactly the shape a rollout produces.
   */
  describe("trends by configuration version", () => {
    it("splits the window by the version that served each call", async () => {
      const reply = await request("GET", "/api/v1/calls/trends", { token: alpha.owner.token });
      expect(reply.status).toBe(200);

      const versions = reply.body["versions"] as Record<string, unknown>[];
      expect(versions.map((v) => v["configVersion"])).toEqual([7, null]);
      expect(Number(versions[0]?.["calls"])).toBe(1);
    });

    it("carries the flagged rate for each version, not just its metrics", async () => {
      const reply = await request("GET", "/api/v1/calls/trends", { token: alpha.owner.token });
      const versions = reply.body["versions"] as Record<string, unknown>[];

      // The unversioned row is the call the scan flags hardest, so its rate is 1.
      expect(versions[1]?.["flaggedRate"]).toBe("1.0000");
    });
  });
});
