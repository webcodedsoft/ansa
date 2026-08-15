import { asOrganizationId } from "@ansa/shared";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDataSource, type Db } from "./data-source";
import {
  createKnowledgeSource,
  deleteKnowledgeSource,
  findKnowledgeSource,
  listAgentKnowledgeSources,
  listKnowledgeSources,
  listKnowledgeUnits,
  recordKnowledgeRetrieval,
  searchKnowledge,
  setAgentKnowledgeSources,
  setKnowledgeUnits,
} from "./knowledge";
import { withOrganization } from "./organization-scope";
import { loadDotEnv } from "./test-env";

loadDotEnv();

/**
 * The knowledge base, against the real schema (0034).
 *
 * Two things are actually under test and neither can be shown against a fake. The first is
 * that an agent retrieves only out of the sources it was given — a rule that lives in a join
 * in one SQL statement, and would pass every unit test ever written against a stub repository.
 * The second is RLS: the isolation here is not a `where` clause anyone can read in this file.
 *
 * So it connects as the application role, exactly as the app does, and the teardown needs a
 * second connection as the operator — `ansa_app` has no DELETE on `knowledge_sources` or
 * `knowledge_retrievals`, and that absence is itself part of what 0034 promises.
 */

const url = process.env["DATABASE_URL"];
if (url === undefined) {
  throw new Error("DATABASE_URL must be set: this test needs a database");
}

/*
 * Its own pair of organisation ids, as every suite in this package has.
 *
 * Vitest runs the files in parallel against one database, and a shared id means one suite's
 * teardown deletes another's fixtures — which fails as a foreign key violation somewhere far
 * from the cause. Taken already: 3/4 by `review`, 5/6 by `organization-scope`, 7/8 by
 * `organization-config`, 9/9a by `onboarding`, 1/2 by `rls`.
 */
const ORGANIZATION = asOrganizationId("b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0");
const OTHER = asOrganizationId("b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1");
const AGENT = "b0b0b0b0-aaaa-4aaa-8aaa-b0b0b0b0b0b0";
/** A second agent in the same organisation, given nothing. The whole point of the join. */
const OTHER_AGENT = "b0b0b0b0-bbbb-4bbb-8bbb-b0b0b0b0b0b0";
const OTHER_ORG_AGENT = "b1b1b1b1-aaaa-4aaa-8aaa-b1b1b1b1b1b1";

const FAQ = {
  name: "Refunds and delivery",
  kind: "faq" as const,
  units: [
    { question: "How long does a refund take?", body: "Refunds are paid back within three working days." },
    { question: "How much is delivery in Lagos?", body: "Delivery within Lagos is two thousand naira." },
    { question: null, body: "Our warehouse is on Awolowo Road and opens at eight." },
  ],
};

let db: Db;
let operator: Client;

const seedOrganization = async (organization: typeof ORGANIZATION, agents: readonly string[]) => {
  await withOrganization(db, organization, async (scope) => {
    await scope.query(
      `insert into organizations (id, name) values ($1, 'Knowledge Test')
         on conflict (id) do nothing`,
      [organization],
    );
    for (const agent of agents) {
      await scope.query(
        `insert into agents (id, organization_id, name) values ($1, $2, 'Knowledge probe')
           on conflict (id) do nothing`,
        [agent, organization],
      );
    }
  });
};

beforeAll(async () => {
  db = await createDataSource({ url, poolSize: 2 }).initialize();
  operator = new Client({
    connectionString: process.env["MIGRATION_DIRECT_URL"] ?? process.env["DIRECT_URL"] ?? url,
  });
  await operator.connect();

  await seedOrganization(ORGANIZATION, [AGENT, OTHER_AGENT]);
  await seedOrganization(OTHER, [OTHER_ORG_AGENT]);
});

afterAll(async () => {
  // Cascades take the agents, the sources, the units, the selections and the retrievals.
  await operator.query("delete from organizations where id = any($1)", [[ORGANIZATION, OTHER]]);
  await operator.end();
  await db.destroy();
});

/** A fresh source, given to `agent` unless told otherwise. Each test starts from nothing. */
const freshSource = async (agent: string | null = AGENT): Promise<string> => {
  await operator.query("delete from knowledge_sources where organization_id = $1", [ORGANIZATION]);
  return withOrganization(db, ORGANIZATION, async (scope) => {
    const source = await createKnowledgeSource(scope, FAQ);
    if (agent !== null) await setAgentKnowledgeSources(scope, agent, [source.sourceId]);
    return source.sourceId;
  });
};

