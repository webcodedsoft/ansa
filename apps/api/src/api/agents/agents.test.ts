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
 * The agents surface, against a real database over real HTTP.
 *
 * Nine routes had no HTTP coverage at all — list, create, read, patch, archive and four
 * staging puts — and `TASKS.md` recorded that as "only `GET /agents` is exercised", which
 * was wrong in the direction that stops anybody looking.
 *
 * Two of those routes decide something they did not used to. `POST /agents` and
 * `DELETE /agents/:id` move an organisation between one live agent and two, and migration
 * 0047 made every organisation-scoped configuration route refuse in that state rather than
 * guess which agent it meant. So the interesting property here is not any single route: it
 * is that creating an agent changes what a *different* surface does, and archiving it
 * changes it back.
 *
 * Real HTTP and a real database for the reason `calls.test.ts` gives. Both properties worth
 * proving live outside the handler — cross-organisation invisibility is a fact about RLS,
 * and the 0047 refusal is a fact about a `raise` inside a plpgsql function. A fake scope
 * agrees with whatever the code does and would prove neither.
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
  readonly organizationId: string;
  readonly owner: Person;
  /** `config:read` and not `config:write`, which is the whole of the capability test. */
  readonly member: Person;
  /** Two numbers this organisation holds, and may therefore route. */
  readonly numbers: readonly [string, string];
}

let owner: Db;
let app: INestApplication;
let baseUrl: string;
const organizations: string[] = [];
const users: string[] = [];

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

/** Enough to spread the seeded numbers apart. Not a security boundary. */
const hash = (text: string): number => {
  let value = 0;
  for (const character of text) value = (value * 31 + character.charCodeAt(0)) | 0;
  return value;
};

/**
 * An organisation with no agents.
 *
 * Deliberately empty, because "no live agent" is a real state with its own answer and the
 * only way to reach the one-agent and two-agent states through the routes under test is to
 * start below them. The numbers are seeded as the database owner because that is the only
 * way they can be: `organization_numbers` is written by an operator and `ansa_app` holds
 * SELECT on it and nothing else.
 */
const seed = async (label: string): Promise<Organisation> => {
  const organizationId = randomUUID();
  await owner.query("insert into organizations (id, name) values ($1, $2)", [
    organizationId,
    `Org ${label}`,
  ]);
  organizations.push(organizationId);

  const orgOwner = await person(`${label}-owner`);
  const orgMember = await person(`${label}-member`);
  await owner.query(
    "insert into memberships (organization_id, user_id, role) values ($1, $2, 'owner')",
    [organizationId, orgOwner.userId],
  );
  await owner.query(
    "insert into memberships (organization_id, user_id, role) values ($1, $2, 'member')",
    [organizationId, orgMember.userId],
  );

  /* Globally unique across the table, so they are minted per run rather than fixed —
     two suites sharing a literal number would collide on the primary key. */
  const first = `+234700${String(Math.abs(hash(`${label}-1-${organizationId}`))).padStart(7, "0").slice(0, 7)}`;
  const second = `+234700${String(Math.abs(hash(`${label}-2-${organizationId}`))).padStart(7, "0").slice(0, 7)}`;
  await owner.query(
    "insert into organization_numbers (organization_id, number, note) values ($1, $2, $3), ($1, $4, $3)",
    [organizationId, first, `seeded by ${label}`, second],
  );

  return { organizationId, owner: orgOwner, member: orgMember, numbers: [first, second] };
};

