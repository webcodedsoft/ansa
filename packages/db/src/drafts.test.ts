import { asOrganizationId } from "@ansa/shared";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDataSource } from "./data-source";
import { discardAgentDraft, liveAgentId, loadAgentDraft, saveAgentDraft } from "./drafts";
import {
  loadCurrentAgentConfig,
  publishAgentConfig,
  type AgentConfigFields,
} from "./organization-config";
import { loadDotEnv } from "./test-env";
import { withOrganization } from "./organization-scope";

loadDotEnv();

const url = process.env["DIRECT_URL"];
if (url === undefined) throw new Error("DIRECT_URL must be set: this test needs a database");

/**
 * Unpublished work, and the one property that makes it safe to have.
 *
 * Saving used to mean publishing, which is how three buttons labelled Save came to put every
 * tab on the next call. A draft fixes that only if a draft genuinely cannot be heard — so the
 * assertion that matters is not that saving works, it is that saving changes nothing a call
 * reads. Everything else here is detail around that one.
 *
 * One organization id range per file, as the other suites record: `1…`/`2…` in `rls.test.ts`,
 * `3…`/`4…` in `review.test.ts`, `5…`/`6…` in `organization-scope.test.ts`, `7…`/`8…` in
 * `organization-config.test.ts`. These are `9…` and `a…`.
 */
const A = asOrganizationId("99999999-9999-4999-8999-999999999999");
const B = asOrganizationId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

let ds: DataSource;

const fields = (overrides: Partial<AgentConfigFields> = {}): AgentConfigFields => ({
  name: "Draft Organisation",
  voiceId: null,
  speakingRate: null,
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

  for (const [organization, label] of [
    [A, "A"],
    [B, "B"],
  ] as const) {
    await withOrganization(ds, organization, async (scope) => {
      await scope.query(
        "insert into organizations (id, name) values ($1, $2) on conflict do nothing",
        [organization, `Draft organization ${label}`],
      );
      await scope.query(
        `insert into agents (id, organization_id, name)
         values ($1, $1, $2) on conflict do nothing`,
        [organization, `Draft organization ${label}`],
      );
    });
  }
});

afterAll(async () => {
  for (const organization of [A, B]) {
    await withOrganization(ds, organization, async (scope) => {
      await scope.query("delete from organizations where id = $1", [organization]);
    });
  }
  await ds.destroy();
});

const agentOf = async (organization: typeof A): Promise<string> => {
  const id = await withOrganization(ds, organization, (scope) => liveAgentId(scope));
  if (id === null) throw new Error("the fixture has no live agent");
  return id;
};

describe("a draft is not a call", () => {
  it("changes nothing the call path reads", async () => {
    // The property the whole slice rests on. `loadCurrentAgentConfig` reads the same columns
    // `agent_config_for_number` does, so if a draft could move this, it could move a call.
    const agent = await agentOf(A);
    const before = await withOrganization(ds, A, (scope) => loadCurrentAgentConfig(scope));

    await withOrganization(ds, A, (scope) =>
      saveAgentDraft(
        scope,
        agent,
        fields({ greeting: "A greeting nobody has published.", name: "Renamed in a draft" }),
        null,
        null,
      ),
    );

    const after = await withOrganization(ds, A, (scope) => loadCurrentAgentConfig(scope));
    expect(after).toEqual(before);
    // Named separately from the deep compare because this is the sentence a caller would
    // hear, and `toEqual` passing on two objects that are both wrong is a real way to be
    // reassured by nothing.
    expect(after?.config.greeting).not.toBe("A greeting nobody has published.");
    expect(after?.config.name).not.toBe("Renamed in a draft");
  });

  it("is still there after the call path was read", async () => {
    const agent = await agentOf(A);
    const draft = await withOrganization(ds, A, (scope) => loadAgentDraft(scope, agent));
    expect(draft?.config.greeting).toBe("A greeting nobody has published.");
  });
});

