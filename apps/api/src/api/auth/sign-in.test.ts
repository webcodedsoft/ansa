import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createDataSource, type Db } from "@ansa/db";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiModule } from "../api.module";
import { hashPassword } from "./password";

/**
 * Signing in with a password shorter than the minimum for a *new* one.
 *
 * The API refused it with a 422 reading "must be at least 12 characters", because sign-in
 * shared its schema with sign-up. Three separate problems, and the first is the one somebody
 * actually meets:
 *
 * - **It locks people out.** A password set before the rule existed, or by any path that ever
 *   differed, can never be offered again. The message reads like a typo hint rather than "this
 *   account is now unreachable".
 * - **It is an oracle.** `POST /auth/organisations` promises to answer an empty list for a
 *   wrong password and for an address with no account, "and takes the same time to do it". A
 *   422 answers differently, and instantly.
 * - **It skips the constant cost.** Sign-in hashes before it decides, deliberately. A length
 *   check in front of that returns without hashing and puts the timing difference back.
 *
 * So the fixture's password is deliberately eight characters. A test written with a long one
 * passes against the broken version and proves nothing.
 */

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

/** Eight characters. The whole point — see the header. */
const SHORT_PASSWORD = "short-pw";

/* Its own, and not shared with anything. This file inserts the organisation with a bare
   `insert`, so a second claimant is not a tidiness problem — it is a duplicate key. `c8c8…`
   was also held by `packages/db/src/call-content-retention.test.ts`, and since Turborepo runs
   the two suites against one database at the same time, both files passed alone and the full
   run failed. See `packages/db/src/test-organization-ids.test.ts`. */
const ORGANIZATION = "cacacaca-caca-4aca-8aca-cacacacacaca";
const USER = randomUUID();
const EMAIL = `short-${USER}@invalid.test`;

let owner: Db;
let app: INestApplication;
let baseUrl: string;

const post = async (path: string, body: unknown): Promise<{ status: number; body: string }> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
};

describe.skipIf(ownerUrl === undefined || appUrl === undefined)("signing in", () => {
  beforeAll(async () => {
    owner = await createDataSource({ url: ownerUrl ?? "", poolSize: 2 }).initialize();
    await owner.query("insert into organizations (id, name) values ($1, $2)", [
      ORGANIZATION,
      "Short Password",
    ]);
    await owner.query(
      "insert into users (id, email, password_hash, display_name) values ($1, $2, $3, $4)",
      [USER, EMAIL, await hashPassword(SHORT_PASSWORD), "Short"],
    );
    await owner.query(
      "insert into memberships (organization_id, user_id, role) values ($1, $2, 'owner')",
      [ORGANIZATION, USER],
    );

    app = await NestFactory.create(ApiModule, { logger: false });
    await app.listen(0);
    baseUrl = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await owner?.query("delete from organizations where id = $1", [ORGANIZATION]);
    await owner?.query("delete from users where id = $1", [USER]);
    await owner?.destroy();
  });

  it("accepts a password shorter than the minimum for a new one", async () => {
    /* The lockout, directly. This answered 422 before, so an account whose password predates
       the rule could never be signed into again. */
    const reply = await post("/api/v1/auth/sessions", {
      email: EMAIL,
      password: SHORT_PASSWORD,
      organisationId: ORGANIZATION,
    });
    expect(reply.status, reply.body).toBe(201);
  });

  it("answers a wrong short password the same way as a wrong long one", async () => {
    /* The oracle. Both are 401 — "those credentials did not sign in" — and neither is a 422
       about length, so nothing in the response says whether the guess was the right shape. */
    const short = await post("/api/v1/auth/sessions", {
      email: EMAIL,
      password: "wrong-pw",
      organisationId: ORGANIZATION,
    });
    const long = await post("/api/v1/auth/sessions", {
      email: EMAIL,
      password: "a-long-wrong-password",
      organisationId: ORGANIZATION,
    });

    expect(short.status).toBe(401);
    expect(long.status).toBe(401);
    expect(short.body).not.toContain("12");
  });

  it("lists organisations for a short password rather than refusing the request", async () => {
    /* That endpoint promises an empty list for a wrong password and the same timing for an
       address with no account. A 422 broke the promise for every short one. */
    const reply = await post("/api/v1/auth/organisations", {
      email: EMAIL,
      password: SHORT_PASSWORD,
    });
    expect(reply.status, reply.body).toBe(200);
    expect(reply.body).toContain("Short Password");
  });

  it("still refuses a short password when one is being chosen", async () => {
    /* The other half. The minimum is a real rule and belongs on sign-up, where somebody is
       picking a password rather than proving they know one. */
    const reply = await post("/api/v1/auth/sign-ups", {
      organisationName: "Too Short",
      displayName: "Someone",
      email: `new-${randomUUID()}@invalid.test`,
      password: SHORT_PASSWORD,
    });
    expect(reply.status, reply.body).toBe(422);
  });

  it("still refuses a password long enough to be a denial of service", async () => {
    /* The maximum is the genuinely defensive half: scrypt will chew through a megabyte of
       "password" if somebody posts one. */
    const reply = await post("/api/v1/auth/sessions", {
      email: EMAIL,
      password: "x".repeat(4096),
      organisationId: ORGANIZATION,
    });
    expect(reply.status).toBe(422);
  });
});
