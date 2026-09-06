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
 * The campaign endpoints over real HTTP, against a real Postgres, with a real session.
 *
 * The point of driving them through the pipeline rather than calling the accessors is the
 * part a unit test cannot reach: that each response survives being projected through its own
 * schema, that the guard admits `campaigns:*`, and that the two decisions this layer owns —
 * the agent-belongs-to-us check and the status transition table — actually fire.
 */

const loadEnv = (): void => {
  try {
    for (const line of readFileSync(resolve(process.cwd(), "../../.env"), "utf8").split("\n")) {
      const trimmed = line.trim();
      const eq = trimmed.indexOf("=");
      if (trimmed === "" || trimmed.startsWith("#") || eq === -1) continue;
      process.env[trimmed.slice(0, eq)] ??= trimmed.slice(eq + 1);
    }
  } catch {
    // CI supplies them directly.
  }
};

loadEnv();

const ownerUrl = process.env["MIGRATION_DIRECT_URL"];
const appUrl = process.env["DATABASE_URL"];

let owner: Db;
let app: INestApplication;
let baseUrl: string;
let token: string;
const organizationId = randomUUID();
const userId = randomUUID();
const contactIds: string[] = [];

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const call = async (
  method: string,
  path: string,
  body?: unknown,
  withToken = true,
): Promise<Reply> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(withToken ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
};

