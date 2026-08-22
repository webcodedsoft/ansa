import { asOrganizationId } from "@ansa/shared";
import { Client } from "pg";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDataSource } from "./data-source";
import {
  listAgentConfigVersions,
  loadConfigVersionForCall,
  loadCurrentAgentConfig,
  loadAgentConfigVersion,
  publishAgentConfig,
  type AgentConfigFields,
} from "./organization-config";
import { loadDotEnv } from "./test-env";
import { liveAgentId } from "./drafts";
import { withOrganization, type OrganizationScope } from "./organization-scope";

/**
 * The fixture's agent, resolved inside the scope the call is already in.
 *
 * These functions used to take only a scope and let the database pick the organisation's
 * oldest live agent. They name their agent now, so every call site has to say which — and in
 * a fixture with one agent, saying which means asking. `liveAgentId` raises on two rather
 * than picking, so a suite that grows a second agent fails here rather than somewhere
 * confusing.
 */
const theAgent = async (scope: OrganizationScope): Promise<string> => {
  const id = await liveAgentId(scope);
  if (id === null) throw new Error("the fixture has no live agent");
  return id;
};

loadDotEnv();

const url = process.env["DIRECT_URL"];
if (url === undefined) throw new Error("DIRECT_URL must be set: this test needs a database");

/**
 * Configuration history, against a real database, including the two questions no unit test
 * can answer: does `publish_organization_config` actually leave a readable snapshot behind, and
 * can one organisation reach another's.
 *
 * The second is not a formality. Every function here is reached from a dashboard endpoint
 * where the version number and the call id come off the URL, and a version number is a small
 * integer that anybody can guess. RLS is what makes guessing pointless; this is the test that
 * says so out loud.
 *
 * One organization id range per file, for the reason `organization-scope.test.ts` records: these files
 * share one database and one pass, and a shared fixture reads as a leak. In use elsewhere:
 * `1…`/`2…` in `rls.test.ts`, `3…`/`4…` in `review.test.ts`, `5…`/`6…` in
 * `organization-scope.test.ts`.
 */
const A = asOrganizationId("77777777-7777-4777-8777-777777777777");
const B = asOrganizationId("88888888-8888-4888-8888-888888888888");

/**
 * A call answered on the organization row's starting `config_version`, which has no snapshot behind
 * it — the organization was inserted after migration 0011 ran, so nothing backfilled version 1.
 * That is the honest shape of every call answered before an organisation first published, and
 * the trace has to report it rather than 404.
 */
const UNVERSIONED_CALL = "77777777-7777-4777-8777-aaaaaaaaaaaa";

let ds: DataSource;

const fields = (overrides: Partial<AgentConfigFields> = {}): AgentConfigFields => ({
  name: "Test Organisation",
  voiceId: null,
  speakingRate: null,
  greeting: null,
  persona: null,
  instructions: null,
  // Null is "they wrote none", which is every organisation until one does.
  policyBlocks: null,
  keyterms: [],
  businessHours: null,
  escalation: null,
  ...overrides,
});

beforeAll(async () => {
  ds = createDataSource({ url, poolSize: 4 });
  await ds.initialize();

  for (const [organization, label] of [
    [A, "A"],
    [B, "B"],
  ] as const) {
    await withOrganization(ds, organization, async (scope) => {
      await scope.query("insert into organizations (id, name) values ($1, $2) on conflict do nothing", [
        organization,
        `Config organization ${label}`,
      ]);
      // Explicitly, because migration 0025 removed the trigger that used to create one.
      // An organisation with no agent is now a real state — it is what a new sign-up looks
      // like before somebody creates their first — and publishing into it is refused. The
      // fixture creates the agent for the same reason the console will: on purpose.
      await scope.query(
        `insert into agents (id, organization_id, name)
         values ($1, $1, $2) on conflict do nothing`,
        [organization, `Config organization ${label}`],
      );
    });
  }

  await withOrganization(ds, A, async (scope) => {
    await scope.query(
      `insert into calls (id, organization_id, carrier_call_id, dialled, config_version)
            values ($1, $2, 'CA-config-a', '+1', (select config_version from agents where organization_id = $2 limit 1))
       on conflict do nothing`,
      [UNVERSIONED_CALL, A],
    );
  });
});

afterAll(async () => {
  for (const organization of [A, B]) {
    await withOrganization(ds, organization, async (scope) => {
      await scope.query("delete from calls where organization_id = $1", [organization]);
      // `agent_prompt_versions` cascades from this, which is the only way to remove a row
      // from an append-only table without granting a DELETE nothing should hold.
      await scope.query("delete from organizations where id = $1", [organization]);
    });
  }
  await ds.destroy();
});