const signIn = async (organisation: Organisation, who: Person): Promise<string> => {
  const reply = await request("POST", "/api/v1/auth/sessions", {
    body: {
      email: who.email,
      password: who.password,
      organisationId: organisation.organizationId,
    },
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return String(reply.body["token"]);
};

const items = (reply: Reply): Record<string, unknown>[] =>
  reply.body["items"] as Record<string, unknown>[];

/** A configuration document that passes the shared publish/draft validation. */
const configuration = {
  name: "Support",
  voiceId: null,
  speakingRate: null,
  greeting: "Good afternoon, thank you for calling.",
  persona: null,
  instructions: null,
  keyterms: [],
  businessHours: null,
  escalation: null,
};

let alpha: Organisation;
let beta: Organisation;

describe.skipIf(ownerUrl === undefined || appUrl === undefined)("the agents endpoints", () => {
  beforeAll(async () => {
    owner = await createDataSource({ url: ownerUrl ?? "", poolSize: 2 }).initialize();
    alpha = await seed("alpha");
    beta = await seed("beta");

    app = await NestFactory.create(ApiModule, { logger: false });
    await app.listen(0);
    baseUrl = await app.getUrl();

    alpha.owner.token = await signIn(alpha, alpha.owner);
    alpha.member.token = await signIn(alpha, alpha.member);
    beta.owner.token = await signIn(beta, beta.owner);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const id of organizations) {
      await owner.query("delete from organizations where id = $1", [id]);
    }
    for (const id of users) await owner.query("delete from users where id = $1", [id]);
    await owner?.destroy();
  });

  it("lists nothing for an organisation that has no agents", async () => {
    const reply = await request("GET", "/api/v1/agents", { token: alpha.owner.token });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(items(reply)).toHaveLength(0);
  });

  it("creates an agent at version one, with no tools and no number", async () => {
    const reply = await request("POST", "/api/v1/agents", {
      token: alpha.owner.token,
      body: { name: "First" },
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body["configVersion"]).toBe(1);
    // A new agent does not inherit permission to call the organisation's endpoints.
    expect(reply.body["enabledTools"]).toEqual([]);
    expect(reply.body["dialledNumber"]).toBeNull();
    expect(reply.body["deletedAt"]).toBeNull();

    const listed = await request("GET", "/api/v1/agents", { token: alpha.owner.token });
    expect(items(listed).map((row) => row["agentId"])).toContain(reply.body["agentId"]);
  });

  it("does not show one organisation's agents to another", async () => {
    const mine = await request("GET", "/api/v1/agents", { token: beta.owner.token });
    expect(items(mine)).toHaveLength(0);

    const theirs = await request("GET", "/api/v1/agents", { token: alpha.owner.token });
    const agentId = String(items(theirs)[0]?.["agentId"]);

    // Not ours reads as does not exist, and under RLS that is also the true answer. A 403
    // would confirm the id exists, which is the thing a caller must not learn.
    for (const [method, body] of [
      ["GET", undefined],
      ["PATCH", { dialledNumber: null }],
      ["DELETE", undefined],
    ] as const) {
      const reply = await request(method, `/api/v1/agents/${agentId}`, {
        token: beta.owner.token,
        ...(body === undefined ? {} : { body }),
      });
      expect(reply.status, `${method} leaked`).toBe(404);
    }

    // And the agent they could not see is unchanged after all three attempts.
    const after = await request("GET", `/api/v1/agents/${agentId}`, { token: alpha.owner.token });
    expect(after.status).toBe(200);
    expect(after.body["deletedAt"]).toBeNull();
  });

  it("refuses a write to a member and allows the read", async () => {
    const read = await request("GET", "/api/v1/agents", { token: alpha.member.token });
    expect(read.status).toBe(200);

    const write = await request("POST", "/api/v1/agents", {
      token: alpha.member.token,
      body: { name: "Not allowed" },
    });
    expect(write.status, JSON.stringify(write.body)).toBe(403);
  });

  it("routes an agent to a number the organisation holds, and refuses one it does not", async () => {
    const held = await request("POST", "/api/v1/agents", {
      token: alpha.owner.token,
      body: { name: "Routed", dialledNumber: alpha.numbers[0] },
    });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect(held.body["dialledNumber"]).toBe(alpha.numbers[0]);

    // Beta's number, from alpha's session. 409 rather than 404, and the message must not
    // say who holds it — the index is global and naming the holder tells a caller that
    // somebody else is a customer.
    const notHeld = await request("POST", "/api/v1/agents", {
      token: alpha.owner.token,
      body: { name: "Stolen", dialledNumber: beta.numbers[0] },
    });
    expect(notHeld.status, JSON.stringify(notHeld.body)).toBe(409);
    expect(JSON.stringify(notHeld.body)).not.toContain(beta.organizationId);

    /* The same refusal through the other route. Both share `asRoutingRefusal`, and the
       point of asserting twice is that the shared part is the part that was broken: the
       matcher compared against a constraint name that no database has ever used, so both
       routes answered 500 to a number the organisation does not hold. */
    const moved = await request("PATCH", `/api/v1/agents/${String(held.body["agentId"])}`, {
      token: alpha.owner.token,
      body: { dialledNumber: beta.numbers[1] },
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(409);

    // Archived so the later count of live agents stays predictable.
    await request("DELETE", `/api/v1/agents/${String(held.body["agentId"])}`, {
      token: alpha.owner.token,
    });
  });

  it("refuses a patch that carries a field publishing owns", async () => {
    const created = await request("POST", "/api/v1/agents", {
      token: alpha.owner.token,
      body: { name: "Patchable" },
    });
    const agentId = String(created.body["agentId"]);

    /* Everything a caller hears is published, not patched. A field removed from the edit
       schema is refused rather than ignored, and that is the point: it used to work, so
       "it stopped working" has to be loud rather than a silent no-op. */
    const reply = await request("PATCH", `/api/v1/agents/${agentId}`, {
      token: alpha.owner.token,
      body: { greeting: "Hello from a patch" },
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(422);
    expect(JSON.stringify(reply.body)).toContain("greeting");

    await request("DELETE", `/api/v1/agents/${agentId}`, { token: alpha.owner.token });
  });

  it("archives rather than deletes, and releases the number in the same act", async () => {
    const created = await request("POST", "/api/v1/agents", {
      token: alpha.owner.token,
      body: { name: "Retiring", dialledNumber: alpha.numbers[1] },
    });
    const agentId = String(created.body["agentId"]);

    const archived = await request("DELETE", `/api/v1/agents/${agentId}`, {
      token: alpha.owner.token,
    });
    expect(archived.status, JSON.stringify(archived.body)).toBe(204);

    // Still listed, because a call log that references it still needs its name.
    const listed = await request("GET", "/api/v1/agents", { token: alpha.owner.token });
    const row = items(listed).find((item) => item["agentId"] === agentId);
    expect(row, "an archived agent must stay listed").toBeDefined();
    expect(row?.["deletedAt"]).not.toBeNull();

    // The number is free again, which is the half that matters — an archived agent does not
    // answer, so a number left attached would ring nobody and could never be reassigned.
    const reused = await request("POST", "/api/v1/agents", {
      token: alpha.owner.token,
      body: { name: "Successor", dialledNumber: alpha.numbers[1] },
    });
    expect(reused.status, JSON.stringify(reused.body)).toBe(200);
    await request("DELETE", `/api/v1/agents/${String(reused.body["agentId"])}`, {
      token: alpha.owner.token,
    });
  });

  /**
   * The reason this file exists.
   *
   * `PUT /config/draft` has no agent in its route and resolves one in the database. Beta
   * walks all three states through the agents routes, and the configuration surface answers
   * differently in each — which is the coupling nothing was testing.
   */
  it("makes the configuration surface refuse once a second agent exists", async () => {
    const draft = async (): Promise<Reply> =>
      request("PUT", "/api/v1/config/draft", { token: beta.owner.token, body: configuration });

    // No live agent: a 404, because there is nothing to save a draft against.
    expect((await draft()).status).toBe(404);

    const first = await request("POST", "/api/v1/agents", {
      token: beta.owner.token,
      body: { name: "Only" },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const saved = await draft();
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const second = await request("POST", "/api/v1/agents", {
      token: beta.owner.token,
      body: { name: "Second" },
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);

    /* Two live agents and no agent in the route. Before migration 0047 this saved against
       the older one and said nothing — an operator edits the agent they have open, and the
       work lands on the other. It now fails, and failing is the requirement: the assertion
       is that it is no longer a 200, not that any particular status came back. */
    const ambiguous = await draft();
    expect(ambiguous.status, "a draft with two live agents must not silently save").not.toBe(200);

    // Archiving the second returns the organisation to one, and the surface works again.
    const gone = await request("DELETE", `/api/v1/agents/${String(second.body["agentId"])}`, {
      token: beta.owner.token,
    });
    expect(gone.status).toBe(204);

    const recovered = await draft();
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
  });
});
