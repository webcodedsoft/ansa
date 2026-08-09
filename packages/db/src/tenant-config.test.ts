import { asTenantId } from "@ansa/shared";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDataSource } from "./data-source";
import {
  listTenantConfigVersions,
  loadConfigVersionForCall,
  loadCurrentTenantConfig,
  loadTenantConfigVersion,
  publishTenantConfig,
  type TenantConfigFields,
} from "./tenant-config";
import { loadDotEnv } from "./test-env";
import { withTenant } from "./tenant-scope";

loadDotEnv();

const url = process.env["DIRECT_URL"];
if (url === undefined) throw new Error("DIRECT_URL must be set: this test needs a database");

/**
 * Configuration history, against a real database, including the two questions no unit test
 * can answer: does `publish_tenant_config` actually leave a readable snapshot behind, and
 * can one organisation reach another's.
 *
 * The second is not a formality. Every function here is reached from a dashboard endpoint
 * where the version number and the call id come off the URL, and a version number is a small
 * integer that anybody can guess. RLS is what makes guessing pointless; this is the test that
 * says so out loud.
 *
 * One tenant id range per file, for the reason `tenant-scope.test.ts` records: these files
 * share one database and one pass, and a shared fixture reads as a leak. In use elsewhere:
 * `1…`/`2…` in `rls.test.ts`, `3…`/`4…` in `review.test.ts`, `5…`/`6…` in
 * `tenant-scope.test.ts`.
 */
const A = asTenantId("77777777-7777-4777-8777-777777777777");
const B = asTenantId("88888888-8888-4888-8888-888888888888");

/**
 * A call answered on the tenant row's starting `config_version`, which has no snapshot behind
 * it — the tenant was inserted after migration 0011 ran, so nothing backfilled version 1.
 * That is the honest shape of every call answered before an organisation first published, and
 * the trace has to report it rather than 404.
 */
const UNVERSIONED_CALL = "77777777-7777-4777-8777-aaaaaaaaaaaa";

let ds: DataSource;

const fields = (overrides: Partial<TenantConfigFields> = {}): TenantConfigFields => ({
  name: "Test Organisation",
  voiceId: null,
  greeting: null,
  persona: null,
  instructions: null,
  keyterms: [],
  businessHours: null,
  escalation: null,
  ...overrides,
});

beforeAll(async () => {
  ds = createDataSource({ url, poolSize: 4 });
  await ds.initialize();

  for (const [tenant, label] of [
    [A, "A"],
    [B, "B"],
  ] as const) {
    await withTenant(ds, tenant, async (scope) => {
      await scope.query("insert into tenants (id, name) values ($1, $2) on conflict do nothing", [
        tenant,
        `Config tenant ${label}`,
      ]);
    });
  }

  await withTenant(ds, A, async (scope) => {
    await scope.query(
      `insert into calls (id, tenant_id, carrier_call_id, dialled, config_version)
            values ($1, $2, 'CA-config-a', '+1', (select config_version from tenants where id = $2))
       on conflict do nothing`,
      [UNVERSIONED_CALL, A],
    );
  });
});

afterAll(async () => {
  for (const tenant of [A, B]) {
    await withTenant(ds, tenant, async (scope) => {
      await scope.query("delete from calls where tenant_id = $1", [tenant]);
      // `tenant_prompt_versions` cascades from this, which is the only way to remove a row
      // from an append-only table without granting a DELETE nothing should hold.
      await scope.query("delete from tenants where id = $1", [tenant]);
    });
  }
  await ds.destroy();
});

describe("publishing a version", () => {
  it("bumps the version and leaves a snapshot that can be read back", async () => {
    const published = await withTenant(ds, A, (scope) =>
      publishTenantConfig(
        scope,
        fields({
          greeting: "Good afternoon.",
          keyterms: ["Renewal Notice"],
          businessHours: { opensAtHour: 9, closesAtHour: 17, openDays: [1, 2, 3, 4, 5] },
          escalation: { toNumber: "+2348000000001", fromNumber: "+2348000000002", ringSeconds: 30 },
        }),
        "opening hours and a transfer target",
      ),
    );

    const current = await withTenant(ds, A, (scope) => loadCurrentTenantConfig(scope));
    expect(current?.version).toBe(published);
    expect(current?.config.greeting).toBe("Good afternoon.");
    expect(current?.published?.note).toBe("opening hours and a transfer target");

    const snapshot = await withTenant(ds, A, (scope) =>
      loadTenantConfigVersion(scope, published),
    );
    expect(snapshot?.config).toEqual(current?.config);
    expect(snapshot?.config.businessHours).toEqual({
      opensAtHour: 9,
      closesAtHour: 17,
      openDays: [1, 2, 3, 4, 5],
    });
    expect(snapshot?.config.escalation).toEqual({
      toNumber: "+2348000000001",
      fromNumber: "+2348000000002",
      ringSeconds: 30,
    });
  });

  /**
   * The failure this guards against is silent and expensive: `publish_tenant_config` writes
   * what it is given and nulls what it is not, so a dashboard that cannot express tool
   * configuration would delete it on every publish. Nobody would notice until a caller was
   * told the agent could not look something up.
   */
  it("carries tool and event configuration forward rather than clearing it", async () => {
    const configured = { egress: { allowedHosts: ["api.invalid.test"] }, http: [] };
    await withTenant(ds, A, async (scope) => {
      await scope.query("update tenants set tool_config = $1 where id = $2", [
        JSON.stringify(configured),
        A,
      ]);
    });

    await withTenant(ds, A, (scope) =>
      publishTenantConfig(scope, fields(), "a publish that says nothing about tools"),
    );

    const after = await withTenant(ds, A, (scope) =>
      scope.query<{ tool_config: unknown }>("select tool_config from tenants limit 1"),
    );
    expect(after[0]?.tool_config).toEqual(configured);
  });

  it("is whole rather than a patch: a field left out is a field cleared", async () => {
    const current = await withTenant(ds, A, (scope) => loadCurrentTenantConfig(scope));
    // The greeting published by the first case is gone, because the second case did not
    // repeat it. That is the contract, and it is why every field in the request body is
    // required rather than optional.
    expect(current?.config.greeting).toBeNull();
  });
});

