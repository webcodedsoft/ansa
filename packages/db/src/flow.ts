import type { AuthoringMode, Flow } from "@ansa/shared";

import type { OrganizationScope } from "./organization-scope";

/**
 * The conversation graph, on its way to and from the database (migration 0060).
 *
 * An agent is authored one of two ways. `captured_fields` is an ordered list of questions and
 * is the right shape for a form; a graph is the right shape for a call that branches, and
 * `packages/shared/src/flow.ts` is what both halves of the product agree it looks like. This
 * file is the only place in the db package that reads or writes it.
 *
 * **Two columns, and the mode is the one that decides.** `flow` is the drawing;
 * `authoring_mode` is which editor authored the agent and therefore which director runs the
 * call. An operator who publishes a graph and then switches back to the form has not asked
 * for their canvas to be deleted, so the graph is kept and the mode changes. Nothing here
 * infers the mode from whether the graph is null.
 *
 * **The staged graph and the published graph are different questions and have different
 * functions.** `loadDraftFlow` reads what somebody is still drawing. `loadPublishedFlow`
 * reads what a call would run. Rule 4 is that no call path may ask the first question, and
 * the two names are deliberately not near-synonyms — `apps/api/src/tenancy/call-path.test.ts`
 * scans the call path for the draft API by name, and `loadDraftFlow` and `stageDraftFlow`
 * belong on that list.
 *
 * **The graph is stored, not validated, here.** The API validates with its own schema DSL on
 * the way in and the console with zod, which is what the contract's own header says: a third
 * opinion in a package with no runtime dependency on either would be a third place to keep
 * the same rule. So the row types below name `Flow` and trust the writer, exactly as
 * `drafts.ts` names `AgentConfigFields`.
 */

/** What a call would run, read off the agent's own columns. */
export interface PublishedFlow {
  /** Null when nobody has ever drawn one. Present under `"form"` means a canvas set aside. */
  readonly flow: Flow | null;
  readonly authoringMode: AuthoringMode;
  /** The version this graph belongs to, so a caller can tell two reads apart. */
  readonly configVersion: number;
}

/**
 * What somebody is still drawing.
 *
 * Both fields are independently null and null means *not staged*, not empty — an empty graph
 * is two nodes and an edge, which `emptyFlow()` builds. The distinction is the same one the
 * other staged sections carry since migration 0041, and it is what lets the console show the
 * live value for a section nobody has touched instead of a stale copy of it.
 */
export interface StagedFlow {
  readonly flow: Flow | null;
  readonly authoringMode: AuthoringMode | null;
  readonly updatedAt: string;
}

interface PublishedRow {
  readonly flow: Flow | null;
  readonly authoring_mode: AuthoringMode;
  readonly config_version: number;
}

interface StagedRow {
  readonly flow: Flow | null;
  readonly authoring_mode: AuthoringMode | null;
  /* A `Date`, not a string: the driver parses `timestamptz`, and the API's schema layer
     rejects anything that is not an ISO string. `drafts.ts` records the same trap. */
  readonly updated_at: Date;
}

/**
 * The graph a call would run, or null when the agent is not ours.
 *
 * Through `app.agent_config_for_agent` rather than a select on `agents`, because that
 * function is where "is this agent mine" is already decided — it answers nothing for another
 * organisation's id, which reads exactly as no such agent. A query of our own here would be a
 * second place for that check to be right, and eventually one of them would not be.
 */
export const loadPublishedFlow = async (
  scope: OrganizationScope,
  agentId: string,
): Promise<PublishedFlow | null> => {
  const rows = await scope.query<PublishedRow>(
    `select flow, authoring_mode, config_version from app.agent_config_for_agent($1::uuid)`,
    [agentId],
  );

  const row = rows[0];
  if (row === undefined) return null;
  return {
    flow: row.flow,
    authoringMode: row.authoring_mode,
    configVersion: row.config_version,
  };
};

/**
 * The graph as it was published at one version, or null when that version was a form.
 *
 * `agent_prompt_versions.flow` is non-null exactly when the version answered the phone as a
 * graph, so null here is an answer rather than an absence: a caller restoring version 7 sets
 * the mode from it. Null is also what a version published before migration 0060 returns,
 * which is the correct reading of every one of them.
 */
