import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadDotEnv } from "./test-env";

loadDotEnv();

/**
 * The adversarial organization-isolation test (R7.2).
 *
 * This does not check that policies exist — `pg_policies` will happily report a policy
 * that enforces nothing. It plays the attacker: two organizations, and every route organization A
 * could take to touch organization B's rows. It must run in CI forever.
 *
 * It runs as the connecting user, which on Supabase owns these tables. That is the
 * point: FORCE ROW LEVEL SECURITY is what subjects the owner to its own policies, and
 * a regression that dropped FORCE would let every assertion below through.
 */

const url = process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"];
if (url === undefined) {
  throw new Error("DIRECT_URL or DATABASE_URL must be set: this test needs a database");
}

const ORGANIZATION_A = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_B = "22222222-2222-4222-8222-222222222222";
const CALL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CALL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let db: Client;

/** Runs `work` in a transaction scoped to `organization`, exactly as the app must. */
const asOrganization = async <T>(
  organization: string | null,
  work: (c: Client) => Promise<T>,
): Promise<T> => {
  await db.query("begin");
  try {
    if (organization !== null) await db.query("select set_config('app.organization_id', $1, true)", [organization]);
    return await work(db);
  } finally {
    await db.query("rollback");
  }
};

beforeAll(async () => {
  db = new Client({ connectionString: url });
  await db.connect();

  // Seed outside the helper so the rows persist for the assertions below.
  await db.query("begin");
  await db.query("select set_config('app.organization_id', $1, true)", [ORGANIZATION_A]);
  await db.query("insert into organizations (id, name) values ($1, 'Organization A') on conflict do nothing", [ORGANIZATION_A]);
  await db.query(
    `insert into calls (id, organization_id, carrier_call_id, dialled, caller)
     values ($1, $2, 'CA-a', '+10000000001', '+2348000000001') on conflict do nothing`,
    [CALL_A, ORGANIZATION_A],
  );
  await db.query("commit");

  await db.query("begin");
  await db.query("select set_config('app.organization_id', $1, true)", [ORGANIZATION_B]);
  await db.query("insert into organizations (id, name) values ($1, 'Organization B') on conflict do nothing", [ORGANIZATION_B]);
  await db.query(
    `insert into calls (id, organization_id, carrier_call_id, dialled, caller)
     values ($1, $2, 'CA-b', '+10000000002', '+2348000000002') on conflict do nothing`,
    [CALL_B, ORGANIZATION_B],
  );
  await db.query("commit");
});

afterAll(async () => {
  for (const t of [ORGANIZATION_A, ORGANIZATION_B]) {
    await db.query("begin");
    await db.query("select set_config('app.organization_id', $1, true)", [t]);
    await db.query("delete from calls where organization_id = $1", [t]);
    await db.query("delete from organizations where id = $1", [t]);
    await db.query("commit");
  }
  await db.end();
});

