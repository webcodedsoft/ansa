import { asOrganizationId, emptyFlow, FLOW_VERSION, type Flow } from "@ansa/shared";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDataSource } from "./data-source";
import { liveAgentId, loadAgentDraft, stageAgentSelection } from "./drafts";
import {
  applyAgentFlow,
  loadDraftFlow,
  loadFlowAtVersion,
  loadPublishedFlow,
  stageDraftFlow,
} from "./flow";
import { publishAgentConfig, type AgentConfigFields } from "./organization-config";
import { withOrganization } from "./organization-scope";
import { loadDotEnv } from "./test-env";

/**
 * A conversation drawn as a graph, and the one property that makes it safe to draw.
 *
 * The interesting assertions here are not that a graph round-trips. They are that a graph
 * somebody is still drawing changes nothing a call reads (Rule 4), that publishing is what
 * moves it and records it in the version history, and that one organisation cannot see
 * another's — a graph holds the same greetings, prompts and branch conditions a published
 * configuration does, and a draft one is what somebody is still deciding.
 *
 * Against the real database, because every one of those is a fact about SQL: a coalesce in
 * `stage_agent_draft_selection`, a `case` in the publish's snapshot, and an RLS policy. A
 * fake scope would agree with whatever the query did.
 *
 * Its own organisation ids, enforced by `test-organization-ids.test.ts` rather than by a
 * comment listing the ranges — the two times that list was a comment it was out of date by
 * the time somebody read it, once for 22 failures.
 */

loadDotEnv();

const url = process.env["DIRECT_URL"];

const A = asOrganizationId("f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0");
const B = asOrganizationId("f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1");

let ds: DataSource;

/** A graph that branches, which is the whole reason the shape exists. */
const branching = (prompt: string): Flow => ({
  version: FLOW_VERSION,
  nodes: [
    { id: "start", kind: "start", x: 40, y: 120 },
    {
      id: "ask-policy",
      kind: "collect",
      x: 220,
      y: 120,
      field: {
        key: "policyNumber",
        type: "reference",
        prompt,
        capture: "either",
        confirm: "readback",
        pattern: "",
        attempts: 3,
        required: true,
        options: [],
      },
    },
    { id: "decide", kind: "decide", x: 400, y: 120, on: "policyNumber" },
    { id: "human", kind: "transfer", x: 580, y: 40 },
    { id: "bye", kind: "hangup", x: 580, y: 200 },
  ],
  edges: [
    { from: "start", to: "ask-policy" },
    { from: "ask-policy", to: "decide", port: "got" },
    { from: "decide", to: "human", when: { isEmpty: true } },
    { from: "decide", to: "bye", otherwise: true },
  ],
});

const fields = (overrides: Partial<AgentConfigFields> = {}): AgentConfigFields => ({
  name: "Flow Organisation",
  voiceId: null,
  speakingRate: null,
  greeting: null,
  persona: null,
  instructions: null,
  policyBlocks: null,
  keyterms: [],
  escalation: null,
  ...overrides,
});

/**
 * Torn down before it is built as well as after, for the reason `drafts.test.ts` records:
 * several tests here publish, so an interrupted run leaves a fixture with a published graph
 * on it, and the next run's insert would quietly inherit it.
 */
beforeAll(async () => {
  if (url === undefined) return;
  ds = createDataSource({ url, poolSize: 4 });
  await ds.initialize();

  for (const [organization, label] of [
    [A, "A"],
    [B, "B"],
  ] as const) {
    await withOrganization(ds, organization, async (scope) => {
      await scope.query("delete from organizations where id = $1", [organization]);
      await scope.query("insert into organizations (id, name) values ($1, $2)", [
        organization,
        `Flow organization ${label}`,
      ]);
      await scope.query(
        `insert into agents (id, organization_id, name) values ($1, $1, $2)`,
        [organization, `Flow organization ${label}`],
      );
    });
  }
}, 120_000);

