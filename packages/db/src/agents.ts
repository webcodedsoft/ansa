import { asAgentId, asOrganizationId, type AgentId, type OrganizationId } from "@ansa/shared";

import type { OrganizationScope } from "./organization-scope";

/**
 * The agents an organisation runs (migration 0018).
 *
 * Every function takes a `OrganizationScope` rather than a `(Db, organizationId)` pair, so there is no
 * organization id at any call site and nowhere to pass the wrong one — the scope arrives already
 * bound and RLS does the filtering. Inserts read `app.current_organization()` for the same
 * reason: the value the policy checks against is the only value that can be written.
 *
 * The call-answer path in `organizations.ts` is the deliberate exception. It cannot use RLS,
 * because there the organization is the question being asked.
 *
 * One number reaches one agent, and that is a unique index rather than a check written
 * here. The index also refuses a number claimed by a *different* organisation, which no
 * query in this file could see — so the database makes it impossible, and this file's job
 * is only to turn the refusal into an answer a person can act on.
 */

/** Postgres' code for a unique index violation. */
const UNIQUE_VIOLATION = "23505";
/** And for a foreign key: the number is not in this organisation's inventory (0019). */
const FOREIGN_KEY_VIOLATION = "23503";

const codeOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;

const constraintOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "constraint" in error
    ? String((error as { constraint?: unknown }).constraint)
    : undefined;

/**
 * Raised when a number cannot be routed to this agent.
 *
 * Two database refusals collapse into one error on purpose, and the message does not say
 * which fired. `agents_dialled_number_idx` means some agent already answers that number;
 * `agents_number_held_by_organization` means it is not in this organisation's inventory. Telling
 * them apart would tell a caller whether a number is live on the platform at all, and an
 * organisation could walk a number range to learn who else is a customer.
 *
 * So the answer is the same either way: not a number you can route.
 */
export class NumberNotRoutable extends Error {
  constructor(readonly dialledNumber: string) {
    super(`Number is not available to route: ${dialledNumber}`);
    this.name = "NumberNotRoutable";
  }
}

const asRoutingRefusal = (error: unknown, dialledNumber: string | null): never => {
  const code = codeOf(error);
  const constraint = constraintOf(error);
  const routing =
    (code === UNIQUE_VIOLATION && constraint === "agents_dialled_number_idx") ||
    (code === FOREIGN_KEY_VIOLATION && constraint === "agents_number_held_by_organization");
  if (routing) throw new NumberNotRoutable(dialledNumber ?? "");
  throw error;
};

export interface AgentSummary {
  readonly agentId: AgentId;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly persona: string | null;
  readonly greeting: string | null;
  /**
   * The organisation's own rules for this agent, layered onto the base prompt.
   *
   * Never replacing it: `compileOrganizationLayer` is the only way to produce the value the
   * composer accepts, so a rule that tries to weaken a guarantee is dropped at call time
   * rather than trusted because it was stored.
   */
  readonly instructions: string | null;
  readonly voiceId: string | null;
  readonly dialledNumber: string | null;
  readonly configVersion: number;
  readonly enabledTools: readonly string[];
  /** Which of the organisation's knowledge sources this agent may answer from. */
  readonly knowledgeSources: readonly string[];
  /** The caller may interrupt. See migration 0020 for why this one is settable. */
  readonly bargeIn: boolean;
  /** Outbound calls that reach voicemail hang up instead of talking to a greeting. */
  readonly answeringMachineDetection: boolean;
  /**
   * The voice form this agent conducts, in the order it asks (migration 0021).
   *
   * `unknown[]` deliberately: the shape belongs to the API layer that validates it, and
   * parsing it here would put the same rules in two places and point the dependency the
   * wrong way — the same argument `toolConfig` makes in `organizations.ts`.
   */
  readonly capturedFields: readonly unknown[];
  readonly deletedAt: string | null;
  readonly createdAt: string;
}

interface AgentRow {
  id: string;
  organization_id: string;
  name: string;
  persona: string | null;
  greeting: string | null;
  instructions: string | null;
  voice_id: string | null;
  dialled_number: string | null;
  config_version: number;
  enabled_tools: string[] | null;
  knowledge_sources: string[] | null;
  barge_in: boolean;
  answering_machine_detection: boolean;
  captured_fields: unknown[] | null;
  deleted_at: Date | string | null;
  created_at: Date | string;
}

/** Postgres hands back `Date` for timestamptz; the API speaks ISO 8601 and nothing else. */
const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;

const toSummary = (row: AgentRow): AgentSummary => ({
  agentId: asAgentId(row.id),
  organizationId: asOrganizationId(row.organization_id),
  name: row.name,
  persona: row.persona,
  greeting: row.greeting,
  instructions: row.instructions,
  voiceId: row.voice_id,
  dialledNumber: row.dialled_number,
  configVersion: row.config_version,
  enabledTools: row.enabled_tools ?? [],
  knowledgeSources: row.knowledge_sources ?? [],
  bargeIn: row.barge_in,
  answeringMachineDetection: row.answering_machine_detection,
  capturedFields: row.captured_fields ?? [],
  deletedAt: row.deleted_at === null ? null : iso(row.deleted_at),
  createdAt: iso(row.created_at),
});

