import { asOrganizationId } from "@ansa/shared";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findAgent, setAgentTools } from "./agents";
import { createDataSource } from "./data-source";
import {
  applyAgentBehaviour,
  applyCapturedFields,
  discardAgentDraft,
  liveAgentId,
  loadAgentDraft,
  saveAgentDraft,
  stageAgentSelection,
} from "./drafts";
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
 * One organization id range per file, because these suites share one database and run in
 * parallel. The list, from the files rather than from another file's comment about them:
 *
 *   rls                  1…, 2…        review               3…, 4…
 *   organization-scope   5…, 6…        organization-config  7…, 8…
 *   onboarding           9…, 9a…       knowledge            b0…, b1…
 *   drafts (this file)   c0…, c1…
 *
 * Written out because the partial version of this list is what went wrong: this file started
 * on `9…`, which `onboarding.test.ts` already owned and deletes the agents of in its
 * `afterAll`. Alone the suite passed; in the full run seven tests failed with "the fixture
 * has no live agent", which is a fixture being deleted underneath them by a neighbour.
 */
const A = asOrganizationId("c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0");
const B = asOrganizationId("c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1");

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

  /*
   * Torn down before it is built, not only after.
   *
   * `on conflict do nothing` was not enough, and the way it failed is worth keeping: several
   * tests here publish, so they leave the fixture's greeting and switches changed. `afterAll`
   * deletes the organisations, but a run that is interrupted — or one whose suite fails at
   * setup — never reaches it, and the next run's insert then does nothing and inherits the
   * published values. The symptom was this file passing alone, failing in a full run, and
   * failing differently each time, which reads exactly like database flakiness and is not.
   *
   * A fixture that depends on the last run having finished cleanly is a fixture that lies
   * eventually. This one starts from nothing every time.
   */
  for (const [organization, label] of [
    [A, "A"],
    [B, "B"],
  ] as const) {
    await withOrganization(ds, organization, async (scope) => {
      await scope.query("delete from organizations where id = $1", [organization]);
      await scope.query("insert into organizations (id, name) values ($1, $2)", [
        organization,
        `Draft organization ${label}`,
      ]);
      // Every column these tests assert a starting value for is set here rather than left to
      // the table's default, so the assertion and the fixture cannot drift apart.
      await scope.query(
        `insert into agents (id, organization_id, name, barge_in, answering_machine_detection)
         values ($1, $1, $2, true, false)`,
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
    expect(draft?.config?.greeting).toBe("A greeting nobody has published.");
  });

  it("reports its timestamp as an ISO string, not a Date", async () => {
    // The driver parses `timestamptz` into a `Date`, and the API's schema layer refuses
    // anything that is not a string — so a row typed as `string` type-checks, saves
    // correctly, and answers 500 on the way back out. This file missed it; the browser
    // found it. Asserted here so the next timestamp cannot repeat it.
    const agent = await agentOf(A);
    const draft = await withOrganization(ds, A, (scope) => loadAgentDraft(scope, agent));
    expect(typeof draft?.updatedAt).toBe("string");
    expect(draft?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
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
    expect(mine?.config?.greeting).toBe("A greeting nobody has published.");
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
    // Narrowed rather than asserted: `config` is nullable since 0040, because a draft
    // holding only a tool selection is an ordinary state.
    const staged = draft?.config;
    if (staged == null) throw new Error("the previous test should have left a configuration");

    await withOrganization(ds, A, (scope) =>
      publishAgentConfig(scope, staged, "published the draft"),
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
    // From nothing, so the assertion is about this save and not about whatever the test
    // before it happened to leave staged.
    await withOrganization(ds, A, (scope) => discardAgentDraft(scope, agent));
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

/**
 * The guarantee this whole slice rests on, asserted against the database rather than trusted.
 *
 * Everything a call reads is read through an `app.*` function, so "a draft cannot reach a
 * caller" is exactly the statement that no function except the draft API itself mentions the
 * table. Asserting the property this way rather than testing the three read paths one by one
 * is the difference between covering what exists today and covering what somebody adds next
 * year: a new `agent_config_for_*` variant is caught without anybody remembering this file.
 *
 * Four are allowed to know. Three of them are how a draft is written and thrown away — the
 * configuration, the three selections, and the discard. The fourth is `publish_agent_config`,
 * which deletes it — in the same transaction as the publish,
 * because a draft that survived its own publication would leave the console reporting
 * unpublished changes that are already live.
 */
const MAY_TOUCH_DRAFTS = new Set([
  "save_agent_draft",
  "stage_agent_draft_selection",
  "discard_agent_draft",
  "publish_agent_config",
]);

describe("nothing a call reads knows about drafts", () => {
  it("keeps the drafts table out of every function except the three that manage it", async () => {
    const rows = await withOrganization(ds, A, (scope) =>
      scope.query<{ proname: string; touches: boolean }>(
        `select p.proname, (p.prosrc like '%agent_config_drafts%') as touches
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app'`,
      ),
    );

    // A guard that silently inspects nothing reports success forever.
    expect(rows.length).toBeGreaterThan(15);

    const unexpected = rows
      .filter((row) => row.touches && !MAY_TOUCH_DRAFTS.has(row.proname))
      .map((row) => row.proname);
    expect(unexpected, `these read or write drafts and should not: ${unexpected.join(", ")}`)
      .toEqual([]);

    // And the converse, so the allow-list cannot rot into a list of names that no longer
    // exist while the real writers slip past it.
    const touching = new Set(rows.filter((row) => row.touches).map((row) => row.proname));
    expect([...MAY_TOUCH_DRAFTS].filter((name) => !touching.has(name))).toEqual([]);
  });

  it("reads the live columns for a call even while a draft exists", async () => {
    // The same property from the other side, through the function the carrier webhook
    // actually calls. `agent_config_for_organization` is the outbound sibling of
    // `agent_config_for_number`; both read `agents`, and neither joins this table.
    const agent = await agentOf(A);
    await withOrganization(ds, A, (scope) =>
      saveAgentDraft(scope, agent, fields({ greeting: "Draft, not for callers." }), null, null),
    );

    const rows = await withOrganization(ds, A, (scope) =>
      scope.query<{ greeting: string | null }>(
        "select greeting from app.agent_config_for_organization($1)",
        [A],
      ),
    );

    expect(rows[0]?.greeting).not.toBe("Draft, not for callers.");
    await withOrganization(ds, A, (scope) => discardAgentDraft(scope, agent));
  });
});

/**
 * The three selections an agent owns, staged the same way its configuration is.
 *
 * The property worth protecting is that they are staged *independently*. Four editors are
 * saved at four different moments, and the failure this is written against is a tool save
 * quietly republishing a half-written greeting, or a greeting save blanking a tool selection
 * nobody touched. Null means "not staged" and an empty array means "deliberately none", and
 * the difference between those two is the whole design.
 */
describe("staging the rest of an agent", () => {
  it("saves one section without inventing the others", async () => {
    const agent = await agentOf(A);
    await withOrganization(ds, A, (scope) =>
      stageAgentSelection(scope, agent, { tools: ["check_endorsement"] }, null),
    );

    const draft = await withOrganization(ds, A, (scope) => loadAgentDraft(scope, agent));
    expect(draft?.tools).toEqual(["check_endorsement"]);
    // Not staged, so the console shows the live values for these rather than a stale copy.
    expect(draft?.config).toBeNull();
    expect(draft?.capturedFields).toBeNull();
    expect(draft?.knowledge).toBeNull();
  });

  it("leaves a section alone when another is saved", async () => {
    const agent = await agentOf(A);
    await withOrganization(ds, A, (scope) =>
      stageAgentSelection(scope, agent, { knowledge: [] }, null),
    );

    const draft = await withOrganization(ds, A, (scope) => loadAgentDraft(scope, agent));
    expect(draft?.tools, "a knowledge save wiped the staged tools").toEqual([
      "check_endorsement",
    ]);
    // And the empty array survived as itself: an agent with no knowledge base is a choice.
    expect(draft?.knowledge).toEqual([]);
  });

  it("keeps a staged selection when the configuration is saved over it", async () => {
    const agent = await agentOf(A);
    await withOrganization(ds, A, (scope) =>
      saveAgentDraft(scope, agent, fields({ greeting: "Saved after the tools were." }), null, null),
    );

    const draft = await withOrganization(ds, A, (scope) => loadAgentDraft(scope, agent));
    expect(draft?.config?.greeting).toBe("Saved after the tools were.");
    expect(draft?.tools).toEqual(["check_endorsement"]);
    expect(draft?.knowledge).toEqual([]);
  });

  it("tells an empty selection apart from an unstaged one", async () => {
    const agent = await agentOf(B);
    await withOrganization(ds, B, (scope) =>
      stageAgentSelection(scope, agent, { tools: [] }, null),
    );

    const draft = await withOrganization(ds, B, (scope) => loadAgentDraft(scope, agent));
    expect(draft?.tools).toEqual([]);
    expect(draft?.tools).not.toBeNull();
    await withOrganization(ds, B, (scope) => discardAgentDraft(scope, agent));
  });

  it("applies a staged form without bumping the version", async () => {
    // The publish path needs the form on the agent row before the snapshot is taken, and it
    // bumps once for the whole act — a form that took a version of its own would leave two
    // rows in the history for one publish.
    const agent = await agentOf(A);
    const before = await withOrganization(ds, A, (scope) => loadCurrentAgentConfig(scope));

    const applied = await withOrganization(ds, A, (scope) =>
      applyCapturedFields(scope, agent, []),
    );
    expect(applied).toBe(true);

    const after = await withOrganization(ds, A, (scope) => loadCurrentAgentConfig(scope));
    expect(after?.version).toBe(before?.version);

    await withOrganization(ds, A, (scope) => discardAgentDraft(scope, agent));
  });
});

/**
 * Publishing applies every staged section, and only the staged ones.
 *
 * The half that cannot be checked by staging alone. Absent sections must be *left*, not
 * cleared: a publish that blanked an agent's tools because somebody edited only the greeting
 * is the exact defect this slice was written to end, and it would be invisible until a caller
 * asked for something the agent could no longer look up.
 */
describe("publishing what was staged", () => {
  it("applies the selections that were staged and leaves the rest alone", async () => {
    const agent = await agentOf(B);

    // A live selection nobody is going to stage, so the publish has something to leave alone.
    await withOrganization(ds, B, (scope) => setAgentTools(scope, agent, []));

    await withOrganization(ds, B, (scope) =>
      stageAgentSelection(scope, agent, { capturedFields: [] }, null),
    );
    await withOrganization(ds, B, (scope) =>
      saveAgentDraft(scope, agent, fields({ greeting: "Published with a staged form." }), null, null),
    );

    const draft = await withOrganization(ds, B, (scope) => loadAgentDraft(scope, agent));
    const stagedConfig = draft?.config;
    if (draft == null || stagedConfig == null) {
      throw new Error("the fixture should have staged a configuration");
    }

    // What the publish endpoint does, in the order it does it: the form onto the agent row
    // first, because `publish_agent_config` snapshots that row a moment later.
    await withOrganization(ds, B, async (scope) => {
      if (draft.capturedFields != null) {
        await applyCapturedFields(scope, agent, draft.capturedFields);
      }
      await publishAgentConfig(scope, stagedConfig, "published the staged sections");
      if (draft.tools != null) await setAgentTools(scope, agent, draft.tools);
    });

    const after = await withOrganization(ds, B, (scope) => findAgent(scope, agent));
    expect(after?.greeting).toBe("Published with a staged form.");
    expect(after?.capturedFields).toEqual([]);
    // Never staged, so untouched rather than cleared.
    expect(after?.enabledTools).toEqual([]);

    // And the draft is gone, deleted by the publish itself rather than by the API after it.
    expect(await withOrganization(ds, B, (scope) => loadAgentDraft(scope, agent))).toBeNull();
  });
});

/**
 * The behaviour flags, which were the last per-agent setting writing straight to a live call.
 *
 * They are two switches on one panel and they are staged as two sections, because that is how
 * they are saved: each toggle sends only the switch that moved. Every assertion below is
 * about that independence — between the two flags, between a flag and the other sections, and
 * between a staged flag and the value a call is reading right now.
 */
const liveBehaviour = async (
  organization: typeof A,
): Promise<{ readonly bargeIn: boolean; readonly amd: boolean }> => {
  // Through the function a call actually runs, not through the agents table. A draft that
  // could move this could move a call.
  const rows = await withOrganization(ds, organization, (scope) =>
    scope.query<{ barge_in: boolean; amd_enabled: boolean }>(
      "select barge_in, amd_enabled from app.agent_config_for_organization($1)",
      [organization],
    ),
  );
  const row = rows[0];
  if (row === undefined) throw new Error("the fixture has no live agent configuration");
  return { bargeIn: row.barge_in, amd: row.amd_enabled };
};

describe("staging the behaviour flags", () => {
  it("changes nothing the call path reads", async () => {
    const agent = await agentOf(B);
    const before = await liveBehaviour(B);

    /* Staged as the opposite of whatever is live, rather than a fixed `false` against a
       fixture asserted to start `true`. Earlier tests in this file publish to B, so the
       starting value is not this test's to know — and asserting it made the suite pass or
       fail on what ran before it, which reads as flakiness and is not. What this test is
       about is the invariant: staging moves nothing a call reads. */
    await withOrganization(ds, B, (scope) =>
      stageAgentSelection(scope, agent, { bargeIn: !before.bargeIn }, null),
    );

    const after = await liveBehaviour(B);
    expect(after).toEqual(before);
    // Named on its own because this is the behaviour a caller would meet: an agent that has
    // stopped letting them interrupt, because somebody flipped a switch and never published.
    expect(after.bargeIn).toBe(before.bargeIn);
  });

  it("stages false as a value rather than as an absence", async () => {
    const agent = await agentOf(B);
    const draft = await withOrganization(ds, B, (scope) => loadAgentDraft(scope, agent));
    expect(draft?.bargeIn).toBe(false);
    // The other switch was never touched, so it is not staged — and the console shows the
    // live value for it rather than a copy of it.
    expect(draft?.answeringMachineDetection).toBeNull();
  });

  it("does not revert the other flag when one is flipped", async () => {
    // The failure this is written against: a save that carried both flags would send the
    // value the page read when it rendered, and quietly put the other switch back.
    const agent = await agentOf(B);
    await withOrganization(ds, B, (scope) =>
      stageAgentSelection(scope, agent, { answeringMachineDetection: true }, null),
    );

    const draft = await withOrganization(ds, B, (scope) => loadAgentDraft(scope, agent));
    expect(draft?.bargeIn, "staging detection reverted the staged barge-in").toBe(false);
    expect(draft?.answeringMachineDetection).toBe(true);
  });

  it("leaves the other sections alone, and they leave it alone", async () => {
    const agent = await agentOf(B);
    await withOrganization(ds, B, (scope) =>
      stageAgentSelection(scope, agent, { tools: ["check_endorsement"] }, null),
    );
    await withOrganization(ds, B, (scope) =>
      saveAgentDraft(scope, agent, fields({ greeting: "Saved after the switches were." }), null, null),
    );

    const draft = await withOrganization(ds, B, (scope) => loadAgentDraft(scope, agent));
    expect(draft?.bargeIn, "a tool or configuration save wiped a staged switch").toBe(false);
    expect(draft?.answeringMachineDetection).toBe(true);
    expect(draft?.tools).toEqual(["check_endorsement"]);
    expect(draft?.config?.greeting).toBe("Saved after the switches were.");

    await withOrganization(ds, B, (scope) => discardAgentDraft(scope, agent));
  });

  it("applies a staged flag without bumping the version", async () => {
    // Nothing in `agent_prompt_versions` records either flag, so applying one is not a
    // publication and must not take a version number of its own.
    const agent = await agentOf(B);
    const before = await withOrganization(ds, B, (scope) => loadCurrentAgentConfig(scope));

    const applied = await withOrganization(ds, B, (scope) =>
      applyAgentBehaviour(scope, agent, { bargeIn: true }),
    );
    expect(applied).toBe(true);

    const after = await withOrganization(ds, B, (scope) => loadCurrentAgentConfig(scope));
    expect(after?.version).toBe(before?.version);
  });
});

describe("publishing the behaviour flags", () => {
  it("applies the staged flag and leaves the unstaged one where it was", async () => {
    const agent = await agentOf(B);

    // A live value nobody is going to stage, and one that differs from the default, so a
    // publish that passed "not staged" through as false would be visible rather than lucky.
    await withOrganization(ds, B, (scope) =>
      scope.query("update agents set answering_machine_detection = true where id = $1", [agent]),
    );
    expect(await liveBehaviour(B)).toEqual({ bargeIn: true, amd: true });

    await withOrganization(ds, B, (scope) =>
      stageAgentSelection(scope, agent, { bargeIn: false }, null),
    );
    await withOrganization(ds, B, (scope) =>
      saveAgentDraft(scope, agent, fields({ greeting: "Published with a staged switch." }), null, null),
    );

    const draft = await withOrganization(ds, B, (scope) => loadAgentDraft(scope, agent));
    const stagedConfig = draft?.config;
    if (draft == null || stagedConfig == null) {
      throw new Error("the fixture should have staged a configuration");
    }

    // What the publish endpoint does, in the order it does it. The flags go after
    // `publish_agent_config` rather than before it, because the snapshot has no column for
    // either — unlike the captured-field form, which has to be on the row first.
    await withOrganization(ds, B, async (scope) => {
      await publishAgentConfig(scope, stagedConfig, "published a staged switch");
      await applyAgentBehaviour(scope, agent, {
        ...(draft.bargeIn === null ? {} : { bargeIn: draft.bargeIn }),
        ...(draft.answeringMachineDetection === null
          ? {}
          : { answeringMachineDetection: draft.answeringMachineDetection }),
      });
    });

    const live = await liveBehaviour(B);
    expect(live.bargeIn, "publishing did not apply the staged switch").toBe(false);
    expect(live.amd, "publishing cleared a flag nobody staged").toBe(true);

    expect(await withOrganization(ds, B, (scope) => loadAgentDraft(scope, agent))).toBeNull();
  });

  it("leaves both alone when a publish carries no staged switch", async () => {
    const agent = await agentOf(B);
    await withOrganization(ds, B, (scope) =>
      saveAgentDraft(scope, agent, fields({ greeting: "No switches in this one." }), null, null),
    );

    const draft = await withOrganization(ds, B, (scope) => loadAgentDraft(scope, agent));
    const stagedConfig = draft?.config;
    if (draft == null || stagedConfig == null) throw new Error("the fixture should have a draft");
    expect(draft.bargeIn).toBeNull();
    expect(draft.answeringMachineDetection).toBeNull();

    await withOrganization(ds, B, (scope) =>
      publishAgentConfig(scope, stagedConfig, "published without touching the switches"),
    );

    // Exactly what the previous test left: barge-in off, detection on. A publish that wrote
    // the flags unconditionally would put both back to their column defaults here.
    expect(await liveBehaviour(B)).toEqual({ bargeIn: false, amd: true });
  });
});
