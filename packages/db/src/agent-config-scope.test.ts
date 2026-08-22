import { asOrganizationId } from "@ansa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDataSource, type Db } from "./data-source";
import { withOrganization } from "./organization-scope";
import { loadDotEnv } from "./test-env";

loadDotEnv();

/**
 * Which agent's configuration `ansa_app` is allowed to read.
 *
 * `app.agent_config_for_id` is SECURITY DEFINER, so RLS does not apply to it, and it filters
 * on `where a.id = agent` and nothing else. Its result includes the organisation's
 * `organization_credentials`. It was granted to `ansa_app` with no caller in TypeScript — a
 * door with nothing behind it yet, which is the kind that gets opened by accident: the first
 * route to accept an `:agentId` and pass it to a configuration reader would have read across
 * the tenant boundary without anybody describing the change as touching isolation.
 *
 * Migration 0050 revokes it and adds `app.agent_config_for_agent`, which refuses an agent
 * outside the current scope. These tests pin both halves — that the unscoped door is shut,
 * and that the scoped one gives the same "not ours reads as absent" answer everything else in
 * the tenancy layer gives.
 *
 * As the application role, because the grant is the thing under test. Run as the owner all of
 * this passes and proves nothing.
 */

const appUrl = process.env["DATABASE_URL"];
const ownerUrl = process.env["MIGRATION_DIRECT_URL"];
if (appUrl === undefined) {
  throw new Error("DATABASE_URL must be set: this test needs a database");
}

/** Unique to this file — see the note in `caller-history.test.ts` on why that matters. */
const MINE = asOrganizationId("c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2");
const THEIRS = asOrganizationId("c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3");

let app: Db;
let owner: Db | null = null;
let myAgent: string;
let theirAgent: string;

const seedAgent = async (organization: typeof MINE, name: string): Promise<string> => {
  const rows = (await owner?.query(
    `insert into agents (organization_id, name, greeting) values ($1, $2, $3) returning id`,
    [organization, name, `Hello from ${name}.`],
  )) as { id: string }[];
  return String(rows[0]?.id);
};

describe.skipIf(ownerUrl === undefined)("who may read an agent's configuration", () => {
  beforeAll(async () => {
    app = await createDataSource({ url: appUrl, poolSize: 2 }).initialize();
    // `ansa_app` cannot insert into `agents`, which is itself the operator/organisation split
    // working. Seeding needs the owner.
    owner = await createDataSource({ url: ownerUrl ?? "", poolSize: 2 }).initialize();

    for (const [organization, name] of [
      [MINE, "Scope Mine"],
      [THEIRS, "Scope Theirs"],
    ] as const) {
      await owner.query("insert into organizations (id, name) values ($1, $2)", [
        organization,
        name,
      ]);
    }
    myAgent = await seedAgent(MINE, "Mine");
    theirAgent = await seedAgent(THEIRS, "Theirs");
  }, 60_000);

  afterAll(async () => {
    for (const organization of [MINE, THEIRS]) {
      await owner?.query("delete from organizations where id = $1", [organization]);
    }
    await app?.destroy();
    await owner?.destroy();
  });

  it("refuses the application role the unscoped reader outright", async () => {
    /* Not "returns nothing" — cannot be called at all. A function that takes any id and
       checks nothing should not be reachable from the role that handles requests, however
       carefully today's callers happen to use it. */
    await expect(
      withOrganization(app, MINE, (scope) =>
        scope.query("select * from app.agent_config_for_id($1::uuid)", [myAgent]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("reads its own agent through the scoped one", async () => {
    const rows = await withOrganization(app, MINE, (scope) =>
      scope.query<{ agent_id: string; greeting: string }>(
        "select agent_id, greeting from app.agent_config_for_agent($1::uuid)",
        [myAgent],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent_id).toBe(myAgent);
    expect(rows[0]?.greeting).toBe("Hello from Mine.");
  });

  it("returns nothing for another organisation's agent, rather than raising", async () => {
    /* Absent, not forbidden. The id is the only thing an attacker needs to be handed, so an
       error that distinguishes "not yours" from "no such agent" confirms the id belongs to
       somebody. Same answer `GET /agents/:agentId` gives, and the same one RLS would. */
    const rows = await withOrganization(app, MINE, (scope) =>
      scope.query("select * from app.agent_config_for_agent($1::uuid)", [theirAgent]),
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses to answer at all with no organisation scope set", async () => {
    /* The case a null check gets backwards. An unscoped connection is the one with nothing to
       compare against, so a rule shaped "check only when a scope exists" is permissive
       exactly when it matters most. */
    await expect(
      app.query("select * from app.agent_config_for_agent($1::uuid)", [myAgent]),
    ).rejects.toThrow(/organization scope/i);
  });

  it("leaves the legitimate resolver working", async () => {
    /* The revoke must not reach `agent_config_for_organization`, which calls the unscoped
       reader inside itself. It is SECURITY DEFINER and owned by `postgres`, so the inner call
       runs as the owner — true, and worth a test rather than an argument, because getting it
       wrong takes every published configuration offline. */
    const rows = await withOrganization(app, MINE, (scope) =>
      scope.query<{ agent_id: string }>(
        "select agent_id from app.agent_config_for_organization($1::uuid)",
        [MINE],
      ),
    );
    expect(rows[0]?.agent_id).toBe(myAgent);
  });
});