describe.skipIf(ownerUrl === undefined || appUrl === undefined)("the campaign endpoints", () => {
  beforeAll(async () => {
    owner = await createDataSource({ url: ownerUrl ?? "", poolSize: 2 }).initialize();
    const email = `campaigns-${organizationId}@invalid.test`;
    const password = `${randomUUID()}-${randomUUID()}`;

    await owner.query("insert into organizations (id, name) values ($1, $2)", [
      organizationId,
      "Campaign endpoints",
    ]);
    // The agent's id is seeded equal to the organisation's, so the tests below name the
    // organisation id where they need an agent id — the same trick the numbers test uses.
    await owner.query("insert into agents (id, organization_id, name) values ($1, $1, $2)", [
      organizationId,
      "Campaign agent",
    ]);
    await owner.query(
      "insert into users (id, email, password_hash, display_name) values ($1, $2, $3, $4)",
      [userId, email, await hashPassword(password), "Owner"],
    );
    await owner.query(
      "insert into memberships (organization_id, user_id, role) values ($1, $2, 'owner')",
      [organizationId, userId],
    );

    for (const phone of ["+2348030000001", "+2348030000002"]) {
      const rows = (await owner.query(
        "insert into contacts (organization_id, phone, source) values ($1, $2, 'manual') returning id",
        [organizationId, phone],
      )) as { id: string }[];
      contactIds.push(rows[0]?.id ?? "");
    }

    app = await NestFactory.create(ApiModule, { logger: false });
    await app.listen(0);
    baseUrl = await app.getUrl();

    const signIn = await fetch(`${baseUrl}/api/v1/auth/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, organisationId: organizationId }),
    });
    token = String(((await signIn.json()) as Record<string, unknown>)["token"]);
  });

  afterAll(async () => {
    await app?.close();
    await owner?.query("delete from scheduled_calls where organization_id = $1", [organizationId]);
    await owner?.query("delete from campaigns where organization_id = $1", [organizationId]);
    await owner?.query("delete from contacts where organization_id = $1", [organizationId]);
    await owner?.query("delete from agents where organization_id = $1", [organizationId]);
    await owner?.query("delete from organizations where id = $1", [organizationId]);
    await owner?.query("delete from users where id = $1", [userId]);
    await owner?.destroy();
  });

  let campaignId = "";

  it("creates a campaign as a draft with nobody on it", async () => {
    const reply = await call("POST", "/api/v1/campaigns", {
      name: "Renewals",
      agentId: organizationId,
      callingWindow: { startHour: 9, endHour: 17, weekdays: [1, 2, 3, 4, 5] },
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(reply.body).toMatchObject({ name: "Renewals", status: "draft", total: 0, pending: 0 });
    expect(reply.body["callingWindow"]).toMatchObject({ startHour: 9, endHour: 17 });
    campaignId = String(reply.body["id"]);
  });

  it("refuses an agent this organisation does not own", async () => {
    const reply = await call("POST", "/api/v1/campaigns", { name: "Bad", agentId: randomUUID() });
    expect(reply.status).toBe(422);
    const errors = reply.body["errors"] as { path: string }[];
    expect(errors.some((e) => e.path === "agentId")).toBe(true);
  });

  it("refuses a calling window that does not describe a real span", async () => {
    const reply = await call("POST", "/api/v1/campaigns", {
      name: "Backwards",
      agentId: organizationId,
      callingWindow: { startHour: 18, endHour: 9, weekdays: [1] },
    });
    expect(reply.status).toBe(422);
  });

  it("lists the campaign it created", async () => {
    const reply = await call("GET", "/api/v1/campaigns");
    expect(reply.status).toBe(200);
    const items = reply.body["items"] as Record<string, unknown>[];
    expect(items.some((c) => c["id"] === campaignId)).toBe(true);
  });

  it("refuses an illegal status move and accepts a legal one", async () => {
    const illegal = await call("POST", `/api/v1/campaigns/${campaignId}/status`, {
      status: "running",
    });
    expect(illegal.status, "draft cannot jump to running").toBe(409);

    const legal = await call("POST", `/api/v1/campaigns/${campaignId}/status`, {
      status: "scheduled",
    });
    expect(legal.status).toBe(200);
    expect(legal.body["status"]).toBe("scheduled");

    /* A campaign about to dial has to know why it is ringing, so this one is given a purpose
       before it starts. Without it the move is refused — asserted in its own case below. */
    const briefed = await call("PATCH", `/api/v1/campaigns/${campaignId}/brief`, {
      purpose: "to ask how the viewing went",
    });
    expect(briefed.status, JSON.stringify(briefed.body)).toBe(200);

    const running = await call("POST", `/api/v1/campaigns/${campaignId}/status`, {
      status: "running",
    });
    expect(running.status).toBe(200);
    expect(running.body["status"]).toBe("running");
  });

  it("enqueues this organisation's contacts and ignores a foreign id", async () => {
    const reply = await call("POST", `/api/v1/campaigns/${campaignId}/contacts`, {
      contactIds: [...contactIds, randomUUID()],
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toMatchObject({ requested: 3, enqueued: 2 });

    // Enqueuing the same list again is a no-op, not a second call to the same person.
    const again = await call("POST", `/api/v1/campaigns/${campaignId}/contacts`, {
      contactIds,
    });
    expect(again.body).toMatchObject({ requested: 2, enqueued: 0 });
  });

  it("lists the scheduled calls, pending, with the person beside each", async () => {
    const reply = await call("GET", `/api/v1/campaigns/${campaignId}/calls`);
    expect(reply.status).toBe(200);
    expect(reply.body["total"]).toBe(2);
    const items = reply.body["items"] as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ status: "pending", campaignId });
    expect(typeof items[0]?.["phone"]).toBe("string");
  });

  it("answers 404 for a campaign that is not ours", async () => {
    const reply = await call("GET", `/api/v1/campaigns/${randomUUID()}`);
    expect(reply.status).toBe(404);
  });

  it("refuses every route without a session", async () => {
    for (const [method, path] of [
      ["GET", "/api/v1/campaigns"],
      ["POST", "/api/v1/campaigns"],
      ["GET", `/api/v1/campaigns/${campaignId}`],
    ] as const) {
      const reply = await call(method, path, method === "POST" ? {} : undefined, false);
      expect(reply.status, `${method} ${path}`).toBe(401);
    }
  });
  it("says what a campaign is about, refuses to start one that does not, and freezes it once running", async () => {
    const made = await call("POST", "/api/v1/campaigns", {
      name: "Viewing reminders",
      agentId: organizationId,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const own = String(made.body["id"]);
    expect(made.body["purpose"]).toBeNull();
    expect(made.body["maxAttempts"]).toBe(3);
    expect(made.body["briefEditable"]).toBe(true);

    /* A campaign with nothing to say cannot start. The refusal is here rather than on the
       brief, because a half-written brief should save. */
    const aimless = await call("POST", `/api/v1/campaigns/${own}/status`, {
      status: "scheduled",
    });
    expect(aimless.status).toBe(200);
    const noPurpose = await call("POST", `/api/v1/campaigns/${own}/status`, {
      status: "running",
    });
    expect(noPurpose.status, JSON.stringify(noPurpose.body)).toBe(409);

    const briefed = await call("PATCH", `/api/v1/campaigns/${own}/brief`, {
      purpose: "to confirm your viewing",
      outcomes: ["confirmed", "rescheduled", "declined"],
      voicemail: { mode: "hang_up" },
      maxAttempts: 2,
      retryAfterMinutes: 60,
    });
    expect(briefed.status, JSON.stringify(briefed.body)).toBe(200);
    expect(briefed.body["purpose"]).toBe("to confirm your viewing");
    expect(briefed.body["outcomes"]).toEqual(["confirmed", "rescheduled", "declined"]);

    /* Choosing to leave a message needs nothing else said. The words are not the campaign's
       to write: they are composed by the call from who rang and the number to ring back, and
       never from why we rang, because an answerphone is played out loud in a room. */
    const speak = await call("PATCH", `/api/v1/campaigns/${own}/brief`, {
      voicemail: { mode: "leave_message" },
    });
    expect(speak.status, JSON.stringify(speak.body)).toBe(200);
    expect(speak.body["voicemail"]).toEqual({ mode: "leave_message" });

    /* A half-drawn flow saves, exactly as a half-written brief does and as an agent's draft
       does — `publication.ts` lets a draft hold a broken graph and refuses at publish. A
       campaign has no publish, so Start is where it is caught. */
    const broken = await call("PATCH", `/api/v1/campaigns/${own}/brief`, {
      flow: {
        version: 1,
        nodes: [{ id: "a", kind: "say", x: 0, y: 0 }],
        edges: [{ from: "a", to: "ghost" }],
      },
    });
    expect(broken.status, JSON.stringify(broken.body)).toBe(200);

    const unsound = await call("POST", `/api/v1/campaigns/${own}/status`, { status: "scheduled" });
    expect(unsound.status).toBe(200);
    const refused = await call("POST", `/api/v1/campaigns/${own}/status`, { status: "running" });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);

    // Clearing the flow leaves a campaign that is only its purpose, which is allowed.
    const cleared = await call("PATCH", `/api/v1/campaigns/${own}/brief`, { flow: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);

    // With a purpose and a sound script it starts, and from then on the brief is fixed.
    const started = await call("POST", `/api/v1/campaigns/${own}/status`, {
      status: "running",
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body["briefEditable"]).toBe(false);

    const frozen = await call("PATCH", `/api/v1/campaigns/${own}/brief`, {
      purpose: "something else entirely",
    });
    expect(frozen.status, JSON.stringify(frozen.body)).toBe(409);

    const after = await call("GET", `/api/v1/campaigns/${own}`);
    expect(after.body["purpose"]).toBe("to confirm your viewing");
  });

  /**
   * The four things this page gained, over real HTTP.
   *
   * Each is a route that did not exist, and three of them exist because two fields the API
   * had returned since it was written — `outcome` and `callId` — were never rendered, which
   * is what made "how did it go" unanswerable on a screen holding the answer.
   */
  describe("what a campaign came to, and running one again", () => {
    let fresh = "";

    beforeAll(async () => {
      const created = await call("POST", "/api/v1/campaigns", {
        name: "Breakdown fixture",
        agentId: organizationId,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      fresh = String(created.body["id"]);
    }, 30_000);

    it("scheduling a draft moves it to scheduled, so the time is not stored inertly", async () => {
      /* `start_due_campaigns` only promotes a scheduled campaign. Without the move, a start
         time set on a draft would sit in the column and never fire — saved, and silent. */
      /* A whole second. `timestamptz` here keeps second precision, so a time carrying
         milliseconds comes back trimmed and the round-trip assertion would fail on a
         difference nobody has ever cared about. */
      const at = new Date(Math.floor((Date.now() + 86_400_000) / 1000) * 1000).toISOString();
      const reply = await call("PATCH", `/api/v1/campaigns/${fresh}`, { startsAt: at });

      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(reply.body["startsAt"]).toBe(at);
      expect(reply.body["status"]).toBe("scheduled");
    });

    it("clearing the start time leaves it scheduled, waiting for a person", async () => {
      // Clearing says "I will start it myself", not "put it back in the drawer".
      const reply = await call("PATCH", `/api/v1/campaigns/${fresh}`, { startsAt: null });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(reply.body["startsAt"]).toBeNull();
      expect(reply.body["status"]).toBe("scheduled");
    });

    it("refuses a start time on a campaign that has already started", async () => {
      /* A campaign cannot start without a purpose — the agent would have nothing to say it
         was calling about — so this is what it takes to get one running. */
      const brief = await call("PATCH", `/api/v1/campaigns/${fresh}/brief`, {
        purpose: "to ask how the viewing went",
      });
      expect(brief.status, JSON.stringify(brief.body)).toBe(200);

      const running = await call("POST", `/api/v1/campaigns/${fresh}/status`, { status: "running" });
      expect(running.status, JSON.stringify(running.body)).toBe(200);

      const reply = await call("PATCH", `/api/v1/campaigns/${fresh}`, {
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(422);

      // The name is still editable on a running campaign; only the start time is refused.
      const renamed = await call("PATCH", `/api/v1/campaigns/${fresh}`, { name: "Renamed while running" });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    });

    it("breaks a campaign down by status and by verdict", async () => {
      const reply = await call("GET", `/api/v1/campaigns/${fresh}/breakdown`);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      /* Nobody is on this one, so both are empty objects rather than a shape full of zeroes.
         Absent and zero are different facts and the panel draws them differently. */
      expect(reply.body["byStatus"]).toEqual({});
      expect(reply.body["byOutcome"]).toEqual({});
    });

    it("filters the calls by status, and narrows the total with them", async () => {
      const all = await call("GET", `/api/v1/campaigns/${campaignId}/calls`);
      expect(all.status, JSON.stringify(all.body)).toBe(200);
      const everyone = Number(all.body["total"]);
      expect(everyone).toBeGreaterThan(0);

      /* Read from the rows rather than assumed. An earlier test in this file moves the
         campaign around, and pinning a status here would be asserting that history rather
         than the filter. */
      const items = all.body["items"] as Record<string, unknown>[];
      const present = String(items[0]?.["status"]);
      const held = items.filter((one) => String(one["status"]) === present).length;

      const same = await call("GET", `/api/v1/campaigns/${campaignId}/calls?status=${present}`);
      expect(same.status, JSON.stringify(same.body)).toBe(200);
      expect(Number(same.body["total"])).toBe(held);

      /* The total has to move with the filter. Filtering a page rather than the query would
         leave the pager saying "1–20 of 500" above four rows. */
      const absent = present === "failed" ? "busy" : "failed";
      const none = await call("GET", `/api/v1/campaigns/${campaignId}/calls?status=${absent}`);
      expect(none.status, JSON.stringify(none.body)).toBe(200);
      expect(Number(none.body["total"])).toBe(0);
      expect((none.body["items"] as unknown[]).length).toBe(0);
    });

    it("duplicates the words and none of the people", async () => {
      const reply = await call("POST", `/api/v1/campaigns/${campaignId}/duplicate`, {
        name: "Renewals, again",
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      expect(reply.body["id"]).not.toBe(campaignId);
      expect(reply.body["name"]).toBe("Renewals, again");
      // A draft with an empty list. Copying the contacts would silently re-ring everyone.
      expect(reply.body["status"]).toBe("draft");
      expect(reply.body["total"]).toBe(0);
      expect(reply.body["startsAt"]).toBeNull();
      // The window came across, because that is one of the words somebody wrote.
      expect(reply.body["callingWindow"]).toMatchObject({ startHour: 9, endHour: 17 });
    });

    it("answers 404 duplicating a campaign that is not ours", async () => {
      const reply = await call("POST", `/api/v1/campaigns/${randomUUID()}/duplicate`, {
        name: "Not mine",
      });
      expect(reply.status).toBe(404);
    });
  });

});