describe("one organisation cannot see another's unpublished work", () => {
  it("hides the draft from a different organisation", async () => {
    // A draft is the most sensitive copy of a configuration there is — it is what somebody is
    // still deciding — and it holds the same greeting and instructions a published one does.
    const agentA = await agentOf(A);
    const seen = await withOrganization(ds, B, (scope) => loadAgentDraft(scope, agentA));
    expect(seen).toBeNull();
  });

  it("refuses to write one under another organisation's agent", async () => {
    const agentA = await agentOf(A);
    const saved = await withOrganization(ds, B, (scope) =>
      saveAgentDraft(scope, agentA, fields({ greeting: "Planted." }), null, null),
    );
    // Null, not an exception: "no such agent", "deleted" and "not yours" are one answer.
    expect(saved).toBeNull();

    const mine = await withOrganization(ds, A, (scope) => loadAgentDraft(scope, agentA));
    expect(mine?.config.greeting).toBe("A greeting nobody has published.");
  });

  it("cannot discard one it cannot see", async () => {
    const agentA = await agentOf(A);
    const discarded = await withOrganization(ds, B, (scope) => discardAgentDraft(scope, agentA));
    expect(discarded).toBe(false);

    const survived = await withOrganization(ds, A, (scope) => loadAgentDraft(scope, agentA));
    expect(survived).not.toBeNull();
  });
});

describe("publishing consumes the draft", () => {
  it("puts the saved work live and leaves nothing unpublished behind", async () => {
    const agent = await agentOf(A);
    const draft = await withOrganization(ds, A, (scope) => loadAgentDraft(scope, agent));
    if (draft === null) throw new Error("the previous test should have left a draft");

    await withOrganization(ds, A, (scope) =>
      publishAgentConfig(scope, draft.config, "published the draft"),
    );

    const live = await withOrganization(ds, A, (scope) => loadCurrentAgentConfig(scope));
    expect(live?.config.greeting).toBe("A greeting nobody has published.");

    // In the same transaction as the publish, not from the API afterwards. A draft surviving
    // its own publication would have the console reporting unpublished changes that are
    // already live — and had the delete failed, it would say so forever.
    const left = await withOrganization(ds, A, (scope) => loadAgentDraft(scope, agent));
    expect(left).toBeNull();
  });
});

describe("discarding", () => {
  it("throws the work away and says it did", async () => {
    const agent = await agentOf(A);
    await withOrganization(ds, A, (scope) =>
      saveAgentDraft(scope, agent, fields({ greeting: "Second thoughts." }), null, null),
    );

    const discarded = await withOrganization(ds, A, (scope) => discardAgentDraft(scope, agent));
    expect(discarded).toBe(true);
    expect(await withOrganization(ds, A, (scope) => loadAgentDraft(scope, agent))).toBeNull();
  });

  it("reports false when there was nothing to throw away", async () => {
    // So the console can tell "discarded" from "there was nothing", rather than claiming
    // success either way.
    const agent = await agentOf(A);
    expect(await withOrganization(ds, A, (scope) => discardAgentDraft(scope, agent))).toBe(false);
  });
});

describe("where a draft came from", () => {
  it("remembers the version it was restored from", async () => {
    // Restoring fills the draft instead of publishing, so the provenance the old rollback
    // wrote into the note has to travel here — otherwise the history cannot answer why
    // version 9 looks like version 4.
    const agent = await agentOf(A);
    await withOrganization(ds, A, (scope) =>
      saveAgentDraft(scope, agent, fields({ greeting: "From version 1." }), null, 1),
    );

    const draft = await withOrganization(ds, A, (scope) => loadAgentDraft(scope, agent));
    expect(draft?.restoredFrom).toBe(1);
  });

  it("forgets it once the draft is edited", async () => {
    // Once somebody changes a restored draft it is their work, and offering "restored from
    // version 1" as its note would be wrong.
    const agent = await agentOf(A);
    await withOrganization(ds, A, (scope) =>
      saveAgentDraft(scope, agent, fields({ greeting: "Edited by hand." }), null, null),
    );

    const draft = await withOrganization(ds, A, (scope) => loadAgentDraft(scope, agent));
    expect(draft?.restoredFrom).toBeNull();

    await withOrganization(ds, A, (scope) => discardAgentDraft(scope, agent));
  });
});
