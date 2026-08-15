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
 * The three endpoints over real HTTP, against a real Postgres, with a real session.
 *
 * The unit tests above prove the judgement and the probes. This proves the parts a unit
 * test replaces: that the module wires up, that a request-scoped controller can open a
 * organization transaction, and — the one that actually bites — that what each handler returns
 * survives being projected through its own response schema. A field the schema does not
 * admit is a 500 at runtime and passes every test that does not make the request.
 *
 * It runs with the carrier and speech credentials removed from the environment on purpose.
 * A readiness check must never place a call and must never spend somebody's vendor quota to
 * answer a health question, so what this asserts is the degraded path: both lookups report
 * `unchecked`, with a reason, and the endpoint still answers 200.
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

const DIALLED = "+2349990000001";

let owner: Db;
let app: INestApplication;
let baseUrl: string;
let token: string;
const organizationId = randomUUID();
const userId = randomUUID();

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const get = async (path: string): Promise<Reply> => {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
};

describe.skipIf(ownerUrl === undefined || appUrl === undefined)(
  "the numbers and readiness endpoints",
  () => {
    beforeAll(async () => {
      // Blanked rather than left as they are. A test that reached a real carrier would be
      // slow, flaky and billed, and this is the configuration most deployments of the
      // dashboard will actually run in.
      for (const key of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "ELEVENLABS_API_KEY"]) {
        delete process.env[key];
      }
      process.env["PUBLIC_BASE_URL"] = "https://readiness.test";

      owner = await createDataSource({ url: ownerUrl ?? "", poolSize: 2 }).initialize();
      const email = `numbers-${organizationId}@invalid.test`;
      const password = `${randomUUID()}-${randomUUID()}`;

      /* The number is uniquely indexed, so a run interrupted before its cleanup would make
         every later run fail on the insert rather than on anything real. Three tables now
         rather than one: the organisation, the number it holds, and the agent that answers
         it — migration 0018 moved routing to the agent and 0019 made ownership operator-
         written. `owner` is the migration role, which is the only one that may seed a
         number, and that restriction is the point of 0019. */
      await owner.query("delete from agents where dialled_number = $1", [DIALLED]);
      await owner.query("delete from organization_numbers where number = $1", [DIALLED]);
      await owner.query("insert into organizations (id, name) values ($1, $2)", [
        organizationId,
        "Readiness endpoints",
      ]);
      await owner.query(
        "insert into organization_numbers (organization_id, number) values ($1, $2)",
        [organizationId, DIALLED],
      );
      await owner.query(
        "insert into agents (id, organization_id, name, dialled_number) values ($1, $1, $2, $3)",
        [organizationId, "Readiness endpoints", DIALLED],
      );
      await owner.query(
        "insert into users (id, email, password_hash, display_name) values ($1, $2, $3, $4)",
        [userId, email, await hashPassword(password), "Owner"],
      );
      await owner.query(
        "insert into memberships (organization_id, user_id, role) values ($1, $2, 'owner')",
        [organizationId, userId],
      );

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
      await owner?.query("delete from organizations where id = $1", [organizationId]);
      await owner?.query("delete from users where id = $1", [userId]);
      await owner?.destroy();
    });

    it("lists the organisation's own number and the state of its carrier webhook", async () => {
      const reply = await get("/api/v1/numbers");
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);

      const items = reply.body["items"] as Record<string, unknown>[];
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ number: DIALLED, use: "inbound", managedBy: "operator" });

      const webhook = items[0]?.["carrierWebhook"] as Record<string, unknown>;
      expect(webhook["state"]).toBe("unchecked");
      expect(webhook["expected"]).toBe("https://readiness.test/telephony/voice");
      expect(webhook["reason"]).toContain("no carrier account credentials");
    });

    /** The two unavailable things, stated rather than discovered as a failing request. */
    it("says what cannot be done and gives the URL an operator needs", async () => {
      const reply = await get("/api/v1/numbers/provisioning");
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(reply.body).toMatchObject({
        carrier: null,
        claim: { available: false, reason: "no-nigerian-inventory" },
        attach: { selfService: false, reason: "operator-owned-ingress" },
        voiceWebhook: { url: "https://readiness.test/telephony/voice", method: "POST" },
      });
    });

    it("answers readiness for a barely configured organisation without falling over", async () => {
      const reply = await get("/api/v1/readiness");
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);

      const checks = reply.body["checks"] as { id: string; state: string }[];
      const state = (id: string): string | undefined =>
        checks.find((entry) => entry.id === id)?.state;

      expect(state("number.attached")).toBe("ok");
      expect(state("number.carrier_webhook")).toBe("unknown");
      expect(state("number.traffic")).toBe("attention");
      expect(state("greeting")).toBe("attention");
      // No organisation voice, and the credentials to check the platform's were removed.
      expect(state("voice")).toBeDefined();
      expect(state("tools")).toBe("ok");
      expect(state("events")).toBe("ok");
      expect(reply.body["configVersion"]).toBeTypeOf("number");
    });

    /** No session, no answers. The guard is global; this is the proof for these routes. */
    it("refuses all three without a session", async () => {
      for (const path of ["/api/v1/numbers", "/api/v1/numbers/provisioning", "/api/v1/readiness"]) {
        const response = await fetch(`${baseUrl}${path}`);
        expect(response.status, path).toBe(401);
      }
    });
  },
);