afterAll(async () => {
  if (ds === undefined) return;
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

describe.skipIf(url === undefined)("an agent is a form until somebody draws otherwise", () => {
  it("starts with no graph and the form director", async () => {
    // The default the migration gives every agent that predates it. Asserted rather than
    // assumed, because it is what decides which director runs on the next call.
    const published = await withOrganization(ds, A, async (scope) =>
      loadPublishedFlow(scope, await agentOf(A)),
    );
    expect(published?.authoringMode).toBe("form");
    expect(published?.flow).toBeNull();
  });

  it("refuses a mode that is neither", async () => {
    // The check constraint, not a convention. A third value would reach the director as a
    // question nobody has an answer for.
    const agent = await agentOf(A);
    await expect(
      withOrganization(ds, A, (scope) =>
        scope.query("update agents set authoring_mode = 'canvas' where id = $1", [agent]),
      ),
    ).rejects.toThrow(/authoring_mode/i);
  });
});

describe.skipIf(url === undefined)("a drawn graph is not a live one", () => {
  it("stages without changing anything a call reads", async () => {
    // The property the whole slice rests on, and the same one `drafts.test.ts` asserts for
    // the configuration document. If a staged graph could move this, it could move a call.
    const agent = await agentOf(A);
    const before = await withOrganization(ds, A, (scope) => loadPublishedFlow(scope, agent));

    const saved = await withOrganization(ds, A, (scope) =>
      stageDraftFlow(
        scope,
        agent,
        { flow: branching("Nobody has published this prompt."), authoringMode: "flow" },
        null,
      ),
    );
    expect(saved).not.toBeNull();

    const after = await withOrganization(ds, A, (scope) => loadPublishedFlow(scope, agent));
    expect(after).toEqual(before);
    expect(after?.flow).toBeNull();
    expect(after?.authoringMode).toBe("form");
  });

  it("is invisible to the function a call resolves through", async () => {
    // The same property from the other side, through the read path the media socket uses
    // for an outbound call. It reads the agent's columns and cannot see a draft.
    const rows = await withOrganization(ds, A, (scope) =>
      scope.query<{ flow: Flow | null; authoring_mode: string }>(
        "select flow, authoring_mode from app.agent_config_for_organization($1)",
        [A],
      ),
    );
    expect(rows[0]?.flow).toBeNull();
    expect(rows[0]?.authoring_mode).toBe("form");
  });

  it("is there for the console that drew it, as an ISO timestamp", async () => {
    const agent = await agentOf(A);
    const staged = await withOrganization(ds, A, (scope) => loadDraftFlow(scope, agent));
    expect(staged?.authoringMode).toBe("flow");
    expect(staged?.flow?.nodes).toHaveLength(5);
    /* The driver parses `timestamptz` into a `Date` and the API's schema layer refuses
       anything that is not a string, so a row typed as `string` type-checks and answers 500
       on the way out. `drafts.ts` was caught by the browser; this is caught here. */
    expect(typeof staged?.updatedAt).toBe("string");
    expect(staged?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("survives a save on another section of the same draft", async () => {
    // Four editors saved at four different moments. A tool save that blanked the canvas
    // would be the same failure the staged sections were split up to prevent.
    const agent = await agentOf(A);
    await withOrganization(ds, A, (scope) =>
      stageAgentSelection(scope, agent, { tools: ["check_endorsement"] }, null),
    );

    const staged = await withOrganization(ds, A, (scope) => loadDraftFlow(scope, agent));
    expect(staged?.flow?.nodes).toHaveLength(5);
    expect(staged?.authoringMode).toBe("flow");
  });

  it("leaves the other sections alone when only the graph is saved", async () => {
    const agent = await agentOf(A);
    await withOrganization(ds, A, (scope) =>
      stageDraftFlow(scope, agent, { flow: branching("Redrawn, still unpublished.") }, null),
    );

    const draft = await withOrganization(ds, A, (scope) => loadAgentDraft(scope, agent));
    expect(draft?.tools, "a graph save wiped the staged tools").toEqual(["check_endorsement"]);
    // And the mode it was not given: undefined stages nothing rather than reverting it.
    const staged = await withOrganization(ds, A, (scope) => loadDraftFlow(scope, agent));
    expect(staged?.authoringMode).toBe("flow");
  });
});

describe.skipIf(url === undefined)("publishing is what puts a graph on the phone", () => {
  it("moves it onto the agent and into the version history", async () => {
    const agent = await agentOf(A);
    const drawn = branching("What is your policy number?");

    /* One transaction, because the version snapshot reads the graph off the agent row —
       the same ordering `applyCapturedFields` documents. Two transactions would publish a
       version recording the previous graph. */
    const version = await withOrganization(ds, A, async (scope) => {
      const applied = await applyAgentFlow(scope, agent, {
        flow: drawn,
        authoringMode: "flow",
      });
      expect(applied).toBe(true);
      return publishAgentConfig(scope, agent, fields(), "Drew the claims call as a graph.");
    });

    const published = await withOrganization(ds, A, (scope) => loadPublishedFlow(scope, agent));
    expect(published?.authoringMode).toBe("flow");
    expect(published?.flow).toEqual(drawn);
    expect(published?.configVersion).toBe(version);

    const recorded = await withOrganization(ds, A, (scope) =>
      loadFlowAtVersion(scope, agent, version),
    );
    expect(recorded).toEqual(drawn);
  });

  it("consumes the draft it published", async () => {
    // A draft cannot survive its own publication and leave the console reporting unpublished
    // changes that are already live.
    const agent = await agentOf(A);
    const staged = await withOrganization(ds, A, (scope) => loadDraftFlow(scope, agent));
    expect(staged).toBeNull();
  });

  it("keeps the canvas when the operator switches back to the form", async () => {
    /* Switching editors is not a request to delete the drawing. The mode decides what runs;
       the graph is kept so switching back does not mean redrawing it. */
    const agent = await agentOf(A);
    const version = await withOrganization(ds, A, async (scope) => {
      await applyAgentFlow(scope, agent, { authoringMode: "form" });
      return publishAgentConfig(scope, agent, fields(), "Back to the form for now.");
    });

    const published = await withOrganization(ds, A, (scope) => loadPublishedFlow(scope, agent));
    expect(published?.authoringMode).toBe("form");
    expect(published?.flow?.nodes).toHaveLength(5);

    /* And the version records the call rather than the column: this one answered as a form,
       so the snapshot holds no graph at all. */
    expect(await withOrganization(ds, A, (s) => loadFlowAtVersion(s, agent, version))).toBeNull();
  });

  it("stores an empty graph as itself, which is not the same as none", async () => {
    // `emptyFlow()` is valid, publishable and useless — a new canvas. Null is nobody having
    // opened one. A reader that folded the two together would answer the wrong question.
    const agent = await agentOf(B);
    await withOrganization(ds, B, (scope) =>
      applyAgentFlow(scope, agent, { flow: emptyFlow(), authoringMode: "flow" }),
    );

    const published = await withOrganization(ds, B, (scope) => loadPublishedFlow(scope, agent));
    expect(published?.flow).toEqual(emptyFlow());
    expect(published?.flow).not.toBeNull();
  });
});

describe.skipIf(url === undefined)("one organisation cannot read another's graph", () => {
  it("hides a published one", async () => {
    /* Absent rather than forbidden, which is what `agent_config_for_agent` answers for any
       agent that is not yours: an error distinguishing "not yours" from "no such agent"
       would confirm the id belongs to somebody. */
    const agentA = await agentOf(A);
    const seen = await withOrganization(ds, B, (scope) => loadPublishedFlow(scope, agentA));
    expect(seen).toBeNull();
  });

  it("hides an unpublished one", async () => {
    const agentA = await agentOf(A);
    await withOrganization(ds, A, (scope) =>
      stageDraftFlow(scope, agentA, { flow: branching("Still being decided.") }, null),
    );

    const seen = await withOrganization(ds, B, (scope) => loadDraftFlow(scope, agentA));
    expect(seen).toBeNull();
  });

  it("refuses to stage one under another organisation's agent", async () => {
    const agentA = await agentOf(A);
    const saved = await withOrganization(ds, B, (scope) =>
      stageDraftFlow(scope, agentA, { flow: emptyFlow(), authoringMode: "form" }, null),
    );
    // Null, not an exception: "no such agent", "deleted" and "not yours" are one answer.
    expect(saved).toBeNull();

    const mine = await withOrganization(ds, A, (scope) => loadDraftFlow(scope, agentA));
    expect(mine?.flow?.nodes, "another organisation overwrote a staged graph").toHaveLength(5);
    expect(mine?.authoringMode).not.toBe("form");
  });

  it("refuses to publish one onto another organisation's agent", async () => {
    const agentA = await agentOf(A);
    const planted = await withOrganization(ds, B, (scope) =>
      applyAgentFlow(scope, agentA, { flow: emptyFlow(), authoringMode: "flow" }),
    );
    // False, because RLS on `agents` matched no row — not because a check remembered to run.
    expect(planted).toBe(false);

    const published = await withOrganization(ds, A, (scope) => loadPublishedFlow(scope, agentA));
    expect(published?.authoringMode).toBe("form");
    expect(published?.flow?.nodes).toHaveLength(5);
  });
});