describe("the history", () => {
  it("is newest first and pages without repeating a row", async () => {
    const first = await withTenant(ds, A, (scope) =>
      listTenantConfigVersions(scope, { limit: 1, after: null }),
    );
    expect(first.items).toHaveLength(1);
    expect(first.next).not.toBeNull();

    const second = await withTenant(ds, A, (scope) =>
      listTenantConfigVersions(scope, { limit: 1, after: first.next }),
    );
    const [newest] = first.items;
    const [older] = second.items;
    expect(newest?.version).toBeGreaterThan(older?.version ?? Number.MAX_SAFE_INTEGER);
  });

  it("records why, not only what", async () => {
    const page = await withTenant(ds, A, (scope) =>
      listTenantConfigVersions(scope, { limit: 10, after: null }),
    );
    for (const version of page.items) {
      expect(version.note).not.toBeNull();
      expect(version.publishedBy).not.toBe("");
    }
  });
});

describe("tracing a call to the configuration that served it", () => {
  it("answers with the snapshot, not just the number", async () => {
    const version = await withTenant(ds, A, (scope) =>
      publishTenantConfig(scope, fields({ greeting: "Traced." }), "for the trace"),
    );

    const callId = "77777777-7777-4777-8777-bbbbbbbbbbbb";
    await withTenant(ds, A, async (scope) => {
      await scope.query(
        `insert into calls (id, tenant_id, carrier_call_id, dialled, config_version)
              values ($1, $2, 'CA-config-traced', '+1', $3) on conflict do nothing`,
        [callId, A, version],
      );
    });

    const trace = await withTenant(ds, A, (scope) => loadConfigVersionForCall(scope, callId));
    expect(trace?.configVersion).toBe(version);
    expect(trace?.version?.config.greeting).toBe("Traced.");
  });

  /**
   * A version with nothing behind it is the exact gap migration 0011 closed, and it survives
   * on every call answered before an organisation first published. Reported as a null
   * snapshot beside a real version number, because collapsing it into 404 would say the call
   * does not exist — and collapsing it into an empty configuration would be a guess.
   */
  it("reports a version with no snapshot as such, rather than as a missing call", async () => {
    const trace = await withTenant(ds, A, (scope) =>
      loadConfigVersionForCall(scope, UNVERSIONED_CALL),
    );
    expect(trace?.callId).toBe(UNVERSIONED_CALL);
    expect(trace?.configVersion).not.toBeNull();
    expect(trace?.version).toBeNull();
  });
});

describe("one organisation reaching for another's", () => {
  it("cannot read a version number it does not own", async () => {
    const mine = await withTenant(ds, A, (scope) =>
      listTenantConfigVersions(scope, { limit: 1, after: null }),
    );
    const version = mine.items[0]?.version;
    expect(version).toBeDefined();

    // The same integer, asked for by the other organisation. A version number is small and
    // guessable, which is why nothing here compares it to anything: the row is not visible.
    expect(
      await withTenant(ds, B, (scope) => loadTenantConfigVersion(scope, version ?? 1)),
    ).toBeNull();
  });

  it("sees no history at all before it has published", async () => {
    const page = await withTenant(ds, B, (scope) =>
      listTenantConfigVersions(scope, { limit: 50, after: null }),
    );
    expect(page.items).toEqual([]);
  });

  it("cannot trace a call it did not take", async () => {
    expect(
      await withTenant(ds, B, (scope) => loadConfigVersionForCall(scope, UNVERSIONED_CALL)),
    ).toBeNull();
  });

  it("reads its own configuration, and only its own", async () => {
    const current = await withTenant(ds, B, (scope) => loadCurrentTenantConfig(scope));
    expect(current?.config.name).toBe("Config tenant B");
  });
});
