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
 * Adding people to the list, by hand and in bulk, over real HTTP against a real Postgres.
 *
 * The two things worth proving through the pipeline rather than at the accessor: that a
 * single manual add normalises a Nigerian national number the way the import does — one rule
 * for both write paths, and the form's own promise — while a string that is no number at all
 * is refused; and that an import normalises Nigerian national numbers, folds a duplicate, and
 * skips a cell that is not a number rather than failing the whole batch.
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

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const post = async (path: string, body: unknown, withToken = true): Promise<Reply> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withToken ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
};

describe.skipIf(ownerUrl === undefined || appUrl === undefined)(
  "adding and importing contacts",
  () => {
    beforeAll(async () => {
      owner = await createDataSource({ url: ownerUrl ?? "", poolSize: 2 }).initialize();
      const email = `contacts-add-${organizationId}@invalid.test`;
      const password = `${randomUUID()}-${randomUUID()}`;

      await owner.query("insert into organizations (id, name) values ($1, $2)", [
        organizationId,
        "Contact add endpoints",
      ]);
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
      await owner?.query("delete from contact_values where organization_id = $1", [organizationId]);
      await owner?.query("delete from contacts where organization_id = $1", [organizationId]);
      await owner?.query("delete from contact_imports where organization_id = $1", [organizationId]);
      await owner?.query("delete from organizations where id = $1", [organizationId]);
      await owner?.query("delete from users where id = $1", [userId]);
      await owner?.destroy();
    });

    it("adds one person, and returns the same record on a repeat number", async () => {
      const first = await post("/api/v1/contacts", {
        phone: "+2348040000001",
        displayName: "Ada",
      });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body).toMatchObject({ phone: "+2348040000001", created: true });

      const again = await post("/api/v1/contacts", { phone: "+2348040000001" });
      expect(again.status).toBe(201);
      expect(again.body).toMatchObject({ id: first.body["id"], created: false });
    });

    it("normalises a Nigerian national number on a manual add, and refuses a non-number", async () => {
      // The form promises "however you have it, tidied to +234"; create keeps that promise,
      // the same way the import route does, rather than demanding the international form.
      const local = await post("/api/v1/contacts", { phone: "08060000009" });
      expect(local.status, JSON.stringify(local.body)).toBe(201);
      expect(local.body).toMatchObject({ phone: "+2348060000009", created: true });

      // A string that is no number at all is still a 422 on the field.
      const bad = await post("/api/v1/contacts", { phone: "not a number" });
      expect(bad.status).toBe(422);
    });

    it("imports a batch, normalising, folding a duplicate, and skipping a bad row", async () => {
      const reply = await post("/api/v1/contacts/imports", {
        sourceLabel: "March list",
        rows: [
          { phone: "08050000001" }, // Nigerian national -> +234
          { phone: "+2348050000002", displayName: "Bola" },
          { phone: "0805 000 0001" }, // same as the first once normalised
          { phone: "not a number" }, // skipped
          { phone: "+2348040000001" }, // already known from the manual add above
        ],
      });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
      expect(typeof reply.body["importId"]).toBe("string");
      expect(reply.body["received"]).toBe(5);
      expect(reply.body["skipped"]).toBe(1);
      // Two new distinct numbers (the duplicate folds into one), and one already known.
      expect(reply.body["added"]).toBe(2);
      expect(reply.body["alreadyKnown"]).toBe(1);
    });

    it("refuses the import route without a session", async () => {
      const reply = await post(
        "/api/v1/contacts/imports",
        { sourceLabel: "x", rows: [] },
        false,
      );
      expect(reply.status).toBe(401);
    });
  },
);