const COLUMNS = `
  a.id, a.organization_id, a.name, a.persona, a.greeting, a.instructions, a.voice_id,
  a.dialled_number,
  a.config_version, a.barge_in, a.answering_machine_detection, a.captured_fields,
  a.deleted_at, a.created_at,
  (select coalesce(array_agg(t.tool_name order by t.tool_name), '{}')
     from agent_tools t where t.agent_id = a.id) as enabled_tools,
  /* Live sources only. A retired one stays joined so the retrieval history it earned still
     resolves, but offering it back on the selection screen would invite somebody to tick a
     source that can never be searched. */
  (select coalesce(array_agg(k.source_id::text order by k.source_id), '{}')
     from agent_knowledge_sources k
     join knowledge_sources s on s.id = k.source_id
    where k.agent_id = a.id and s.deleted_at is null) as knowledge_sources
`;

/**
 * Every agent this organisation runs, oldest first.
 *
 * Oldest first rather than newest: this is a list navigated by position, and the agent
 * that has been answering for a year should not move down the page because a colleague
 * drafted a new one this morning.
 *
 * Archived agents are included, because a call log that references one still needs its
 * name. Callers offering a choice filter on `deletedAt`.
 */
export const listAgents = async (scope: OrganizationScope): Promise<readonly AgentSummary[]> => {
  const rows = await scope.query<AgentRow>(
    `select ${COLUMNS} from agents a order by a.created_at, a.id`,
  );
  return rows.map(toSummary);
};

export const findAgent = async (
  scope: OrganizationScope,
  agentId: string,
): Promise<AgentSummary | null> => {
  const rows = await scope.query<AgentRow>(`select ${COLUMNS} from agents a where a.id = $1`, [
    agentId,
  ]);
  const row = rows[0];
  return row === undefined ? null : toSummary(row);
};

export interface NewAgent {
  readonly name: string;
  readonly persona?: string | null;
  readonly greeting?: string | null;
  readonly instructions?: string | null;
  readonly voiceId?: string | null;
  /** Optional. An agent can be written and reviewed before it is given a line. */
  readonly dialledNumber?: string | null;
}

/**
 * Add an agent to this organisation.
 *
 * Starts at version 1 with no tools selected. Both are deliberate: a new agent is not a
 * copy of an existing one, and it certainly does not inherit permission to call the
 * organisation's write-tier endpoints because a sibling agent can.
 */
export const createAgent = async (scope: OrganizationScope, agent: NewAgent): Promise<AgentSummary> => {
  const inserted = await scope
    .query<{ id: string }>(
      `insert into agents
         (organization_id, name, persona, greeting, instructions, voice_id, dialled_number)
       values (app.current_organization(), $1, $2, $3, $4, $5, $6)
       returning id`,
      [
        agent.name,
        agent.persona ?? null,
        agent.greeting ?? null,
        agent.instructions ?? null,
        agent.voiceId ?? null,
        agent.dialledNumber ?? null,
      ],
    )
    .catch((error: unknown) => asRoutingRefusal(error, agent.dialledNumber ?? null));

  const created = inserted[0];
  if (created === undefined) {
    // An insert returning no row under RLS means `with check` refused it, which here can
    // only mean the scope is not bound to the organisation being written to.
    throw new Error("Insert returned no row — the organization scope is wrong.");
  }

  const row = await findAgent(scope, created.id);
  if (row === null) throw new Error("Agent vanished between insert and read.");
  return row;
};

export interface AgentEdit {
  readonly name?: string;
  readonly persona?: string | null;
  readonly greeting?: string | null;
  readonly instructions?: string | null;
  readonly voiceId?: string | null;
  /** Null unroutes the agent, a number moves it, omitted leaves it alone. */
  readonly dialledNumber?: string | null;
  readonly bargeIn?: boolean;
  readonly answeringMachineDetection?: boolean;
}

/**
 * Rename an agent, or move which number reaches it.
 *
 * Only the keys present are written. `coalesce` would make "set the persona to null"
 * indistinguishable from "leave the persona alone", and unrouting an agent has to be
 * expressible. Returns null when no live agent of that id belongs to this organisation —
 * under RLS that is the same answer as no such agent at all, which is the truthful one.
 */
