import { asOrganizationId } from "@ansa/shared";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDataSource } from "./data-source";
import { loadOnboardingFacts } from "./onboarding";
import { loadDotEnv } from "./test-env";
import { withOrganization } from "./organization-scope";

loadDotEnv();

/**
 * The operator's connection, used for one thing: putting a number in the organisation's
 * inventory.
 *
 * `ansa_app` has SELECT on `organization_numbers` and nothing else (migration 0019), so a
 * fixture running as the application role genuinely cannot assign itself a number — which
 * is the boundary working, not a test problem. Assigning one is an operator's job, and
 * this is the operator.
 */
const asOperator = async (
  work: (run: (sql: string, values?: readonly unknown[]) => Promise<unknown>) => Promise<void>,
): Promise<void> => {
  const operatorUrl = process.env["MIGRATION_DIRECT_URL"];
  if (operatorUrl === undefined) {
    throw new Error("MIGRATION_DIRECT_URL must be set: this fixture needs the operator role");
  }
  const { Client } = await import("pg");
  const client = new Client({ connectionString: operatorUrl });
  await client.connect();
  try {
    await work((sql, values) => client.query(sql, values === undefined ? [] : [...values]));
  } finally {
    await client.end();
  }
};

const seedNumber = async (organizationId: string, number: string): Promise<void> =>
  asOperator(async (run) => {
    await run(
      `insert into organization_numbers (organization_id, number)
       values ($1, $2) on conflict (number) do nothing`,
      [organizationId, number],
    );
  });

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
 * A organization id range no other integration test uses. These files share one database and run
 * in the same pass, and counting rows is exactly the assertion another file's fixtures
 * break. In use elsewhere: `11111111-…`/`22222222-…` in `rls.test.ts`,
 * `33333333-…`/`44444444-…` in `review.test.ts`, `55555555-…`/`66666666-…` in
 * `organization-scope.test.ts`, `77777777-…`/`88888888-…` in `organization-config.test.ts`.
 */
const A = asOrganizationId("99999999-9999-4999-8999-999999999999");
const B = asOrganizationId("9a9a9a9a-9a9a-49a9-89a9-9a9a9a9a9a9a");

const TOOL_CONFIG = {
  egress: { allowedHosts: ["api.organization.test"] },
  http: [
    {
      name: "check_policy",
      description: "Look a policy up",
      parameters: { type: "object", properties: {} },
      riskTier: "read",
      route: "http",
      url: "https://api.organization.test/policy",
      method: "GET",
      send: "query",
      credentialRef: "policy_api",
      speech: { template: "It is {status}.", fallback: "I could not find it." },
    },
  ],
};

let ds: DataSource;

/**
 * Torn down by the operator, not the application role, and that is not a shortcut.
 *
 * Deleting an organisation cascades into `organization_numbers`, which `ansa_app` may only
 * read (migration 0019). As the application role the final statement fails on permission,
 * and because `withOrganization` runs the whole teardown in one transaction, the deletes
 * before it roll back too — so nothing is cleaned and the next run counts the last run's
 * rows. It surfaced as a delivery count that grew by one each pass.
 *
 * `agents` is deleted explicitly ahead of the organisation: it holds a restricting foreign
 * key to `organization_numbers`, so leaving both to the same cascade is a race about which
 * side Postgres reaches first.
 */
const clear = async (): Promise<void> =>
  asOperator(async (run) => {
    for (const organization of [A, B]) {
      await run("delete from event_deliveries where organization_id = $1", [organization]);
      await run("delete from organization_credentials where organization_id = $1", [organization]);
      await run("delete from calls where organization_id = $1", [organization]);
      await run("delete from agents where organization_id = $1", [organization]);
      await run("delete from organization_numbers where organization_id = $1", [organization]);
      await run("delete from organizations where id = $1", [organization]);
    }
  });

