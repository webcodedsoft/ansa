import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createDataSource, type Db } from "@ansa/db";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiModule } from "./api.module";
import { hashPassword } from "./auth/password";

/**
 * The adversarial test for the API layer.
 *
 * `packages/db/src/rls.test.ts` proves Postgres refuses to hand one organization another's rows.
 * This proves the layer above it cannot get round that — that there is no header, no
 * parameter and no forged token that makes a handler act for an organisation the caller
 * does not belong to. Two organisations, two owners, real HTTP against a real database.
 *
 * It exists in this shape rather than as unit tests with a fake gateway because a fake
 * would agree with whatever the code does. The only evidence that counts is trying to
 * cross the boundary and failing, which is the same lesson `0002_rls.sql` records.
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

interface Organisation {
  readonly organizationId: string;
  readonly email: string;
  readonly password: string;
  readonly userId: string;
  readonly callId: string;
  token: string;
}

let owner: Db;
let app: INestApplication;
let baseUrl: string;
const created: Organisation[] = [];

/**
 * Seeds one organisation as the database owner.
 *
 * The owner role, not the app role, and that is not a shortcut: `users` has no INSERT
 * grant for `ansa_app` at all, because the only way a person is supposed to come into
 * existence is by redeeming an invitation. Bootstrapping the first owner is an operator
 * action — `tools/organization/owner.mjs` — and this is that action.
 */
const seed = async (label: string): Promise<Organisation> => {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const callId = randomUUID();
  const email = `${label}-${organizationId}@invalid.test`;
  const password = `${randomUUID()}-${randomUUID()}`;

  await owner.query("insert into organizations (id, name) values ($1, $2)", [organizationId, `Org ${label}`]);
  await owner.query(
    "insert into users (id, email, password_hash, display_name) values ($1, $2, $3, $4)",
    [userId, email, await hashPassword(password), `Owner ${label}`],
  );
  await owner.query("insert into memberships (organization_id, user_id, role) values ($1, $2, 'owner')", [
    organizationId,
    userId,
  ]);
  await owner.query(
    `insert into calls (id, organization_id, carrier_call_id, direction, dialled, caller)
     values ($1, $2, $3, 'inbound', $4, $5)`,
    [callId, organizationId, `probe-${callId}`, `+100000${label.length}`, "+2348000000000"],
  );

  const organisation: Organisation = { organizationId, userId, callId, email, password, token: "" };
  created.push(organisation);
  return organisation;
};

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const call = async (
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
  return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
};

