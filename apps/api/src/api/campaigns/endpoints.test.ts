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
});
