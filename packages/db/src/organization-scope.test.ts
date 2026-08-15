import { asOrganizationId, type OrganizationId } from "@ansa/shared";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDataSource } from "./data-source";
import { loadDotEnv } from "./test-env";
import { withOrganization } from "./organization-scope";

loadDotEnv();

const url = process.env["DIRECT_URL"];
if (url === undefined) throw new Error("DIRECT_URL must be set: this test needs a database");

/**
 * A organization id no other integration test uses.
 *
 * These files share one database and run in the same pass, and this test asserts an exact
 * row list: "organization A sees precisely the calls organization A created". It shared
 * `33333333-…`/`44444444-…` with `review.test.ts`, so on a full-suite run it saw that
 * file's rows and read its own correct isolation as a leak. RLS was never wrong — the
 * fixture was. One id range per file is what keeps the assertion meaningful.
 *
 * In use elsewhere: `11111111-…`/`22222222-…` in `rls.test.ts`, `33333333-…`/`44444444-…`
 * in `review.test.ts`.
 */
const A = asOrganizationId("55555555-5555-4555-8555-555555555555");
const B = asOrganizationId("66666666-6666-4666-8666-666666666666");

let ds: DataSource;

const seed = async (organization: typeof A, sid: string): Promise<void> => {
  await withOrganization(ds, organization, async (s) => {
    await s.query("insert into organizations (id, name) values ($1, $2) on conflict do nothing", [
      organization,
      `Organization ${sid}`,
    ]);
    await s.query(
      `insert into calls (organization_id, carrier_call_id, dialled) values ($1, $2, '+1')
       on conflict do nothing`,
      [organization, sid],
    );
  });
};

beforeAll(async () => {
  ds = createDataSource({ url, poolSize: 4 });
  await ds.initialize();
  await seed(A, "CA-scope-a");
  await seed(B, "CA-scope-b");
});

afterAll(async () => {
  for (const t of [A, B]) {
    await withOrganization(ds, t, async (s) => {
      await s.query("delete from calls where organization_id = $1", [t]);
      await s.query("delete from organizations where id = $1", [t]);
    });
  }
  await ds.destroy();
});

describe("withOrganization", () => {
  it("scopes reads to the organization it was given", async () => {
    const rows = await withOrganization(ds, A, async (s) =>
      s.query<{ carrier_call_id: string }>("select carrier_call_id from calls"),
    );

    expect(rows.map((r) => r.carrier_call_id)).toEqual(["CA-scope-a"]);
  });

  it("commits work that succeeds", async () => {
    await withOrganization(ds, A, async (s) => {
      await s.query("update calls set end_reason = 'committed' where organization_id = $1", [A]);
    });

    const rows = await withOrganization(ds, A, async (s) =>
      s.query<{ end_reason: string }>("select end_reason from calls"),
    );
    expect(rows[0]?.end_reason).toBe("committed");
  });

  it("rolls back work that throws, and re-raises the original error", async () => {
    await expect(
      withOrganization(ds, A, async (s) => {
        await s.query("update calls set end_reason = 'should not persist' where organization_id = $1", [A]);
        throw new Error("deliberate failure");
      }),
    ).rejects.toThrow("deliberate failure");

    const rows = await withOrganization(ds, A, async (s) =>
      s.query<{ end_reason: string }>("select end_reason from calls"),
    );
    expect(rows[0]?.end_reason).toBe("committed");
  });

  // The leak this design exists to prevent: SET LOCAL must not survive the connection
  // going back to the pool, or the next caller inherits someone else's organization.
  it("does not leak organization context onto the pooled connection", async () => {
    await withOrganization(ds, A, async (s) => {
      await s.query("select 1");
    });

    const runner = ds.createQueryRunner();
    await runner.connect();
    try {
      const [{ organization }] = (await runner.query(
        "select current_setting('app.organization_id', true) as organization",
      )) as [{ organization: string | null }];
      // Empty or null, never A.
      expect(organization === null || organization === "").toBe(true);

      const rows = (await runner.query("select * from calls")) as unknown[];
      expect(rows).toEqual([]);
    } finally {
      await runner.release();
    }
  });

  // With a pool, two organizations are genuinely in flight at once. If context were set at
  // session level rather than per transaction, this is where it would cross over.
  it("keeps concurrent organizations apart", async () => {
    const runs = await Promise.all([
      withOrganization(ds, A, async (s) => {
        await s.query("select pg_sleep(0.15)");
        return s.query<{ carrier_call_id: string }>("select carrier_call_id from calls");
      }),
      withOrganization(ds, B, async (s) => s.query<{ carrier_call_id: string }>("select carrier_call_id from calls")),
      withOrganization(ds, A, async (s) => s.query<{ carrier_call_id: string }>("select carrier_call_id from calls")),
    ]);

    expect(runs.map((r) => r.map((x) => x.carrier_call_id))).toEqual([
      ["CA-scope-a"],
      ["CA-scope-b"],
      ["CA-scope-a"],
    ]);
  });

  it("rejects a organization id that is not a uuid, before touching the database", async () => {
    let ran = false;
    await expect(
      // Simulates an unvalidated value arriving from outside TypeScript's reach — a
      // webhook body, a URL segment — which is the only way this can actually happen.
      withOrganization(ds, "'; drop table calls; --" as unknown as OrganizationId, async () => {
        ran = true;
      }),
    ).rejects.toThrow(/not a valid organization id/i);
    expect(ran).toBe(false);
  });

  it("returns connections to the pool rather than exhausting it", async () => {
    // More iterations than the pool size: a leaked runner would hang here.
    for (let i = 0; i < 12; i += 1) {
      await withOrganization(ds, A, async (s) => s.query("select 1"));
    }
    await expect(withOrganization(ds, A, async (s) => s.query("select 1"))).resolves.toBeDefined();
  });

  it("releases the connection even when the work throws", async () => {
    for (let i = 0; i < 8; i += 1) {
      await expect(
        withOrganization(ds, A, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    }
    await expect(withOrganization(ds, A, async (s) => s.query("select 1"))).resolves.toBeDefined();
  });
});