const signIn = async (organisation: Organisation): Promise<string> => {
  const reply = await call("POST", "/api/v1/auth/sessions", {
    body: {
      email: organisation.email,
      password: organisation.password,
      organisationId: organisation.organizationId,
    },
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return String(reply.body["token"]);
};

let alpha: Organisation;
let beta: Organisation;

describe.skipIf(ownerUrl === undefined || appUrl === undefined)("organization isolation across the API", () => {
  beforeAll(async () => {
    owner = await createDataSource({ url: ownerUrl ?? "", poolSize: 2 }).initialize();
    alpha = await seed("alpha");
    beta = await seed("beta");

    app = await NestFactory.create(ApiModule, { logger: false });
    await app.listen(0);
    baseUrl = await app.getUrl();

    alpha.token = await signIn(alpha);
    beta.token = await signIn(beta);
  });

  afterAll(async () => {
    await app?.close();
    for (const organisation of created) {
      // memberships, sessions, invitations and calls all cascade from the organization; the user
      // is global and has to go separately.
      await owner.query("delete from organizations where id = $1", [organisation.organizationId]);
      await owner.query("delete from users where id = $1", [organisation.userId]);
    }
    await owner?.destroy();
  });

  it("shows each organisation only its own calls", async () => {
    const mine = await call("GET", "/api/v1/calls", { token: alpha.token });
    expect(mine.status).toBe(200);
    const ids = (mine.body["items"] as { id: string }[]).map((item) => item.id);
    expect(ids).toContain(alpha.callId);
    expect(ids).not.toContain(beta.callId);
  });

  /**
   * The one that justifies putting the organisation in the token.
   *
   * Rewriting it opens the scope of an organisation the session does not belong to, and
   * the session row is invisible there — so the forgery destroys the credential rather
   * than redirecting it. Nothing compares the claim to anything; RLS does the work.
   */
  it("rejects a session token rewritten to name another organisation", async () => {
    const forged = alpha.token.replace(alpha.organizationId, beta.organizationId);
    expect(forged).not.toBe(alpha.token);

    const reply = await call("GET", "/api/v1/calls", { token: forged });
    expect(reply.status).toBe(401);
    expect(reply.body["type"]).toBe("urn:ansa:problem:unauthenticated");
  });

  it("shows each organisation only its own people", async () => {
    const reply = await call("GET", "/api/v1/members", { token: beta.token });
    expect(reply.status).toBe(200);
    const emails = (reply.body["items"] as { email: string }[]).map((item) => item.email);
    expect(emails).toEqual([beta.email]);
  });

  it("will not let one organisation change another's member", async () => {
    const reply = await call("PATCH", `/api/v1/members/${alpha.userId}`, {
      token: beta.token,
      body: { role: "member" },
    });
    // 404 and not 403: confirming the id exists would be the leak.
    expect(reply.status).toBe(404);

    const unchanged = await call("GET", "/api/v1/auth/me", { token: alpha.token });
    expect(unchanged.body["role"]).toBe("owner");
  });

  it("hides one organisation's invitations from another", async () => {
    const invited = await call("POST", "/api/v1/invitations", {
      token: alpha.token,
      body: { email: `invitee-${randomUUID()}@invalid.test`, role: "member" },
    });
    expect(invited.status).toBe(201);

    const theirs = await call("GET", "/api/v1/invitations", { token: beta.token });
    expect(theirs.status).toBe(200);
    expect(theirs.body["items"]).toEqual([]);

    const mine = await call("GET", "/api/v1/invitations", { token: alpha.token });
    expect((mine.body["items"] as unknown[]).length).toBe(1);
  });

  it("refuses every request that carries no session", async () => {
    for (const path of ["/api/v1/calls", "/api/v1/members", "/api/v1/invitations", "/api/v1/auth/me"]) {
      const reply = await call("GET", path);
      expect(reply.status, path).toBe(401);
    }
  });

  it("stops accepting a token once its session is revoked", async () => {
    const throwaway = await signIn(beta);
    expect((await call("GET", "/api/v1/auth/me", { token: throwaway })).status).toBe(200);

    expect((await call("DELETE", "/api/v1/auth/sessions/current", { token: throwaway })).status).toBe(204);
    expect((await call("GET", "/api/v1/auth/me", { token: throwaway })).status).toBe(401);
    // The other session is untouched: revocation is per session, not per user.
    expect((await call("GET", "/api/v1/auth/me", { token: beta.token })).status).toBe(200);
  });

  it("answers a wrong password and an unknown address identically", async () => {
    const wrong = await call("POST", "/api/v1/auth/sessions", {
      body: { email: alpha.email, password: `${alpha.password}x`, organisationId: alpha.organizationId },
    });
    const absent = await call("POST", "/api/v1/auth/sessions", {
      body: { email: `nobody-${randomUUID()}@invalid.test`, password: alpha.password, organisationId: alpha.organizationId },
    });
    expect(wrong.status).toBe(401);
    expect(absent.status).toBe(401);
    expect(wrong.body["detail"]).toBe(absent.body["detail"]);
  });

  it("refuses to sign a real user into an organisation they do not belong to", async () => {
    const reply = await call("POST", "/api/v1/auth/sessions", {
      body: { email: alpha.email, password: alpha.password, organisationId: beta.organizationId },
    });
    expect(reply.status).toBe(401);
  });

  it("names the fields that failed instead of guessing", async () => {
    const reply = await call("POST", "/api/v1/invitations", {
      token: alpha.token,
      body: { email: "not-an-email", role: "superuser", extra: 1 },
    });
    expect(reply.status).toBe(422);
    const errors = reply.body["errors"] as { path: string }[];
    expect(errors.map((error) => error.path).sort()).toEqual(["body.email", "body.extra", "body.role"]);
  });

  /** The response schema is an allowlist; nothing it does not name reaches the wire. */
  it("never returns a password hash", async () => {
    const members = await call("GET", "/api/v1/members", { token: alpha.token });
    expect(JSON.stringify(members.body)).not.toContain("scrypt");
  });

  it("stamps every response with the request id the error would quote", async () => {
    const response = await fetch(`${baseUrl}/api/v1/calls`);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  /**
   * The end-to-end path a new colleague takes, and the proof that it lands them in the
   * organisation the invitation named rather than one they chose.
   */
  it("puts an invited person in the inviting organisation and nowhere else", async () => {
    const inviteeEmail = `joiner-${randomUUID()}@invalid.test`;
    const password = `${randomUUID()}-${randomUUID()}`;

    const invited = await call("POST", "/api/v1/invitations", {
      token: beta.token,
      body: { email: inviteeEmail, role: "member" },
    });
    const token = String(invited.body["token"]);

    const accepted = await call("POST", "/api/v1/invitations/accept", {
      body: { token, password, displayName: "Joiner" },
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body["organisationId"]).toBe(beta.organizationId);
    expect(accepted.body["createdUser"]).toBe(true);

    // Single use: the same token a second time is refused.
    const replay = await call("POST", "/api/v1/invitations/accept", {
      body: { token, password, displayName: "Joiner" },
    });
    expect(replay.status).toBe(401);

    const organisations = await call("POST", "/api/v1/auth/organisations", {
      body: { email: inviteeEmail, password },
    });
    expect((organisations.body["organisations"] as { id: string }[]).map((each) => each.id)).toEqual([
      beta.organizationId,
    ]);

    // A member may read, and may not invite.
    const joinerToken = String(
      (
        await call("POST", "/api/v1/auth/sessions", {
          body: { email: inviteeEmail, password, organisationId: beta.organizationId },
        })
      ).body["token"],
    );
    expect((await call("GET", "/api/v1/calls", { token: joinerToken })).status).toBe(200);

    const refused = await call("POST", "/api/v1/invitations", {
      token: joinerToken,
      body: { email: `another-${randomUUID()}@invalid.test`, role: "member" },
    });
    expect(refused.status).toBe(403);
    expect(refused.body["type"]).toBe("urn:ansa:problem:forbidden");

    await owner.query("delete from users where email = $1", [inviteeEmail]);
  });

  /** The trigger in migration 0016, reaching the caller as the 409 it is. */
  it("will not let an organisation remove its last owner", async () => {
    const reply = await call("DELETE", `/api/v1/members/${alpha.userId}`, { token: alpha.token });
    expect(reply.status).toBe(409);

    const still = await call("GET", "/api/v1/auth/me", { token: alpha.token });
    expect(still.status).toBe(200);
  });
});
