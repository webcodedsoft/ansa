import { asTenantId } from "@ansa/shared";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDataSource } from "./data-source";
import { loadOnboardingFacts } from "./onboarding";
import { loadDotEnv } from "./test-env";
import { withTenant } from "./tenant-scope";

loadDotEnv();

const url = process.env["DIRECT_URL"];
if (url === undefined) throw new Error("DIRECT_URL must be set: this test needs a database");

/**
 * Against a real database, because the whole value of this function is its SQL.
 *
 * A unit test with a fake scope would prove the field names and nothing else, and every
 * defect this query can have — a filtered aggregate that does not cast, a column that
 * migration 0012 has not created, a count coming back as a string that compares `> 0` as
 * true for "0" — lives in the part a fake would have replaced.
 *
 * It also asserts the isolation the dashboard depends on: a readiness report is built from
 * four unqualified queries, and the only thing keeping them to one organisation is RLS.
 *
 * A tenant id range no other integration test uses. These files share one database and run
 * in the same pass, and counting rows is exactly the assertion another file's fixtures
 * break. In use elsewhere: `11111111-…`/`22222222-…` in `rls.test.ts`,
 * `33333333-…`/`44444444-…` in `review.test.ts`, `55555555-…`/`66666666-…` in
 * `tenant-scope.test.ts`, `77777777-…`/`88888888-…` in `tenant-config.test.ts`.
 */
const A = asTenantId("99999999-9999-4999-8999-999999999999");
const B = asTenantId("9a9a9a9a-9a9a-49a9-89a9-9a9a9a9a9a9a");

const TOOL_CONFIG = {
  egress: { allowedHosts: ["api.tenant.test"] },
  http: [
    {
      name: "check_policy",
      description: "Look a policy up",
      parameters: { type: "object", properties: {} },
      riskTier: "read",
      route: "http",
      url: "https://api.tenant.test/policy",
      method: "GET",
      send: "query",
      credentialRef: "policy_api",
      speech: { template: "It is {status}.", fallback: "I could not find it." },
    },
  ],
};

let ds: DataSource;

const clear = async (): Promise<void> => {
  for (const tenant of [A, B]) {
    await withTenant(ds, tenant, async (scope) => {
      await scope.query("delete from event_deliveries where tenant_id = $1", [tenant]);
      await scope.query("delete from tenant_credentials where tenant_id = $1", [tenant]);
      await scope.query("delete from calls where tenant_id = $1", [tenant]);
      await scope.query("delete from tenants where id = $1", [tenant]);
    });
  }
};

beforeAll(async () => {
  ds = createDataSource({ url, poolSize: 4 });
  await ds.initialize();

  // Before, as well as after. `event_deliveries` has a generated key and no natural one, so
  // a run interrupted before its cleanup would leave rows behind and the next run would
  // count them — a fixture that fails on the second attempt and passes on the first is
  // worse than one that fails always.
  await clear();

  await withTenant(ds, A, async (scope) => {
    await scope.query(
      `insert into tenants (id, name, dialled_number, greeting, voice_id, tool_config)
       values ($1, 'Readiness A', '+2348770000001', 'Good afternoon.', 'a-voice', $2)
       on conflict (id) do nothing`,
      [A, JSON.stringify(TOOL_CONFIG)],
    );
    await scope.query(
      `insert into tenant_credentials (tenant_id, ref, sealed)
       values ($1, 'policy_api', 'v1.aaaa.bbbb.cccc') on conflict do nothing`,
      [A],
    );
    await scope.query(
      `insert into calls (tenant_id, carrier_call_id, dialled) values ($1, 'CA-ready-a', '+2348770000001')
       on conflict do nothing`,
      [A],
    );
    for (const status of ["failed", "failed", "pending", "delivered"]) {
      await scope.query(
        `insert into event_deliveries (tenant_id, event_type, subscription, body, status)
         values ($1, 'call.ended', 'crm', '{}', $2)`,
        [A, status],
      );
    }
  });

  await withTenant(ds, B, async (scope) => {
    await scope.query(
      `insert into tenants (id, name, dialled_number) values ($1, 'Readiness B', '+2348880000002')
       on conflict (id) do nothing`,
      [B],
    );
    await scope.query(
      `insert into calls (tenant_id, carrier_call_id, dialled) values ($1, 'CA-ready-b', '+2348880000002')
       on conflict do nothing`,
      [B],
    );
    await scope.query(
      `insert into event_deliveries (tenant_id, event_type, subscription, body, status)
       values ($1, 'call.ended', 'theirs', '{}', 'failed')`,
      [B],
    );
    await scope.query(
      `insert into tenant_credentials (tenant_id, ref, sealed)
       values ($1, 'their_secret', 'v1.aaaa.bbbb.cccc') on conflict do nothing`,
      [B],
    );
  });
});

afterAll(async () => {
  await clear();
  await ds.destroy();
});

describe("the onboarding facts", () => {
  it("reads the organisation's own row without naming it", async () => {
    const facts = await withTenant(ds, A, loadOnboardingFacts);
    expect(facts).toMatchObject({
      organisationName: "Readiness A",
      dialledNumber: "+2348770000001",
      greeting: "Good afternoon.",
      voiceId: "a-voice",
    });
  });

  /** Names, never the ciphertext beside them. A yes/no question does not need the secret. */
  it("reads credential reference names and no sealed values", async () => {
    const facts = await withTenant(ds, A, loadOnboardingFacts);
    expect(facts?.credentialRefs).toEqual(["policy_api"]);
    expect(JSON.stringify(facts)).not.toContain("v1.aaaa");
  });

  it("hands the tool document back unparsed, for readiness to parse as config load does", async () => {
    const facts = await withTenant(ds, A, loadOnboardingFacts);
    expect(facts?.toolConfig).toMatchObject({ http: [{ name: "check_policy" }] });
    expect(facts?.eventConfig).toBeNull();
  });

  /**
   * Numbers, not strings. The driver returns a bigint as text, and `"0" > 0` is false
   * while `Number("0") > 0` is also false — but `"0"` is truthy, which is the shape of the
   * bug this cast exists to prevent.
   */
  it("counts calls and deliveries as numbers", async () => {
    const facts = await withTenant(ds, A, loadOnboardingFacts);
    expect(facts?.callsReceived).toBe(1);
    expect(facts?.failedDeliveries).toBe(2);
    expect(facts?.pendingDeliveries).toBe(1);
    expect(typeof facts?.callsReceived).toBe("number");
    expect(facts?.lastCallAt).not.toBeNull();
  });

  /**
   * Four unqualified queries, and the only thing holding them to one organisation is RLS.
   * B has its own call, its own failed delivery and its own credential; none of them may
   * appear in A's report, and A's may not appear in B's.
   */
  it("shows each organisation only its own facts", async () => {
    const forB = await withTenant(ds, B, loadOnboardingFacts);
    expect(forB).toMatchObject({
      organisationName: "Readiness B",
      dialledNumber: "+2348880000002",
      callsReceived: 1,
      failedDeliveries: 1,
    });
    expect(forB?.credentialRefs).toEqual(["their_secret"]);
    expect(forB?.greeting).toBeNull();
  });

  it("reads business hours as unset rather than as a partial row", async () => {
    const facts = await withTenant(ds, A, loadOnboardingFacts);
    expect(facts?.businessHours).toBeNull();
  });
});
