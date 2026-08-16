import type { AgentConfigFields } from "./organization-config";
import type { OrganizationScope } from "./organization-scope";

/**
 * Configuration an operator has saved but not published.
 *
 * The console's Save writes here and nothing else reads it — deliberately. Every live path
 * (`app.agent_config_for_number` and its two siblings) reads the agent's own columns, so a
 * draft reaches a caller only by being published, which copies it across and deletes the row.
 * Nothing has to remember to exclude a draft, because nothing on that path can see one.
 *
 * The document is stored whole rather than as the fields that changed. A publish rewrites the
 * whole configuration, so a partial draft would have to be merged against a live copy that
 * may have moved since — and the merge is where the wrong greeting goes out.
 */

export interface AgentDraft {
  readonly config: AgentConfigFields;
  /** Who last saved it. Null when that account is gone but their work is not. */
  readonly updatedBy: string | null;
  /**
   * The published version this was loaded from, or null when somebody typed it.
   *
   * Restoring an old version fills the draft rather than publishing it, which is the right
   * shape but loses what the old rollback wrote by itself: "restored from version 4", so the
   * history could answer why version 9 looks like version 4. A draft carries no note — a note
   * explains a version — so it carries this instead, and the publish dialog offers it.
   */
  readonly restoredFrom: number | null;
  readonly updatedAt: string;
}

interface DraftRow {
  readonly config: AgentConfigFields;
  readonly updated_by: string | null;
  readonly restored_from: number | null;
  readonly updated_at: string;
}

/**
 * The agent an organisation-scoped configuration endpoint acts on.
 *
 * `config.*` has no agent in its route and resolves one inside the database — the oldest
 * live agent. The draft endpoints have to resolve the same one, or a publish would consume a
 * draft belonging to a different agent than it published to, so both call the same function.
 *
 * Null means the organisation has no live agent, which the API answers with a 404. That is
 * also the only case in which publishing raises rather than returning.
 */
export const liveAgentId = async (scope: OrganizationScope): Promise<string | null> => {
  const rows = await scope.query<{ live_agent_for_organization: string | null }>(
    `select app.live_agent_for_organization($1::uuid) as live_agent_for_organization`,
    [scope.organizationId],
  );
  return rows[0]?.live_agent_for_organization ?? null;
};

/**
 * The unpublished configuration for one agent, or null when there is none.
 *
 * Null is the ordinary case and means "nothing unpublished", not "no such agent" — the
 * console asks for the draft alongside the live configuration and shows whichever it has.
 * RLS makes another organisation's draft indistinguishable from an absent one, which is the
 * right answer to both.
 */
export const loadAgentDraft = async (
  scope: OrganizationScope,
  agentId: string,
): Promise<AgentDraft | null> => {
  const rows = await scope.query<DraftRow>(
    `select config, updated_by, restored_from, updated_at
       from agent_config_drafts
      where agent_id = $1`,
    [agentId],
  );

  const row = rows[0];
  if (row === undefined) return null;
  return {
    config: row.config,
    updatedBy: row.updated_by,
    restoredFrom: row.restored_from,
    updatedAt: row.updated_at,
  };
};

/**
 * Write the draft, replacing whatever was there.
 *
 * Null when the agent does not exist, is deleted, or belongs to another organisation — three
 * cases the caller must not be able to tell apart, and which the API answers with one 404.
 * The function raises rather than returning null when the organisation scope was never set,
 * because a save that quietly wrote nothing looks exactly like a save that worked.
 */
export const saveAgentDraft = async (
  scope: OrganizationScope,
  agentId: string,
  config: AgentConfigFields,
  author: string | null,
  /* Null for an ordinary save. Set only when a published version was loaded in, and cleared
     again by the next edit — once somebody changes a restored draft it is their work. */
  restoredFrom: number | null,
): Promise<string | null> => {
  const rows = await scope.query<{ save_agent_draft: string | null }>(
    `select app.save_agent_draft($1::uuid, $2::jsonb, $3::uuid, $4::integer) as save_agent_draft`,
    [agentId, JSON.stringify(config), author, restoredFrom],
  );
  return rows[0]?.save_agent_draft ?? null;
};

/**
 * Throw the unpublished work away.
 *
 * One of the two reverts the console offers, and the one answering "forget what I have been
 * editing". The other — putting a previously published version back — is a publish, goes
 * through the version history, and lives in `organization-config.ts`. Keeping them apart is
 * the point: a discard leaves no version behind, because a draft nobody published is not a
 * thing that ever answered a call.
 */
export const discardAgentDraft = async (
  scope: OrganizationScope,
  agentId: string,
): Promise<boolean> => {
  const rows = await scope.query<{ discard_agent_draft: boolean }>(
    `select app.discard_agent_draft($1::uuid) as discard_agent_draft`,
    [agentId],
  );
  return rows[0]?.discard_agent_draft ?? false;
};