describe("knowledge sources", () => {
  it("stores the units in the order they were given and counts them back", async () => {
    const sourceId = await freshSource();

    const [listed, units] = await withOrganization(db, ORGANIZATION, async (scope) => [
      await listKnowledgeSources(scope),
      await listKnowledgeUnits(scope, sourceId),
    ]);

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      sourceId,
      name: FAQ.name,
      kind: "faq",
      unitCount: 3,
      retrievalsLast7Days: 0,
      deletedAt: null,
    });
    expect(units.map((u) => u.position)).toEqual([0, 1, 2]);
    expect(units[2]?.question).toBeNull();
  });

  it("finds one source by id, and stops finding it once it is deleted", async () => {
    const sourceId = await freshSource();

    const [found, gone] = await withOrganization(db, ORGANIZATION, async (scope) => [
      await findKnowledgeSource(scope, sourceId),
      await deleteKnowledgeSource(scope, sourceId).then(async () =>
        findKnowledgeSource(scope, sourceId),
      ),
    ]);

    expect(found?.name).toBe(FAQ.name);
    // Null rather than a row carrying `deletedAt`: to everything above this, it is not there.
    expect(gone).toBeNull();
  });

  it("replaces the units wholesale rather than appending to them", async () => {
    const sourceId = await freshSource();

    const units = await withOrganization(db, ORGANIZATION, async (scope) => {
      await setKnowledgeUnits(scope, sourceId, [{ body: "We no longer offer refunds." }]);
      return listKnowledgeUnits(scope, sourceId);
    });

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ position: 0, question: null });
  });

  it("moves updated_at when a source is touched", async () => {
    const sourceId = await freshSource();

    /* Two transactions, not one. `app.touch_updated_at` stamps `now()`, which is the
       transaction's start time — so a row updated in the same transaction that inserted it
       carries the timestamp it was born with, and the trigger would look absent when it is
       not. Migration 0031 chose `now()` over `clock_timestamp()` deliberately. */
    await operator.query("update knowledge_sources set name = 'Renamed' where id = $1", [sourceId]);

    const [row] = await operator.query<{ moved: boolean }>(
      "select updated_at > created_at as moved from knowledge_sources where id = $1",
      [sourceId],
    ).then((r) => r.rows);

    expect(row?.moved).toBe(true);
  });
});

describe("retrieval", () => {
  it("finds a unit by its question and ranks the question match first", async () => {
    await freshSource();

    const hits = await withOrganization(db, ORGANIZATION, async (scope) =>
      searchKnowledge(scope, AGENT, "refund", 5),
    );

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.question).toBe("How long does a refund take?");
    expect(hits[0]?.sourceName).toBe(FAQ.name);
    expect(hits[0]?.rank).toBeGreaterThan(0);
  });

  it("stems, so 'refunded' finds 'refund'", async () => {
    await freshSource();

    const hits = await withOrganization(db, ORGANIZATION, async (scope) =>
      searchKnowledge(scope, AGENT, "when will I be refunded", 5),
    );

    expect(hits.map((h) => h.question)).toContain("How long does a refund take?");
  });

  it("does not raise on whatever speech recognition produces", async () => {
    await freshSource();

    // `to_tsquery` would throw on these and turn a bad transcription into a failed turn.
    const hits = await withOrganization(db, ORGANIZATION, async (scope) => [
      await searchKnowledge(scope, AGENT, "", 5),
      await searchKnowledge(scope, AGENT, "!! & | :* (", 5),
      await searchKnowledge(scope, AGENT, "the a of", 5),
    ]);

    expect(hits).toEqual([[], [], []]);
  });

  /* The security property. An agent can be asked about anything; it must only ever be able to
     answer out of what it was given. Same organisation, same source, no selection row. */
  it("returns nothing for an agent that was not given the source", async () => {
    await freshSource(AGENT);

    const hits = await withOrganization(db, ORGANIZATION, async (scope) =>
      searchKnowledge(scope, OTHER_AGENT, "refund", 5),
    );

    expect(hits).toEqual([]);
  });

  it("stops answering out of a source the moment it is deleted", async () => {
    const sourceId = await freshSource();

    const [before, deleted, after, listed] = await withOrganization(db, ORGANIZATION, async (scope) => [
      await searchKnowledge(scope, AGENT, "refund", 5),
      await deleteKnowledgeSource(scope, sourceId),
      await searchKnowledge(scope, AGENT, "refund", 5),
      await listKnowledgeSources(scope),
    ]);

    expect(before.length).toBeGreaterThan(0);
    expect(deleted).toBe(true);
    expect(after).toEqual([]);
    expect(listed).toEqual([]);
  });

  it("caps how much it will return however much is asked for", async () => {
    await freshSource();

    const hits = await withOrganization(db, ORGANIZATION, async (scope) =>
      searchKnowledge(scope, AGENT, "refund or delivery or warehouse", 500),
    );

    expect(hits.length).toBeLessThanOrEqual(20);
  });
});