export const updateAgent = async (
  scope: OrganizationScope,
  agentId: string,
  edit: AgentEdit,
): Promise<AgentSummary | null> => {
  const sets: string[] = [];
  const values: unknown[] = [agentId];

  const set = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (edit.name !== undefined) set("name", edit.name);
  if (edit.persona !== undefined) set("persona", edit.persona);
  if (edit.greeting !== undefined) set("greeting", edit.greeting);
  if (edit.instructions !== undefined) set("instructions", edit.instructions);
  if (edit.voiceId !== undefined) set("voice_id", edit.voiceId);
  if (edit.dialledNumber !== undefined) set("dialled_number", edit.dialledNumber);
  if (edit.bargeIn !== undefined) set("barge_in", edit.bargeIn);
  if (edit.answeringMachineDetection !== undefined) {
    set("answering_machine_detection", edit.answeringMachineDetection);
  }

  if (sets.length === 0) return findAgent(scope, agentId);

  /* `mutate`, not `query`. An update with `returning` comes back as `[rows, affectedCount]`,
     so a length check on `query` is always 2 and never zero — and `findAgent` below does not
     filter `deleted_at`, deliberately, because a call log needs a retired agent's name. The
     two together meant editing a deleted agent answered 200 with the agent unchanged. */
  const updated = await scope
    .mutate<{ id: string }>(
      `update agents set ${sets.join(", ")}
        where id = $1 and deleted_at is null
        returning id`,
      values,
    )
    .catch((error: unknown) => asRoutingRefusal(error, edit.dialledNumber ?? null));

  if (updated.length === 0) return null;
  return findAgent(scope, agentId);
};

/**
 * Retire an agent, releasing its number in the same statement.
 *
 * Archived rather than deleted: `calls.agent_id` points here for the life of the call log,
 * and deleting the agent would take the explanation of every call it handled with it.
 *
 * Releasing the number is not a courtesy. The ingress lookup already refuses to answer for
 * an archived agent, so leaving it attached would reserve a line that rings nobody and
 * cannot be reassigned — a dead number the organisation keeps paying for.
 */
export const archiveAgent = async (scope: OrganizationScope, agentId: string): Promise<boolean> => {
  // `mutate` for the reason its doc comment gives: `query` returns `[rows, affectedCount]`
  // for an update, so this reported success for an agent it had not touched — including one
  // that does not exist, and one archived a second time.
  const rows = await scope.mutate<{ id: string }>(
    `update agents set deleted_at = now(), dialled_number = null
      where id = $1 and deleted_at is null
      returning id`,
    [agentId],
  );
  return rows.length > 0;
};

/**
 * Replace which shared tools this agent may call.
 *
 * Wholesale, and inside the scope's own transaction, so the delete and the insert commit
 * together. A partial apply would leave an agent holding a selection nobody chose, and the
 * half most likely to survive alone is the delete — an agent that silently lost its tools.
 *
 * Names are not validated against the registry here, on purpose. The registry is a jsonb
 * document that can change after this row is written, so a name that resolves today may
 * not tomorrow. Dispatch is where a selection meets reality, and an unknown name there
 * already fails exactly as an unregistered tool does.
 *
 * Null when there is no such agent, so the caller answers 404 rather than reporting that
 * it saved a selection against nothing.
 */
export const setAgentTools = async (
  scope: OrganizationScope,
  agentId: string,
  toolNames: readonly string[],
): Promise<readonly string[] | null> => {
  // A retired agent keeps no tools. Without the filter its selection could still be edited,
  // and `prepareConnectors` would register them the moment it was brought back.
  const live = await scope.query<{ id: string }>(
    `select id from agents where id = $1 and deleted_at is null`,
    [agentId],
  );
  if (live.length === 0) return null;

  await scope.query(`delete from agent_tools where agent_id = $1`, [agentId]);

  const unique = [...new Set(toolNames)].sort();
  if (unique.length > 0) {
    await scope.query(
      `insert into agent_tools (organization_id, agent_id, tool_name)
       select app.current_organization(), $1, unnest($2::text[])`,
      [agentId, unique],
    );
  }
  return unique;
};

/**
 * Replace the form this agent conducts.
 *
 * Sent whole rather than patched, for the reason the tool selection is: order is part of
 * the meaning here, and a patch protocol over an ordered array is a reorder API nobody
 * asked for. What is on screen is what gets stored.
 *
 * Null when there is no such live agent, so the caller answers 404 rather than reporting
 * that it saved a form against nothing.
 */
export const setCapturedFields = async (
  scope: OrganizationScope,
  agentId: string,
  fields: readonly unknown[],
): Promise<AgentSummary | null> => {
  /* Through the versioned path, not a bare update. Writing the column directly left
     `config_version` unchanged, so two calls could record the same version and have
     collected different things — and nothing anywhere recorded what an agent had been
     asking callers for. For a form whose whole purpose is taking names and policy numbers
     off people, that history is the audit (migration 0029). */
  const published = await scope.query<{ version: number | null }>(
    `select app.publish_captured_fields($1, $2::jsonb, $3) as version`,
    [agentId, JSON.stringify(fields), "captured fields updated"],
  );
  // Null rather than an exception for no such live agent, so the API answers 404 instead
  // of 500 — the same three cases the function deliberately does not tell apart.
  if (published[0]?.version === null || published[0]?.version === undefined) return null;
  return findAgent(scope, agentId);
};