export const loadFlowAtVersion = async (
  scope: OrganizationScope,
  agentId: string,
  version: number,
): Promise<Flow | null> => {
  const rows = await scope.query<{ flow: Flow | null }>(
    `select flow from app.agent_config_at_version($1::uuid, $2::integer)`,
    [agentId, version],
  );
  return rows[0]?.flow ?? null;
};

/**
 * The staged graph for one agent, or null when there is no draft at all.
 *
 * Null is ordinary and means "nothing unpublished", not "no such agent" — the console asks
 * for this alongside the published graph and shows whichever it has. RLS makes another
 * organisation's draft indistinguishable from an absent one, which is the right answer to
 * both. **Not for the call path.** See the header.
 */
export const loadDraftFlow = async (
  scope: OrganizationScope,
  agentId: string,
): Promise<StagedFlow | null> => {
  const rows = await scope.query<StagedRow>(
    `select flow, authoring_mode, updated_at
       from agent_config_drafts
      where agent_id = $1`,
    [agentId],
  );

  const row = rows[0];
  if (row === undefined) return null;
  return {
    flow: row.flow,
    authoringMode: row.authoring_mode,
    updatedAt: row.updated_at.toISOString(),
  };
};

/**
 * Stage the graph, the mode, or both, leaving every other section of the draft alone.
 *
 * Through `app.stage_agent_draft_selection`, which is the function that stages sections and
 * one of the four allowed to know the drafts table exists. A canvas is a section in exactly
 * the way a tool selection is — its own screen, saved at its own moment — so a graph save
 * must not blank a greeting somebody staged an hour ago, and the SQL coalesces so it cannot.
 *
 * Undefined stages nothing. Passing `emptyFlow()` is how a graph is emptied; there is no way
 * to un-draw one, because the mode is what decides whether it is heard.
 *
 * Null when the agent does not exist, is deleted, or belongs to another organisation — three
 * cases the caller must not be able to tell apart, and which the API answers with one 404.
 */
export const stageDraftFlow = async (
  scope: OrganizationScope,
  agentId: string,
  staged: {
    readonly flow?: Flow | undefined;
    readonly authoringMode?: AuthoringMode | undefined;
  },
  author: string | null,
): Promise<string | null> => {
  const rows = await scope.query<{ stage_agent_draft_selection: Date | null }>(
    /* The five nulls are the sections this caller does not own: the form, the tools, the
       knowledge base and the two behaviour flags. They are positional and coalesced, so a
       null leaves each exactly as it was. */
    `select app.stage_agent_draft_selection($1::uuid, $2::uuid, null::jsonb, null::text[],
                                            null::uuid[], null::boolean, null::boolean,
                                            $3::jsonb, $4::text)
              as stage_agent_draft_selection`,
    [
      agentId,
      author,
      staged.flow === undefined ? null : JSON.stringify(staged.flow),
      staged.authoringMode ?? null,
    ],
  );
  return rows[0]?.stage_agent_draft_selection?.toISOString() ?? null;
};

/**
 * Put a staged graph onto the agent without bumping the version.
 *
 * `applyCapturedFields`' sibling and subject to the same ordering rule: publishing bumps once
 * for the whole act and the snapshot it writes reads the graph off the agent row, so this has
 * to run inside the publish transaction and before `publishAgentConfig`. Called anywhere else
 * it would change what a call runs without recording a version, which is the failure the
 * version history exists to make impossible.
 *
 * Undefined leaves a column alone, so publishing a draft that staged only the mode does not
 * blank the canvas, and one that staged only the canvas does not turn the form back on.
 */
export const applyAgentFlow = async (
  scope: OrganizationScope,
  agentId: string,
  applied: {
    readonly flow?: Flow | undefined;
    readonly authoringMode?: AuthoringMode | undefined;
  },
): Promise<boolean> => {
  const rows = await scope.query<{ apply_agent_flow: boolean }>(
    `select app.apply_agent_flow($1::uuid, $2::jsonb, $3::text) as apply_agent_flow`,
    [
      agentId,
      applied.flow === undefined ? null : JSON.stringify(applied.flow),
      applied.authoringMode ?? null,
    ],
  );
  return rows[0]?.apply_agent_flow ?? false;
};