describe("the agent's selection", () => {
  it("replaces the selection wholesale", async () => {
    const sourceId = await freshSource(AGENT);

    const [cleared, restored] = await withOrganization(db, ORGANIZATION, async (scope) => [
      await setAgentKnowledgeSources(scope, AGENT, []),
      await setAgentKnowledgeSources(scope, AGENT, [sourceId]),
    ]);

    expect(cleared).toEqual([]);
    expect(restored).toEqual([sourceId]);
  });

  it("reads back only the live sources an agent holds", async () => {
    const sourceId = await freshSource(AGENT);

    const [held, afterDelete] = await withOrganization(db, ORGANIZATION, async (scope) => [
      await listAgentKnowledgeSources(scope, AGENT),
      await deleteKnowledgeSource(scope, sourceId).then(async () =>
        listAgentKnowledgeSources(scope, AGENT),
      ),
    ]);

    // The selection row survives the soft delete; nothing that joins through the source sees it.
    expect(held).toEqual([sourceId]);
    expect(afterDelete).toEqual([]);
  });

  it("drops an id that names a deleted source instead of storing it", async () => {
    const sourceId = await freshSource(null);

    const stored = await withOrganization(db, ORGANIZATION, async (scope) => {
      await deleteKnowledgeSource(scope, sourceId);
      return setAgentKnowledgeSources(scope, AGENT, [sourceId]);
    });

    // The answer is what was actually stored, not what was asked for.
    expect(stored).toEqual([]);
  });

  it("is null for an agent that does not exist, so the API answers 404", async () => {
    const stored = await withOrganization(db, ORGANIZATION, async (scope) =>
      setAgentKnowledgeSources(scope, "deadbeef-dead-4ead-8ead-deadbeefdead", []),
    );

    expect(stored).toBeNull();
  });
});

describe("usage", () => {
  it("counts a retrieval against the source for the last seven days", async () => {
    const sourceId = await freshSource();

    const listed = await withOrganization(db, ORGANIZATION, async (scope) => {
      await recordKnowledgeRetrieval(scope, [sourceId, sourceId], null);
      await recordKnowledgeRetrieval(scope, [sourceId], null);
      return listKnowledgeSources(scope);
    });

    // Deduplicated within a call to the function, so two writes are two retrievals.
    expect(listed[0]?.retrievalsLast7Days).toBe(2);
  });

  it("leaves an id it cannot resolve alone rather than failing the turn", async () => {
    await freshSource();

    await expect(
      withOrganization(db, ORGANIZATION, async (scope) =>
        recordKnowledgeRetrieval(scope, ["deadbeef-dead-4ead-8ead-deadbeefdead"], null),
      ),
    ).resolves.toBeUndefined();
  });
});

/**
 * Isolation, played as the adversary rather than read off `pg_policies`.
 *
 * Knowledge is the one thing in this schema a competitor would actually want: pricing,
 * policies, the script for handling a complaint.
 */
describe("organization isolation", () => {
  it("hides one organisation's sources from another", async () => {
    await freshSource();

    const listed = await withOrganization(db, OTHER, async (scope) => listKnowledgeSources(scope));

    expect(listed).toEqual([]);
  });

  it("will not retrieve another organisation's knowledge, agent id and all", async () => {
    await freshSource();

    /* Asking with the *other* organisation's scope but this organisation's agent id — the
       shape of the bug where a leaked identifier is enough to read across the boundary. */
    const hits = await withOrganization(db, OTHER, async (scope) =>
      searchKnowledge(scope, AGENT, "refund", 5),
    );

    expect(hits).toEqual([]);
  });

  it("will not let one organisation give its agent another's source", async () => {
    const sourceId = await freshSource(null);

    const stored = await withOrganization(db, OTHER, async (scope) =>
      setAgentKnowledgeSources(scope, OTHER_ORG_AGENT, [sourceId]),
    );

    // RLS hides the source, so the insert selects nothing — no row, and no error that would
    // confirm the id names something real.
    expect(stored).toEqual([]);
  });

  it("refuses a unit stamped with another organisation's id", async () => {
    const sourceId = await freshSource();

    await expect(
      withOrganization(db, ORGANIZATION, async (scope) =>
        scope.query(
          `insert into knowledge_units (organization_id, source_id, position, body)
           values ($1, $2, 99, 'planted')`,
          [OTHER, sourceId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