beforeAll(async () => {
  ds = createDataSource({ url, poolSize: 4 });
  await ds.initialize();

  /* Dated a day out so the delivery sweeper cannot claim them.
     `app.claim_due_event_deliveries` takes any row with `status = 'pending'` and
     `next_attempt_at <= now()`, and the column defaults to `now()` — so an API process
     running on the same database would pick up this fixture's pending row, try to deliver
     it to a receiver that does not exist, and mark it failed. The test then reads three
     failures where it seeded two.

     That is what made this file look flaky: it passed or failed depending on whether
     anyone happened to have an API running locally, which is not a property a test should
     have. */

  // Before, as well as after. `event_deliveries` has a generated key and no natural one, so
  // a run interrupted before its cleanup would leave rows behind and the next run would
  // count them — a fixture that fails on the second attempt and passes on the first is
  // worse than one that fails always.
  await clear();

  // Organisation, then its number, then the agent that answers it. The order is the
  // product's: an operator assigns a number to an organisation that exists, and an agent
  // can only be routed a number its organisation already holds (migration 0019).
  await withOrganization(ds, A, async (scope) => {
    await scope.query(
      `insert into organizations (id, name, tool_config)
       values ($1, 'Readiness A', $2)
       on conflict (id) do nothing`,
      [A, JSON.stringify(TOOL_CONFIG)],
    );
  });

  await seedNumber(A, "+2348770000001");

  await withOrganization(ds, A, async (scope) => {
    await scope.query(
      `insert into agents (id, organization_id, name, greeting, voice_id, dialled_number)
       values ($1, $1, 'Readiness A', 'Good afternoon.', 'a-voice', '+2348770000001')
       -- Upsert, not do-nothing: these files share one database across runs, and a row
       -- left by a previous pass would otherwise silently keep its old values and make
       -- this assertion depend on what ran before it.
       on conflict (id) do update
          set greeting = excluded.greeting,
              voice_id = excluded.voice_id,
              dialled_number = excluded.dialled_number`,
      [A],
    );
    await scope.query(
      `insert into organization_credentials (organization_id, ref, sealed)
       values ($1, 'policy_api', 'v1.aaaa.bbbb.cccc') on conflict do nothing`,
      [A],
    );
    await scope.query(
      `insert into calls (organization_id, carrier_call_id, dialled) values ($1, 'CA-ready-a', '+2348770000001')
       on conflict do nothing`,
      [A],
    );
    for (const status of ["failed", "failed", "pending", "delivered"]) {
      await scope.query(
        `insert into event_deliveries
           (organization_id, event_type, subscription, body, status, next_attempt_at)
         values ($1, 'call.ended', 'crm', '{}', $2, now() + interval '1 day')`,
        [A, status],
      );
    }
  });

  await withOrganization(ds, B, async (scope) => {
    await scope.query(
      `insert into organizations (id, name) values ($1, 'Readiness B')
       on conflict (id) do nothing`,
      [B],
    );
  });

  await seedNumber(B, "+2348880000002");

  await withOrganization(ds, B, async (scope) => {
    // B exists to prove isolation, so it needs the same shape as A: a number it holds and
    // an agent answering it. Without the agent the readiness facts are all null, and the
    // test would pass for the wrong reason.
    await scope.query(
      `insert into agents (id, organization_id, name, dialled_number)
       values ($1, $1, 'Readiness B', '+2348880000002')
       on conflict (id) do update set dialled_number = excluded.dialled_number`,
      [B],
    );
    await scope.query(
      `insert into calls (organization_id, carrier_call_id, dialled) values ($1, 'CA-ready-b', '+2348880000002')
       on conflict do nothing`,
      [B],
    );
    await scope.query(
      `insert into event_deliveries
         (organization_id, event_type, subscription, body, status, next_attempt_at)
       values ($1, 'call.ended', 'theirs', '{}', 'failed', now() + interval '1 day')`,
      [B],
    );
    await scope.query(
      `insert into organization_credentials (organization_id, ref, sealed)
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
    const facts = await withOrganization(ds, A, loadOnboardingFacts);
    expect(facts).toMatchObject({
      organisationName: "Readiness A",
      dialledNumber: "+2348770000001",
      greeting: "Good afternoon.",
      voiceId: "a-voice",
    });
  });

  /** Names, never the ciphertext beside them. A yes/no question does not need the secret. */
  it("reads credential reference names and no sealed values", async () => {
    const facts = await withOrganization(ds, A, loadOnboardingFacts);
    expect(facts?.credentialRefs).toEqual(["policy_api"]);
    expect(JSON.stringify(facts)).not.toContain("v1.aaaa");
  });

  it("hands the tool document back unparsed, for readiness to parse as config load does", async () => {
    const facts = await withOrganization(ds, A, loadOnboardingFacts);
    expect(facts?.toolConfig).toMatchObject({ http: [{ name: "check_policy" }] });
    expect(facts?.eventConfig).toBeNull();
  });

  /**
   * Numbers, not strings. The driver returns a bigint as text, and `"0" > 0` is false
   * while `Number("0") > 0` is also false — but `"0"` is truthy, which is the shape of the
   * bug this cast exists to prevent.
   */
  it("counts calls and deliveries as numbers", async () => {
    const facts = await withOrganization(ds, A, loadOnboardingFacts);
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
    const forB = await withOrganization(ds, B, loadOnboardingFacts);
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
    const facts = await withOrganization(ds, A, loadOnboardingFacts);
    expect(facts?.businessHours).toBeNull();
  });
});
