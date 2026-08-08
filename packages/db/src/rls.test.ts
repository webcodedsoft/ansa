import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadDotEnv } from "./test-env";

loadDotEnv();

/**
 * The adversarial tenant-isolation test (R7.2).
 *
 * This does not check that policies exist — `pg_policies` will happily report a policy
 * that enforces nothing. It plays the attacker: two tenants, and every route tenant A
 * could take to touch tenant B's rows. It must run in CI forever.
 *
 * It runs as the connecting user, which on Supabase owns these tables. That is the
 * point: FORCE ROW LEVEL SECURITY is what subjects the owner to its own policies, and
 * a regression that dropped FORCE would let every assertion below through.
 */

const url = process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"];
if (url === undefined) {
  throw new Error("DIRECT_URL or DATABASE_URL must be set: this test needs a database");
}

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const CALL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CALL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let db: Client;

/** Runs `work` in a transaction scoped to `tenant`, exactly as the app must. */
const asTenant = async <T>(
  tenant: string | null,
  work: (c: Client) => Promise<T>,
): Promise<T> => {
  await db.query("begin");
  try {
    if (tenant !== null) await db.query("select set_config('app.tenant_id', $1, true)", [tenant]);
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
  await db.query("select set_config('app.tenant_id', $1, true)", [TENANT_A]);
  await db.query("insert into tenants (id, name) values ($1, 'Tenant A') on conflict do nothing", [TENANT_A]);
  await db.query(
    `insert into calls (id, tenant_id, carrier_call_id, dialled, caller)
     values ($1, $2, 'CA-a', '+10000000001', '+2348000000001') on conflict do nothing`,
    [CALL_A, TENANT_A],
  );
  await db.query("commit");

  await db.query("begin");
  await db.query("select set_config('app.tenant_id', $1, true)", [TENANT_B]);
  await db.query("insert into tenants (id, name) values ($1, 'Tenant B') on conflict do nothing", [TENANT_B]);
  await db.query(
    `insert into calls (id, tenant_id, carrier_call_id, dialled, caller)
     values ($1, $2, 'CA-b', '+10000000002', '+2348000000002') on conflict do nothing`,
    [CALL_B, TENANT_B],
  );
  await db.query("commit");
});

afterAll(async () => {
  for (const t of [TENANT_A, TENANT_B]) {
    await db.query("begin");
    await db.query("select set_config('app.tenant_id', $1, true)", [t]);
    await db.query("delete from calls where tenant_id = $1", [t]);
    await db.query("delete from tenants where id = $1", [t]);
    await db.query("commit");
  }
  await db.end();
});

describe("tenant isolation", () => {
  it("shows a tenant only its own calls", async () => {
    const rows = await asTenant(TENANT_A, async (c) =>
      (await c.query("select id, tenant_id from calls")).rows,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: CALL_A, tenant_id: TENANT_A });
  });

  it("returns nothing when tenant A asks for tenant B's call by id", async () => {
    const rows = await asTenant(TENANT_A, async (c) =>
      (await c.query("select * from calls where id = $1", [CALL_B])).rows,
    );

    expect(rows).toEqual([]);
  });

  it("returns nothing when tenant A filters by tenant B's tenant_id", async () => {
    const rows = await asTenant(TENANT_A, async (c) =>
      (await c.query("select * from calls where tenant_id = $1", [TENANT_B])).rows,
    );

    expect(rows).toEqual([]);
  });

  it("hides tenant B's tenant row from tenant A", async () => {
    const rows = await asTenant(TENANT_A, async (c) =>
      (await c.query("select id from tenants")).rows,
    );

    expect(rows.map((r) => r.id)).toEqual([TENANT_A]);
  });

  // The failure that matters most: an unscoped connection must see nothing, not
  // everything. Anything that forgets to set the tenant fails closed.
  it("shows nothing at all when no tenant is set", async () => {
    const calls = await asTenant(null, async (c) => (await c.query("select * from calls")).rows);
    const tenants = await asTenant(null, async (c) => (await c.query("select * from tenants")).rows);

    expect(calls).toEqual([]);
    expect(tenants).toEqual([]);
  });

  it("counts and aggregates cannot leak row existence either", async () => {
    const { count } = await asTenant(TENANT_A, async (c) =>
      (await c.query("select count(*)::int as count from calls")).rows[0],
    );

    expect(count).toBe(1);
  });

  // USING filters reads; WITH CHECK constrains writes. Without it a tenant could plant
  // a row under someone else's id — invisible to them afterwards, and a leak.
  it("refuses to insert a row stamped with another tenant's id", async () => {
    await expect(
      asTenant(TENANT_A, async (c) =>
        c.query(
          `insert into calls (tenant_id, carrier_call_id, dialled) values ($1, 'CA-evil', '+1')`,
          [TENANT_B],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot update another tenant's call", async () => {
    const result = await asTenant(TENANT_A, async (c) =>
      c.query("update calls set end_reason = 'tampered' where id = $1", [CALL_B]),
    );

    expect(result.rowCount).toBe(0);
  });

  it("cannot delete another tenant's call", async () => {
    const result = await asTenant(TENANT_A, async (c) =>
      c.query("delete from calls where id = $1", [CALL_B]),
    );

    expect(result.rowCount).toBe(0);
  });

  it("cannot reach another tenant's rows through a subquery", async () => {
    const rows = await asTenant(TENANT_A, async (c) =>
      (
        await c.query(
          "select * from calls where tenant_id in (select id from tenants where name = 'Tenant B')",
        )
      ).rows,
    );

    expect(rows).toEqual([]);
  });

  it("keeps every event-log table isolated, not just calls", async () => {
    const rows = await asTenant(TENANT_A, async (c) =>
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
    // by hand in the Supabase editor, and it had been red since `tenant_prompt_versions`
    // (0011) landed without it being updated — a red that says nothing about isolation.
    //
    // The core eight are named instead. That keeps the other thing the count was quietly
    // doing, which is proving the query returned something at all.
    for (const table of [
      "tenants",
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

  it("keeps one tenant's suppression list out of another's reach", async () => {
    const number = `+234900${Date.now() % 1000000}`;

    await asTenant(TENANT_A, async (c) => {
      await c.query(
        "insert into do_not_call (tenant_id, phone_number, reason) values ($1, $2, 'test')",
        [TENANT_A, number],
      );
    });

    const bSees = await asTenant(TENANT_B, async (c) =>
      (await c.query("select 1 from do_not_call where phone_number = $1", [number])).rows,
    );
    expect(bSees).toEqual([]);

    // The global case — tenant_id null, visible to everyone by design so a person need
    // not ask each tenant separately — is not covered here: inserting one needs the owner
    // role, which this suite connects as ansa_app precisely to avoid.
  });
});
