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
  readonly updatedAt: string;
}

interface DraftRow {
  readonly config: AgentConfigFields;
  readonly updated_by: string | null;
  readonly updated_at: string;
}

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
    `select config, updated_by, updated_at
       from agent_config_drafts
      where agent_id = $1`,
    [agentId],
  );

  const row = rows[0];
  if (row === undefined) return null;
  return { config: row.config, updatedBy: row.updated_by, updatedAt: row.updated_at };
};

/**
 * Every agent in this organisation holding unpublished work.
 *
 * Needed on the agent list, not only on one agent's page: somebody who saved a greeting on
 * Tuesday and never published it has nothing to remind them otherwise, and "why is the agent
 * still saying the old thing" is the question that follows.
 */
export const agentsWithDrafts = async (scope: OrganizationScope): Promise<readonly string[]> => {
  const rows = await scope.query<{ agent_id: string }>(
    `select agent_id from agent_config_drafts order by updated_at desc`,
  );
  return rows.map((row) => row.agent_id);
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
): Promise<string | null> => {
  const rows = await scope.query<{ save_agent_draft: string | null }>(
    `select app.save_agent_draft($1::uuid, $2::jsonb, $3::uuid) as save_agent_draft`,
    [agentId, JSON.stringify(config), author],
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