describe("publishing a version", () => {
  it("bumps the version and leaves a snapshot that can be read back", async () => {
    const published = await withOrganization(ds, A, async (scope) =>
      publishAgentConfig(
        scope,
        await theAgent(scope),
        fields({
          greeting: "Good afternoon.",
          keyterms: ["Renewal Notice"],
          businessHours: { opensAtHour: 9, closesAtHour: 17, openDays: [1, 2, 3, 4, 5] },
          escalation: { toNumber: "+2348000000001", fromNumber: "+2348000000002", ringSeconds: 30 },
        }),
        "opening hours and a transfer target",
      ),
    );

    const current = await withOrganization(ds, A, async (scope) => loadCurrentAgentConfig(scope, await theAgent(scope)));
    expect(current?.version).toBe(published);
    expect(current?.config.greeting).toBe("Good afternoon.");
    expect(current?.published?.note).toBe("opening hours and a transfer target");

    const snapshot = await withOrganization(ds, A, async (scope) =>
      loadAgentConfigVersion(scope, await theAgent(scope), published),
    );
    // Everything the snapshot does carry matches what is live, except the hours.
    expect(snapshot?.config.greeting).toEqual(current?.config.greeting);
    expect(snapshot?.config.keyterms).toEqual(current?.config.keyterms);

    /* Opening hours are the organisation's since migration 0027, and the organisation is
       not versioned — so an agent's snapshot does not carry them, and says null rather
       than reporting today's hours as though they were that version's. The live read gets
       them from the organisation, which is why `current` has them and this does not.

       That is a real loss: a call from three weeks ago can no longer be explained in terms
       of the hours it ran under. Versioning the organisation is the fix, and it is not
       built. Asserted here so the gap is a decision on the record rather than a surprise. */
    expect(snapshot?.config.businessHours).toBeNull();
    expect(current?.config.businessHours).toEqual({
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
   * The failure this guards against is silent and expensive: `publish_organization_config` writes
   * what it is given and nulls what it is not, so a dashboard that cannot express tool
   * configuration would delete it on every publish. Nobody would notice until a caller was
   * told the agent could not look something up.
   */
  it("carries tool and event configuration forward rather than clearing it", async () => {
    const configured = { egress: { allowedHosts: ["api.invalid.test"] }, http: [] };
    await withOrganization(ds, A, async (scope) => {
      await scope.query("update organizations set tool_config = $1 where id = $2", [
        JSON.stringify(configured),
        A,
      ]);
    });

    await withOrganization(ds, A, async (scope) =>
      publishAgentConfig(scope, await theAgent(scope), fields(), "a publish that says nothing about tools"),
    );

    const after = await withOrganization(ds, A, (scope) =>
      scope.query<{ tool_config: unknown }>("select tool_config from organizations limit 1"),
    );
    expect(after[0]?.tool_config).toEqual(configured);
  });

  it("is whole rather than a patch: a field left out is a field cleared", async () => {
    const current = await withOrganization(ds, A, async (scope) => loadCurrentAgentConfig(scope, await theAgent(scope)));
    // The greeting published by the first case is gone, because the second case did not
    // repeat it. That is the contract, and it is why every field in the request body is
    // required rather than optional.
    expect(current?.config.greeting).toBeNull();
  });
});

describe("the history", () => {
  it("is newest first, and page two carries on where page one stopped", async () => {
    const first = await withOrganization(ds, A, async (scope) =>
      listAgentConfigVersions(scope, await theAgent(scope), { limit: 1, offset: 0 }),
    );
    expect(first.items).toHaveLength(1);
    // The total counts every version, not the one row on this page — that is the whole
    // reason offset paging can say how many pages there are.
    expect(first.total).toBeGreaterThan(1);

    const second = await withOrganization(ds, A, async (scope) =>
      listAgentConfigVersions(scope, await theAgent(scope), { limit: 1, offset: 1 }),
    );
    const [newest] = first.items;
    const [older] = second.items;
    expect(newest?.version).toBeGreaterThan(older?.version ?? Number.MAX_SAFE_INTEGER);
    expect(second.total).toBe(first.total);
  });

  it("records why, not only what", async () => {
    const page = await withOrganization(ds, A, async (scope) =>
      listAgentConfigVersions(scope, await theAgent(scope), { limit: 10, offset: 0 }),
    );
    for (const version of page.items) {
      expect(version.note).not.toBeNull();
      expect(version.publishedBy).not.toBe("");
    }
  });
});

describe("tracing a call to the configuration that served it", () => {
  it("answers with the snapshot, not just the number", async () => {
    const version = await withOrganization(ds, A, async (scope) =>
      publishAgentConfig(scope, await theAgent(scope), fields({ greeting: "Traced." }), "for the trace"),
    );

    const callId = "77777777-7777-4777-8777-bbbbbbbbbbbb";
    await withOrganization(ds, A, async (scope) => {
      await scope.query(
        `insert into calls (id, organization_id, carrier_call_id, dialled, config_version)
              values ($1, $2, 'CA-config-traced', '+1', $3) on conflict do nothing`,
        [callId, A, version],
      );
    });

    const trace = await withOrganization(ds, A, (scope) => loadConfigVersionForCall(scope, callId));
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
    const trace = await withOrganization(ds, A, (scope) =>
      loadConfigVersionForCall(scope, UNVERSIONED_CALL),
    );
    expect(trace?.callId).toBe(UNVERSIONED_CALL);
    expect(trace?.configVersion).not.toBeNull();
    expect(trace?.version).toBeNull();
  });
});

describe("one organisation reaching for another's", () => {
  it("cannot read a version number it does not own", async () => {
    const mine = await withOrganization(ds, A, async (scope) =>
      listAgentConfigVersions(scope, await theAgent(scope), { limit: 1, offset: 0 }),
    );
    const version = mine.items[0]?.version;
    expect(version).toBeDefined();

    // The same integer, asked for by the other organisation. A version number is small and
    // guessable, which is why nothing here compares it to anything: the row is not visible.
    expect(
      await withOrganization(ds, B, async (scope) => loadAgentConfigVersion(scope, await theAgent(scope), version ?? 1)),
    ).toBeNull();
  });

  it("sees no history at all before it has published", async () => {
    const page = await withOrganization(ds, B, async (scope) =>
      listAgentConfigVersions(scope, await theAgent(scope), { limit: 50, offset: 0 }),
    );
    expect(page.items).toEqual([]);
  });

  it("cannot trace a call it did not take", async () => {
    expect(
      await withOrganization(ds, B, (scope) => loadConfigVersionForCall(scope, UNVERSIONED_CALL)),
    ).toBeNull();
  });

  it("reads its own configuration, and only its own", async () => {
    const current = await withOrganization(ds, B, async (scope) => loadCurrentAgentConfig(scope, await theAgent(scope)));
    expect(current?.config.name).toBe("Config organization B");
  });
});

describe("policies a screen cannot edit", () => {
  /**
   * The console publishes the whole document and has no policy editor. If a publish with no
   * policies in it overwrote, the first save from that screen would silently delete rules
   * somebody authored through the API — so null means "leave them alone" and an empty array
   * means "there are none", the same distinction `agent_config_drafts` already draws.
   */
  const livePolicies = async (): Promise<unknown> => {
    const rows = await withOrganization(ds, A, (scope) =>
      /* The same agent `publish_agent_config` picks — the oldest live one. An unordered
         `limit 1` reads whichever row the planner returns, which is how this first read
         came back null against a row that had just been written. */
      scope.query<{ policy_blocks: unknown }>(
        "select policy_blocks from agents where deleted_at is null order by created_at, id limit 1",
      ),
    );
    return rows[0]?.policy_blocks ?? null;
  };

  const withPolicies = [
    { name: "Refunds", applies: "money back", canDo: ["log it"], cannotDo: ["approve it"], escalateWhen: [] },
  ];

  it("stores and returns them", async () => {
    await withOrganization(ds, A, async (scope) =>
      publishAgentConfig(scope, await theAgent(scope), fields({ policyBlocks: withPolicies }), "with policies"),
    );
    expect(await livePolicies()).toEqual(withPolicies);
  });

  it("leaves them alone when a publish omits them", async () => {
    // The console's publish, which cannot see them.
    await withOrganization(ds, A, async (scope) =>
      publishAgentConfig(scope, await theAgent(scope), fields({ policyBlocks: withPolicies }), "with policies"),
    );
    await withOrganization(ds, A, async (scope) =>
      publishAgentConfig(scope, await theAgent(scope), fields(), "from a screen with no policy editor"),
    );

    expect(await livePolicies()).toEqual(withPolicies);
  });

  it("clears them for an empty list, which is a different thing from omitting", async () => {
    await withOrganization(ds, A, async (scope) =>
      publishAgentConfig(scope, await theAgent(scope), fields({ policyBlocks: withPolicies }), "with policies"),
    );
    await withOrganization(ds, A, async (scope) =>
      publishAgentConfig(scope, await theAgent(scope), fields({ policyBlocks: [] }), "deliberately none"),
    );

    expect(await livePolicies()).toEqual([]);
  });
});

describe("an organisation with more than one agent", () => {
  /**
   * What is left of the guess, and where it still has to refuse.
   *
   * These tests used to be about publishing. `config.*` had no agent in its route and
   * resolved the oldest live one, so a second agent made every publish a coin toss that
   * never said it flipped. That is fixed: the routes carry an agent id and
   * `publishAgentConfig` takes one, so publishing cannot pick the wrong agent any more.
   *
   * The resolver did not go away, though. `liveAgentId` is what the surfaces with no agent in
   * their route still use — the test call, the corpus viewer, and the two registry publishes,
   * all of which act on something genuinely organisation-wide. So the guard from migration
   * 0047 still matters, and these tests now name the thing that actually raises rather than
   * reaching it sideways through a publish. They passed either way, which is the problem:
   * the rejection was coming from the fixture's own helper.
   */
  const SECOND = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";

  /**
   * Seeded as the owner, because `ansa_app` cannot write this table — and that refusal is
   * itself the system working. Agents are not created by the application role; the guard
   * being tested exists for the day an operator creates one through the privileged path.
   * Assertions still run as the app role, which is the one that publishes.
   */
  const owner = process.env["MIGRATION_DIRECT_URL"];

  const asOwner = async (sql: string, params: readonly unknown[]): Promise<void> => {
    const client = new Client({ connectionString: owner });
    await client.connect();
    try {
      await client.query(sql, [...params]);
    } finally {
      await client.end();
    }
  };

  const addSecondAgent = (): Promise<void> =>
    asOwner(
      `insert into agents (id, organization_id, name, created_at)
       values ($1, $2, 'Second agent', now() + interval '1 hour')
         on conflict (id) do nothing`,
      [SECOND, A],
    );

  const removeSecondAgent = (): Promise<void> =>
    asOwner("delete from agents where id = $1", [SECOND]);

  it("resolves normally while there is only one", async () => {
    // The case every organisation is in today. The guard must be invisible here.
    await expect(
      withOrganization(ds, A, (scope) => liveAgentId(scope)),
    ).resolves.toEqual(expect.any(String));
  });

  it.skipIf(owner === undefined)("refuses to resolve rather than picking one", async () => {
    await addSecondAgent();
    try {
      await expect(
        withOrganization(ds, A, (scope) => liveAgentId(scope)),
      ).rejects.toThrow(/live agents/);
    } finally {
      await removeSecondAgent();
    }
  });

  it.skipIf(owner === undefined)("says which organisation and how many, so the message is actionable", async () => {
    /* "Something went wrong" would send somebody to the logs. The operator needs to know
       the surface cannot mean one agent any more and which routes can. */
    await addSecondAgent();
    try {
      await withOrganization(ds, A, (scope) => liveAgentId(scope));
      expect.unreachable("resolving should have refused");
    } catch (error) {
      expect(String(error)).toContain("2 live agents");
      expect(String(error)).toContain("agent-scoped");
    } finally {
      await removeSecondAgent();
    }
  });

  it.skipIf(owner === undefined)("resolves again once the second agent is gone", async () => {
    // The guard is about ambiguity, not a latch. Removing the second must restore the path.
    await addSecondAgent();
    await removeSecondAgent();
    await expect(
      withOrganization(ds, A, (scope) => liveAgentId(scope)),
    ).resolves.toEqual(expect.any(String));
  });

  it.skipIf(owner === undefined)("publishes to both, because publishing names its agent", async () => {
    /* The other half, and the point of the whole change. Two live agents is a refusal for
       anything that has to guess and an ordinary Tuesday for anything that does not: each
       agent publishes on its own, and neither version lands on the other. */
    await addSecondAgent();
    try {
      const first = await withOrganization(ds, A, async (scope) => {
        const rows = await scope.query<{ id: string }>(
          "select id from agents where organization_id = $1 and id <> $2 and deleted_at is null",
          [A, SECOND],
        );
        return String(rows[0]?.id);
      });

      await expect(
        withOrganization(ds, A, (scope) =>
          publishAgentConfig(scope, first, fields({ greeting: "First." }), "the first agent"),
        ),
      ).resolves.toBeGreaterThan(0);
      await expect(
        withOrganization(ds, A, (scope) =>
          publishAgentConfig(scope, SECOND, fields({ greeting: "Second." }), "the second agent"),
        ),
      ).resolves.toBeGreaterThan(0);

      const greetings = await withOrganization(ds, A, async (scope) => ({
        first: (await loadCurrentAgentConfig(scope, first))?.config.greeting,
        second: (await loadCurrentAgentConfig(scope, SECOND))?.config.greeting,
      }));
      expect(greetings).toEqual({ first: "First.", second: "Second." });
    } finally {
      await removeSecondAgent();
    }
  });
});
