import { asOrganizationId, type OrganizationId } from "@ansa/shared";

import type { OrganizationScope } from "./organization-scope";

/**
 * What an organisation has told its agents, and which of it each agent may reach (0034).
 *
 * The shape is `agents.ts` again on purpose: every function takes a `OrganizationScope`, so
 * there is no organization id at any call site and nowhere to pass the wrong one, and every
 * insert reads `app.current_organization()` so the value the policy checks against is the
 * only value that can be written.
 *
 * Sources belong to the organisation and an agent selects from them, exactly as it selects
 * tools. That is why `setAgentKnowledgeSources` below reads almost identically to
 * `setAgentTools` — it is the same operation over a different registry, and the day the two
 * stop looking alike is the day one of them has grown a rule the other should have had.
 *
 * Retrieval is Postgres full text, and the join through `agent_knowledge_sources` is the
 * whole security property: an agent can be asked about anything, and must only ever be able
 * to answer out of what it was given.
 */

/**
 * How a source was written, which decides how it was split into units.
 *
 * `knowledge_sources_kind_check` in 0034 is the enforcement. This union exists so a caller
 * cannot reach the constraint by accident, not instead of it.
 */
export type KnowledgeKind = "faq" | "table" | "document";

export interface KnowledgeSourceSummary {
  readonly sourceId: string;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly kind: KnowledgeKind;
  /** How many retrievable units it was split into. Zero means it answers nothing. */
  readonly unitCount: number;
  /**
   * How often this source answered in the last seven days.
   *
   * The number a person maintaining a knowledge base actually needs: a source at zero is
   * either badly written or about something nobody rings up to ask, and neither is visible
   * from reading the source itself.
   */
  readonly retrievalsLast7Days: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One retrievable fact. `question` is null for a document section or a table row. */
export interface KnowledgeUnit {
  readonly unitId: string;
  readonly position: number;
  readonly question: string | null;
  readonly body: string;
}

export interface KnowledgeHit {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly question: string | null;
  readonly body: string;
  readonly rank: number;
}

interface SourceRow {
  id: string;
  organization_id: string;
  name: string;
  kind: string;
  unit_count: number;
  retrievals_7d: number;
  deleted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface UnitRow {
  id: string;
  position: number;
  question: string | null;
  body: string;
}

interface HitRow {
  source_id: string;
  source_name: string;
  question: string | null;
  body: string;
  rank: number;
}

/** Postgres hands back `Date` for timestamptz; the API speaks ISO 8601 and nothing else. */
const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;

const toSummary = (row: SourceRow): KnowledgeSourceSummary => ({
  sourceId: row.id,
  organizationId: asOrganizationId(row.organization_id),
  name: row.name,
  // Narrowed rather than checked: `knowledge_sources_kind_check` is what makes this true,
  // and re-validating a value the database refuses to store would be theatre.
  kind: row.kind as KnowledgeKind,
  unitCount: row.unit_count,
  retrievalsLast7Days: row.retrievals_7d,
  deletedAt: row.deleted_at === null ? null : iso(row.deleted_at),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const toUnit = (row: UnitRow): KnowledgeUnit => ({
  unitId: row.id,
  position: row.position,
  question: row.question,
  body: row.body,
});

const toHit = (row: HitRow): KnowledgeHit => ({
  sourceId: row.source_id,
  sourceName: row.source_name,
  question: row.question,
  body: row.body,
  rank: row.rank,
});

/*
 * Both counts as correlated subqueries rather than two left joins and a group by. The listing
 * is per-source and small, and an aggregate over a join would have to be written carefully
 * enough that a source with units and no retrievals still appeared — the classic way to lose
 * exactly the rows this screen exists to show.
 */
const COLUMNS = `
  s.id, s.organization_id, s.name, s.kind, s.deleted_at, s.created_at, s.updated_at,
  (select count(*)::int from knowledge_units u where u.source_id = s.id) as unit_count,
  (select count(*)::int from knowledge_retrievals r
     where r.source_id = s.id and r.at > now() - interval '7 days') as retrievals_7d
`;

/**
 * Every live source this organisation holds, oldest first.
 *
 * Oldest first for the reason `listAgents` gives: this is a list navigated by position, and
 * the FAQ that has been answering all year should not move down the page because a colleague
 * uploaded a price list this morning.
 *
 * Deleted sources are excluded, unlike archived agents. An agent is kept because the call log
 * still names it; a source is not named anywhere a person reads — `knowledge_retrievals` holds
 * its id, and that row survives the delete either way.
 */
export const listKnowledgeSources = async (
  scope: OrganizationScope,
): Promise<readonly KnowledgeSourceSummary[]> => {
  const rows = await scope.query<SourceRow>(
    `select ${COLUMNS} from knowledge_sources s
      where s.deleted_at is null
      order by s.created_at, s.id`,
  );
  return rows.map(toSummary);
};

export const findKnowledgeSource = async (
  scope: OrganizationScope,
  sourceId: string,
): Promise<KnowledgeSourceSummary | null> => {
  const rows = await scope.query<SourceRow>(
    `select ${COLUMNS} from knowledge_sources s where s.id = $1 and s.deleted_at is null`,
    [sourceId],
  );
  const row = rows[0];
  return row === undefined ? null : toSummary(row);
};

/** The units of one source, in the order they were written. */
export const listKnowledgeUnits = async (
  scope: OrganizationScope,
  sourceId: string,
): Promise<readonly KnowledgeUnit[]> => {
  const rows = await scope.query<UnitRow>(
    `select u.id, u.position, u.question, u.body
       from knowledge_units u
       join knowledge_sources s on s.id = u.source_id
      where u.source_id = $1 and s.deleted_at is null
      order by u.position, u.id`,
    [sourceId],
  );
  return rows.map(toUnit);
};

export interface NewKnowledgeUnit {
  /** Null for a document section or a table row, which answer a question nobody wrote down. */
  readonly question?: string | null;
  readonly body: string;
}

export interface NewKnowledgeSource {
  readonly name: string;
  readonly kind: KnowledgeKind;
  readonly units: readonly NewKnowledgeUnit[];
}

/*
 * Position comes from the array index and is never sent by the caller.
 *
 * Sent whole rather than patched, for the reason `setCapturedFields` gives: order is part of
 * the meaning, and a patch protocol over an ordered array is a reorder API nobody asked for.
 * What was uploaded is what gets stored.
 *
 * The delete and the insert run inside the scope's own transaction, so a source is never left
 * holding half of a re-upload — and the half most likely to survive alone is the delete, which
 * is a source that has silently stopped answering.
 */
const replaceUnits = async (
  scope: OrganizationScope,
  sourceId: string,
  units: readonly NewKnowledgeUnit[],
): Promise<void> => {
  await scope.query(`delete from knowledge_units where source_id = $1`, [sourceId]);
  if (units.length === 0) return;

  await scope.query(
    `insert into knowledge_units (organization_id, source_id, position, question, body)
     select app.current_organization(), $1, (u.ordinality - 1)::int, u.question, u.body
       from unnest($2::text[], $3::text[]) with ordinality as u(question, body, ordinality)`,
    [sourceId, units.map((unit) => unit.question ?? null), units.map((unit) => unit.body)],
  );
};

/**
 * Add a source and the units it was split into, in one transaction.
 *
 * No agent is given it. That is the same refusal `createAgent` makes about tools: a new source
 * does not become answerable by every agent in the organisation because it was uploaded, and
 * defaulting an empty selection to full access would make adding a source the most dangerous
 * operation on the screen.
 */
export const createKnowledgeSource = async (
  scope: OrganizationScope,
  source: NewKnowledgeSource,
): Promise<KnowledgeSourceSummary> => {
  const inserted = await scope.query<{ id: string }>(
    `insert into knowledge_sources (organization_id, name, kind)
     values (app.current_organization(), $1, $2)
     returning id`,
    [source.name, source.kind],
  );

  const created = inserted[0];
  if (created === undefined) {
    // An insert returning no row under RLS means `with check` refused it, which here can
    // only mean the scope is not bound to the organisation being written to.
    throw new Error("Insert returned no row — the organization scope is wrong.");
  }

  await replaceUnits(scope, created.id, source.units);

  const row = await findKnowledgeSource(scope, created.id);
  if (row === null) throw new Error("Knowledge source vanished between insert and read.");
  return row;
};

/**
 * Replace what a source says.
 *
 * Null when there is no such live source, so the caller answers 404 rather than reporting that
 * it saved a re-upload against nothing.
 */
export const setKnowledgeUnits = async (
  scope: OrganizationScope,
  sourceId: string,
  units: readonly NewKnowledgeUnit[],
): Promise<KnowledgeSourceSummary | null> => {
  const live = await scope.query<{ id: string }>(
    `select id from knowledge_sources where id = $1 and deleted_at is null`,
    [sourceId],
  );
  if (live.length === 0) return null;

  await replaceUnits(scope, sourceId, units);
  return findKnowledgeSource(scope, sourceId);
};

/**
 * Retire a source. Its units stop being retrievable in the same statement.
 *
 * Soft, on the 0032 terms: `knowledge_retrievals` points here for as long as the usage history
 * is worth anything, and a hard delete would cascade away the record of what had been
 * answering callers. Search and both listings filter `deleted_at`, so the source goes quiet
 * immediately — the selections in `agent_knowledge_sources` are left where they are because
 * nothing reads them without joining through here.
 *
 * `mutate`, not `query`: TypeORM hands back `[rows, count]` for an update, so a length check on
 * `query` is always true and would report success for a row it did not touch.
 */
export const deleteKnowledgeSource = async (
  scope: OrganizationScope,
  sourceId: string,
): Promise<boolean> => {
  const rows = await scope.mutate<{ id: string }>(
    `update knowledge_sources set deleted_at = now()
      where id = $1 and deleted_at is null
      returning id`,
    [sourceId],
  );
  return rows.length > 0;
};

/**
 * Replace which of the organisation's sources this agent may retrieve from.
 *
 * Wholesale and inside the scope's own transaction, for the reason `setAgentTools` gives: a
 * partial apply would leave an agent holding a selection nobody chose.
 *
 * Unlike tool names, source ids are rows with a foreign key, so the insert selects through
 * `knowledge_sources` rather than trusting the list. An id that names a deleted source, or one
 * belonging to another organisation that RLS has already hidden, drops out silently instead of
 * raising a constraint violation — and the returned list is what was actually stored, not what
 * was asked for, so the caller can show the difference.
 *
 * Null when there is no such live agent, so the caller answers 404.
 */
export const setAgentKnowledgeSources = async (
  scope: OrganizationScope,
  agentId: string,
  sourceIds: readonly string[],
): Promise<readonly string[] | null> => {
  const live = await scope.query<{ id: string }>(
    `select id from agents where id = $1 and deleted_at is null`,
    [agentId],
  );
  if (live.length === 0) return null;

  await scope.query(`delete from agent_knowledge_sources where agent_id = $1`, [agentId]);

  const unique = [...new Set(sourceIds)];
  if (unique.length === 0) return [];

  const stored = await scope.query<{ id: string }>(
    `insert into agent_knowledge_sources (organization_id, agent_id, source_id)
     select app.current_organization(), $1, s.id
       from knowledge_sources s
      where s.id = any($2::uuid[]) and s.deleted_at is null
     returning source_id as id`,
    [agentId, unique],
  );
  return stored.map((row) => row.id).sort();
};

/** Which sources this agent may retrieve from, as ids. */
export const listAgentKnowledgeSources = async (
  scope: OrganizationScope,
  agentId: string,
): Promise<readonly string[]> => {
  const rows = await scope.query<{ id: string }>(
    `select a.source_id as id
       from agent_knowledge_sources a
       join knowledge_sources s on s.id = a.source_id
      where a.agent_id = $1 and s.deleted_at is null
      order by a.source_id`,
    [agentId],
  );
  return rows.map((row) => row.id);
};

/*
 * More than this many hits cannot be used and should not be paid for.
 *
 * A turn is two sentences. Twenty units is already far more context than the model will spend
 * on one answer, and a caller who asked for five hundred has a bug, not a requirement.
 */
const MAX_HITS = 20;

/**
 * Full-text search across the sources THIS AGENT is allowed to use.
 *
 * The join through `agent_knowledge_sources` is not a filter that could be moved into a
 * `where` clause the caller passes — it is the reason an agent cannot answer out of a source
 * it was never given, and it is written here so that no retrieval path exists without it.
 *
 * `websearch_to_tsquery` rather than `plainto_tsquery` because it understands quotes and `or`,
 * and — the part that matters on this path — it never raises on malformed input. A caller's
 * question arrives from speech recognition and can contain anything at all; `to_tsquery` would
 * throw on a stray operator and turn a bad transcription into a failed turn.
 *
 * 'english' must match the config the generated `search` column was built with. A query parsed
 * under a different one silently matches nothing, which reads as an empty knowledge base.
 *
 * Ranked by `ts_rank`, which reads the A/B weights 0034 set: a unit whose *question* matches
 * beats one that merely mentions the words in a long answer. Ties break on position, so an FAQ
 * that lists the common case first still answers with it.
 */
export const searchKnowledge = async (
  scope: OrganizationScope,
  agentId: string,
  query: string,
  limit: number,
): Promise<readonly KnowledgeHit[]> => {
  const wanted = Math.min(Math.max(Math.trunc(limit), 0), MAX_HITS);
  if (wanted === 0) return [];

  const rows = await scope.query<HitRow>(
    `select u.source_id, s.name as source_name, u.question, u.body,
            ts_rank(u.search, q.query) as rank
       from knowledge_units u
       join knowledge_sources s on s.id = u.source_id
       join agent_knowledge_sources a on a.source_id = u.source_id and a.agent_id = $1
      cross join websearch_to_tsquery('english', $2) as q(query)
      where s.deleted_at is null and u.search @@ q.query
      order by rank desc, u.position, u.id
      limit $3`,
    [agentId, query, wanted],
  );
  return rows.map(toHit);
};

/**
 * Record that these sources answered, on this call.
 *
 * Written from the answer path while the caller is waiting, so it is built to be impossible to
 * fail on: the select through `knowledge_sources` means an id that no longer resolves is
 * skipped rather than raising a foreign key violation mid-turn. A source deleted between the
 * search and this write loses its retrieval, which is the right way round — a bookkeeping row
 * is never worth a dropped turn.
 *
 * `callId` is null for a retrieval outside a call, as in a console search.
 */
export const recordKnowledgeRetrieval = async (
  scope: OrganizationScope,
  sourceIds: readonly string[],
  callId: string | null,
): Promise<void> => {
  const unique = [...new Set(sourceIds)];
  if (unique.length === 0) return;

  await scope.query(
    `insert into knowledge_retrievals (organization_id, source_id, call_id)
     select app.current_organization(), s.id, $2
       from knowledge_sources s
      where s.id = any($1::uuid[]) and s.deleted_at is null`,
    [unique, callId],
  );
};