describe("organization isolation", () => {
  it("shows a organization only its own calls", async () => {
    const rows = await asOrganization(ORGANIZATION_A, async (c) =>
      (await c.query("select id, organization_id from calls")).rows,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: CALL_A, organization_id: ORGANIZATION_A });
  });

  it("returns nothing when organization A asks for organization B's call by id", async () => {
    const rows = await asOrganization(ORGANIZATION_A, async (c) =>
      (await c.query("select * from calls where id = $1", [CALL_B])).rows,
    );

    expect(rows).toEqual([]);
  });

  it("returns nothing when organization A filters by organization B's organization_id", async () => {
    const rows = await asOrganization(ORGANIZATION_A, async (c) =>
      (await c.query("select * from calls where organization_id = $1", [ORGANIZATION_B])).rows,
    );

    expect(rows).toEqual([]);
  });

  it("hides organization B's organization row from organization A", async () => {
    const rows = await asOrganization(ORGANIZATION_A, async (c) =>
      (await c.query("select id from organizations")).rows,
    );

    expect(rows.map((r) => r.id)).toEqual([ORGANIZATION_A]);
  });

  // The failure that matters most: an unscoped connection must see nothing, not
  // everything. Anything that forgets to set the organization fails closed.
  it("shows nothing at all when no organization is set", async () => {
    const calls = await asOrganization(null, async (c) => (await c.query("select * from calls")).rows);
    const organizations = await asOrganization(null, async (c) => (await c.query("select * from organizations")).rows);

    expect(calls).toEqual([]);
    expect(organizations).toEqual([]);
  });

  it("counts and aggregates cannot leak row existence either", async () => {
    const { count } = await asOrganization(ORGANIZATION_A, async (c) =>
      (await c.query("select count(*)::int as count from calls")).rows[0],
    );

    expect(count).toBe(1);
  });

  // USING filters reads; WITH CHECK constrains writes. Without it a organization could plant
  // a row under someone else's id — invisible to them afterwards, and a leak.
  it("refuses to insert a row stamped with another organization's id", async () => {
    await expect(
      asOrganization(ORGANIZATION_A, async (c) =>
        c.query(
          `insert into calls (organization_id, carrier_call_id, dialled) values ($1, 'CA-evil', '+1')`,
          [ORGANIZATION_B],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot update another organization's call", async () => {
    const result = await asOrganization(ORGANIZATION_A, async (c) =>
      c.query("update calls set end_reason = 'tampered' where id = $1", [CALL_B]),
    );

    expect(result.rowCount).toBe(0);
  });

  it("cannot delete another organization's call", async () => {
    const result = await asOrganization(ORGANIZATION_A, async (c) =>
      c.query("delete from calls where id = $1", [CALL_B]),
    );

    expect(result.rowCount).toBe(0);
  });

  it("cannot reach another organization's rows through a subquery", async () => {
    const rows = await asOrganization(ORGANIZATION_A, async (c) =>
      (
        await c.query(
          "select * from calls where organization_id in (select id from organizations where name = 'Organization B')",
        )
      ).rows,
    );

    expect(rows).toEqual([]);
  });

  it("keeps every event-log table isolated, not just calls", async () => {
    const rows = await asOrganization(ORGANIZATION_A, async (c) =>
      (
        await c.query(`
          select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
                 exists (select 1 from pg_policies p
                         where p.schemaname = 'public' and p.tablename = c.relname) as has_policy
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
          order by 1`)
      ).rows,
    );

    // FORCE is the one that survives code review while silently enforcing nothing if
    // it is ever dropped, so it is asserted per table rather than assumed.
    //
    // This used to also assert a hardcoded count, on the grounds that it is what makes
    // adding a table without RLS fail here. It does not: the query above returns *every*
    // table in `public`, so a new unprotected one fails the loop below whatever the count
    // says. What the number actually tracked was how many migrations a human had applied
    // by hand in the Supabase editor, and it had been red since `agent_prompt_versions`
    // (0011) landed without it being updated — a red that says nothing about isolation.
    //
    // The core eight are named instead. That keeps the other thing the count was quietly
    // doing, which is proving the query returned something at all.
    for (const table of [
      "organizations",
      "calls",
      "call_events",
      "turns",
      "transcripts",
      "tool_invocations",
      "latencies",
      "audio_segments",
    ]) {
      expect(rows.map((row) => row.table)).toContain(table);
    }
    for (const row of rows) {
      expect(row).toEqual({ table: row.table, enabled: true, forced: true, has_policy: true });
    }
  });

  it("keeps one organization's suppression list out of another's reach", async () => {
    const number = `+234900${Date.now() % 1000000}`;

    await asOrganization(ORGANIZATION_A, async (c) => {
      await c.query(
        "insert into do_not_call (organization_id, phone_number, reason) values ($1, $2, 'test')",
        [ORGANIZATION_A, number],
      );
    });

    const bSees = await asOrganization(ORGANIZATION_B, async (c) =>
      (await c.query("select 1 from do_not_call where phone_number = $1", [number])).rows,
    );
    expect(bSees).toEqual([]);

    // The global case — organization_id null, visible to everyone by design so a person need
    // not ask each organization separately — is not covered here: inserting one needs the owner
    // role, which this suite connects as ansa_app precisely to avoid.
  });
});

/**
 * Soft delete has to bite, not merely be recorded (0032, 0033).
 *
 * A `deleted_at` column that reads still return is worse than no column: it looks like the
 * row is gone while it goes on working. These play the same adversary as the isolation tests
 * above — somebody removed from an organisation, trying to keep the access they had.
 *
 * Seeded through a second connection as the operator, because `ansa_app` cannot insert a
 * user: accounts are created only through `SECURITY DEFINER` functions, and that grant is
 * itself part of the isolation. Every assertion still runs as `ansa_app`, which is the role
 * whose view of the world is under test.
 */
describe("soft delete", () => {
  const USER = "33333333-3333-4333-8333-333333333333";
  /* An owner beside the member under test. `memberships_keep_an_owner` refuses to leave an
     organisation without one, so removing the only membership would fail for a reason that
     has nothing to do with soft delete — and would hide whether soft delete worked. */
  const OWNER = "44444444-4444-4444-8444-444444444444";
  const NUMBER = "+10000000009";
  const operatorUrl = process.env["MIGRATION_DIRECT_URL"] ?? url;
  let operator: Client;

  beforeAll(async () => {
    operator = new Client({ connectionString: operatorUrl });
    await operator.connect();
  });

  afterAll(async () => {
    /* Marked deleted before the memberships go. `memberships_keep_an_owner` exempts an
       organisation that is already gone, and without this the teardown raises — noise that
       would sit in the output and could hide a real failure later. */
    await operator.query("update organizations set deleted_at = now() where id = $1", [ORGANIZATION_A]);
    await operator.query("delete from agents where dialled_number = $1", [NUMBER]);
    await operator.query("delete from organization_numbers where number = $1", [NUMBER]);
    await operator.query("delete from memberships where user_id = any($1)", [[USER, OWNER]]);
    await operator.query("delete from users where id = any($1)", [[USER, OWNER]]);
    await operator.end();
  });

  /** Back to a clean slate between tests: these mutate the same two rows in turn. */
  const reset = async () => {
    await operator.query(
      `insert into users (id, email, password_hash, display_name)
       values ($1, 'owner@example.test', 'x', 'Owner'), ($2, 'left@example.test', 'x', 'Left')
       on conflict (id) do update set deleted_at = null`,
      [OWNER, USER],
    );
    await operator.query(
      `insert into memberships (organization_id, user_id, role)
       values ($1, $2, 'owner'), ($1, $3, 'admin')
       on conflict (organization_id, user_id) do update set deleted_at = null`,
      [ORGANIZATION_A, OWNER, USER],
    );
    await operator.query("update organizations set deleted_at = null where id = $1", [ORGANIZATION_A]);
  };

  it("stops a removed member's row being visible through the users policy", async () => {
    await reset();
    const before = await asOrganization(ORGANIZATION_A, async (c) =>
      (await c.query("select id from users where id = $1", [USER])).rowCount,
    );

    await operator.query("update memberships set deleted_at = now() where user_id = $1", [USER]);
    const after = await asOrganization(ORGANIZATION_A, async (c) =>
      (await c.query("select id from users where id = $1", [USER])).rowCount,
    );

    /* The policy grants sight of a user through a membership. If a deleted membership still
       satisfied it, removing somebody would leave them readable — and leave the row saying
       they belong. */
    expect(before).toBe(1);
    expect(after).toBe(0);
  });

  it("does not offer a deleted organisation back to the user who was in it", async () => {
    await reset();
    await operator.query("update organizations set deleted_at = now() where id = $1", [ORGANIZATION_A]);

    // A live membership into a deleted organisation is still nothing to sign in to.
    const listed = await asOrganization(ORGANIZATION_A, async (c) =>
      (await c.query("select * from app.organisations_for_user($1)", [USER])).rowCount,
    );
    expect(listed).toBe(0);
  });

  it("stops a deleted organisation answering a number that still routes to it", async () => {
    await reset();
    await operator.query(
      `insert into organization_numbers (organization_id, number) values ($1, $2)
       on conflict (number) do update set organization_id = excluded.organization_id`,
      [ORGANIZATION_A, NUMBER],
    );
    await operator.query(
      `insert into agents (organization_id, name, dialled_number) values ($1, 'Soft delete probe', $2)
       on conflict (dialled_number) where dialled_number is not null
       do update set deleted_at = null`,
      [ORGANIZATION_A, NUMBER],
    );

    const before = await asOrganization(null, async (c) =>
      (await c.query("select app.organization_for_number($1) as id", [NUMBER])).rows[0]?.id ?? null,
    );

    await operator.query("update organizations set deleted_at = now() where id = $1", [ORGANIZATION_A]);
    const after = await asOrganization(null, async (c) =>
      (await c.query("select app.organization_for_number($1) as id", [NUMBER])).rows[0]?.id ?? null,
    );

    /* The number stays registered and the carrier goes on dialling it. Without the check the
       caller would be connected to an organisation that no longer exists. */
    expect(before).toBe(ORGANIZATION_A);
    expect(after).toBeNull();
  });

  it("will not let a deleted user sign in", async () => {
    await reset();
    const before = await asOrganization(null, async (c) =>
      (await c.query("select * from app.credentials_for_email('left@example.test')")).rowCount,
    );

    await operator.query("update users set deleted_at = now() where id = $1", [USER]);
    const after = await asOrganization(null, async (c) =>
      (await c.query("select * from app.credentials_for_email('left@example.test')")).rowCount,
    );

    // Reached before there is a session or an organisation scope, so nothing else catches it.
    expect(before).toBe(1);
    expect(after).toBe(0);
  });
});
