import type { BusinessHours } from "@ansa/shared";

import {
  TOTAL_COLUMN,
  pageOrder,
  pageParams,
  toSlice,
  type WithTotal,
  type PageRequest,
  type PageSlice,
} from "./paging";
import type { OrganizationScope } from "./organization-scope";

/**
 * Organization configuration for the dashboard: the current values, the history behind them, and
 * the version a given call actually ran on.
 *
 * `organizations.ts` next door is the call path's view — one round trip, no transaction, the
 * narrow slice the media socket needs, and it deliberately left the version reader unwired
 * because nothing called it. This is the other caller it was waiting for, and it looks
 * different for the reasons the README gives: every function here takes a `OrganizationScope` and
 * none of them takes a organization id, so there is no scope to forget and no id to pass wrong.
 *
 * **`organizations` is the truth and `agent_prompt_versions` is the record.** The call path reads
 * the first, so that is what `loadCurrentAgentConfig` returns; the version row beside it is
 * joined on for the note, the author and the date, and is null when the current version
 * predates migration 0011's backfill. Reading the current configuration out of the history
 * instead would be neater and would quietly lie the first time somebody edits a column in
 * psql without publishing.
 *
 * The one write here goes through `app.publish_agent_config`, which bumps the version and
 * snapshots it in a single statement, exactly as `tools/organization/config.mjs` does. There is no
 * second path into these columns and there must not be one: an `update organizations` that skipped
 * the function would advance the configuration a call runs on while leaving the history
 * pointing at values that no longer exist, which is the failure migration 0011 was written
 * to close.
 */

// ---------------------------------------------------------------------------
// The one place that knows every column a publish writes
// ---------------------------------------------------------------------------

/**
 * Every column `app.publish_agent_config` rewrites, as it stands right now.
 *
 * This interface and `publishConfiguration` below exist because there were briefly two
 * wrappers over that function — one here for agent configuration and one in the dashboard's
 * tools area — and each carried the other's columns forward by hand. Nothing was wrong with
 * either; there is still one SQL function and no second path into the table. The problem was
 * arithmetic: adding a column meant editing both, and forgetting one would have nulled a
 * organization's configuration on their next publish, silently, with the version history recording
 * the loss as intentional.
 *
 * So the carry-forward is the function's job now, not the caller's. A caller says what it is
 * changing and nothing else.
 */
export interface StoredConfiguration {
  readonly name: string;
  readonly voiceId: string | null;
  readonly greeting: string | null;
  readonly persona: string | null;
  readonly instructions: string | null;
  readonly keyterms: readonly string[];
  readonly businessOpenHour: number | null;
  readonly businessCloseHour: number | null;
  readonly businessDays: readonly number[] | null;
  readonly escalationToNumber: string | null;
  readonly escalationFromNumber: string | null;
  readonly escalationRingSeconds: number | null;
  /** The `tools` document, exactly as stored. Its shape belongs to `@ansa/tools`. */
  readonly toolConfig: unknown;
  /** The `events` document, exactly as stored. Same. */
  readonly eventConfig: unknown;
  readonly configVersion: number;
}

interface StoredConfigurationRow {
  name: string;
  voice_id: string | null;
  greeting: string | null;
  persona: string | null;
  instructions: string | null;
  keyterms: string[] | null;
  business_open_hour: number | null;
  business_close_hour: number | null;
  business_days: number[] | null;
  escalation_to_number: string | null;
  escalation_from_number: string | null;
  escalation_ring_seconds: number | null;
  tool_config: unknown;
  event_config: unknown;
  config_version: number;
}

/**
 * Split across two tables since migration 0018.
 *
 * Everything a caller experiences belongs to the agent; the tool registry and the webhook
 * subscriptions belong to the organisation and are shared by its agents. Reading the
 * agent-shaped columns off `organizations` still compiles — the columns are still there — and
 * returns whatever they held before 0018 stopped writing them, which is the quietest
 * possible way to be wrong.
 */
const STORED_COLUMNS = `
  a.name, a.voice_id, a.greeting, a.persona, a.instructions, a.keyterms,
  t.business_open_hour, t.business_close_hour, t.business_days,
  a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
  t.tool_config, t.event_config, a.config_version`;

/**
 * The organization's oldest live agent, matching `app.agent_config_for_organization` and
 * `app.publish_agent_config` exactly.
 *
 * Right while an organisation has one agent and a coin toss the moment it has two, which
 * is why `config.*` is still organization-scoped and why the console has no create form yet. The
 * three places that resolve it agree, so when it becomes agent-scoped they change together.
 */
const OLDEST_LIVE_AGENT = `
  from agents a
  join organizations t on t.id = a.organization_id
 where a.deleted_at is null
 order by a.created_at, a.id
 limit 1`;

/**
 * The whole stored configuration, for a caller about to change part of it.
 *
 * No `where organization_id = …`, and there must not be one: `organizations` has an RLS policy of
 * `id = app.current_organization()`, so this returns exactly one row inside a scope. A predicate
 * would not add safety, it would make it look as though the safety came from the predicate.
 *
 * Null when the organisation has been deleted out from under a live session.
 */
export const readStoredConfiguration = async (
  scope: OrganizationScope,
): Promise<StoredConfiguration | null> => {
  const rows = await scope.query<StoredConfigurationRow>(
    `select ${STORED_COLUMNS} ${OLDEST_LIVE_AGENT}`,
  );
  const row = rows[0];
  if (row === undefined) return null;

  return {
    name: row.name,
    voiceId: row.voice_id,
    greeting: row.greeting,
    persona: row.persona,
    instructions: row.instructions,
    keyterms: row.keyterms ?? [],
    businessOpenHour: row.business_open_hour,
    businessCloseHour: row.business_close_hour,
    businessDays: row.business_days,
    escalationToNumber: row.escalation_to_number,
    escalationFromNumber: row.escalation_from_number,
    escalationRingSeconds: row.escalation_ring_seconds,
    // `undefined` when migration 0013 or 0014 has not been applied — the row comes back
    // without the column at all — and that has to read as "nothing configured" rather than
    // reaching a parser as a value.
    toolConfig: row.tool_config ?? null,
    eventConfig: row.event_config ?? null,
    configVersion: row.config_version,
  };
};

/** What a publish is changing. Anything absent is carried over from `current`. */
export type ConfigurationPatch = Partial<Omit<StoredConfiguration, "configVersion">>;

/** jsonb wants text on the wire; null has to stay null rather than become `"null"`. */
const asJsonb = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);

/**
 * Bump the version and snapshot the whole configuration, in one statement.
 *
 * `current` is passed rather than re-read because callers doing optimistic concurrency have
 * already read it to compare `expectedVersion`, and reading it twice would open the window
 * that check exists to close.
 *
 * The organization id is an argument because the SQL function refuses to run unless
 * `app.organization_id` names it — the function checking the scope, not this layer choosing an
 * organisation. The value comes off the scope, which came off the principal, which came out
 * of a session row RLS agreed to show.
 */
export const publishConfiguration = async (
  scope: OrganizationScope,
  current: StoredConfiguration,
  patch: ConfigurationPatch,
  note: string,
): Promise<number> => {
  const next = { ...current, ...patch };
  const rows = await scope.query<{ version: number }>(
    `select app.publish_agent_config(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
     ) as version`,
    [
      scope.organizationId,
      next.name,
      next.voiceId,
      next.greeting,
      next.persona,
      next.instructions,
      [...next.keyterms],
      next.businessOpenHour,
      next.businessCloseHour,
      next.businessDays === null ? null : [...next.businessDays],
      asJsonb(next.toolConfig),
      asJsonb(next.eventConfig),
      next.escalationToNumber,
      next.escalationFromNumber,
      next.escalationRingSeconds,
      note,
    ],
  );

  const published = rows[0];
  if (published === undefined) throw new Error("publish_organization_config returned no version");
  return Number(published.version);
};

/** Where a transfer goes when the agent gives up (R6.5, migration 0015). */
export interface EscalationConfig {
  /** E.164. The person who picks up. */
  readonly toNumber: string;
  /** E.164, and it must be a number the carrier account owns. */
  readonly fromNumber: string;
  /** Null takes the platform's default rather than storing a guess. */
  readonly ringSeconds: number | null;
}

/**
 * One version of an organisation's configuration — every field a publish writes, and
 * nothing that is set for them rather than by them.
 *
 * `tools` and `events` are absent, and their absence is load-bearing rather than an
 * omission: see `publishAgentConfig`.
 */
export interface AgentConfigFields {
  readonly name: string;
  readonly voiceId: string | null;
  readonly greeting: string | null;
  readonly persona: string | null;
  readonly instructions: string | null;
  readonly keyterms: readonly string[];
  readonly businessHours: BusinessHours | null;
  readonly escalation: EscalationConfig | null;
}

/** Why a version exists, who published it and when. */
export interface ConfigVersionSummary {
  readonly version: number;
  /** Required at publication, so the history answers "why" and not only "what". */
  readonly note: string | null;
  readonly publishedBy: string;
  readonly publishedAt: string;
}

export interface ConfigVersion extends ConfigVersionSummary {
  readonly config: AgentConfigFields;
}

/**
 * The columns on the organization row that the organisation does not set — the operator does.
 *
 * Read here, never written here, and there is no function in this file that could write
 * them. `docs/ORGANIZATION_CONFIGURATION.md` §5 explains each one; the short version is that
 * `dialled_number` is the ingress routing table and the consent columns are the gate on who
 * may be dialled and when, so an organisation that could write either would be deciding
 * whether a rule about somebody else applies to it.
 */
export interface OperatorManagedConfig {
  readonly dialledNumber: string | null;
  readonly audioRetentionDays: number;
  /** `per_number` or `existing_relationship`; see `apps/api/src/outbound/consent.ts`. */
  readonly consentPolicy: string;
  readonly consentBasis: string | null;
  readonly callingEarliestHour: number | null;
  readonly callingLatestHour: number | null;
}

export interface CurrentAgentConfig {
  /** What `calls.config_version` records for a call answered right now. */
  readonly version: number;
  readonly config: AgentConfigFields;
  /**
   * The history row for the current version. Null means the values above are real and the
   * record of how they got there is missing — a row written before migration 0011, or one
   * edited in place rather than published.
   */
  readonly published: ConfigVersionSummary | null;
  readonly operatorManaged: OperatorManagedConfig;
}

/** A call, and the configuration that was in force while it was answered. */
export interface CallConfigTrace {
  readonly callId: string;
  /** Null on a call that was answered before the version was recorded. */
  readonly configVersion: number | null;
  /** Null when that version has no snapshot behind it. */
  readonly version: ConfigVersion | null;
}

/**
 * The columns a configuration snapshot is made of, named once.
 *
 * `organizations` and `agent_prompt_versions` deliberately spell them the same way, so the same
 * list reads either table and a column added to one and forgotten in the other fails here
 * rather than returning silently different shapes from two endpoints.
 */
const CONFIG_COLUMNS = [
  "name",
  "voice_id",
  "greeting",
  "persona",
  "instructions",
  "keyterms",
  "escalation_to_number",
  "escalation_from_number",
  "escalation_ring_seconds",
] as const;

const configColumns = (alias: string): string =>
  CONFIG_COLUMNS.map((column) => `${alias}.${column}`).join(", ");

interface ConfigColumns {
  readonly name: string;
  readonly voice_id: string | null;
  readonly greeting: string | null;
  readonly persona: string | null;
  readonly instructions: string | null;
  readonly keyterms: string[] | null;
  readonly business_open_hour: number | null;
  readonly business_close_hour: number | null;
  readonly business_days: number[] | null;
  readonly escalation_to_number: string | null;
  readonly escalation_from_number: string | null;
  readonly escalation_ring_seconds: number | null;
}

/**
 * Three columns or none, matching the CHECK constraint in migration 0012 and refusing again
 * here — the same reason `organizations.ts` refuses it: two thirds of an opening-hours row cannot
 * be reasoned about, and a database whose migration has not been applied returns the row
 * without these columns at all.
 */
const toBusinessHours = (row: ConfigColumns): BusinessHours | null => {
  const opens = row.business_open_hour;
  const closes = row.business_close_hour;
  const days = row.business_days;
  if (opens == null || closes == null || days == null) return null;
  return { opensAtHour: opens, closesAtHour: closes, openDays: days };
};

/** Both numbers or neither, matching the CHECK constraint in migration 0015. */
const toEscalation = (row: ConfigColumns): EscalationConfig | null => {
  const to = row.escalation_to_number;
  const from = row.escalation_from_number;
  if (to == null || from == null) return null;
  return { toNumber: to, fromNumber: from, ringSeconds: row.escalation_ring_seconds ?? null };
};

const toFields = (row: ConfigColumns): AgentConfigFields => ({
  name: row.name,
  voiceId: row.voice_id,
  greeting: row.greeting,
  persona: row.persona,
  instructions: row.instructions,
  keyterms: row.keyterms ?? [],
  businessHours: toBusinessHours(row),
  escalation: toEscalation(row),
});

interface VersionColumns {
  readonly version: number | null;
  readonly note: string | null;
  readonly published_by: string | null;
  readonly published_at: Date | null;
}

/**
 * Null rather than an invented summary when the join found nothing. A version with no row
 * behind it is exactly the situation R7.5 exists to make visible, so it is reported and not
 * filled in.
 */
const toSummary = (row: VersionColumns): ConfigVersionSummary | null => {
  const version = row.version;
  const publishedAt = row.published_at;
  if (version === null || publishedAt === null) return null;
  return {
    version,
    note: row.note,
    publishedBy: row.published_by ?? "",
    publishedAt: publishedAt.toISOString(),
  };
};

interface CurrentRow extends ConfigColumns, VersionColumns {
  readonly config_version: number;
  readonly dialled_number: string | null;
  readonly audio_retention_days: number;
  readonly consent_policy: string;
  readonly consent_basis: string | null;
  readonly calling_earliest_hour: number | null;
  readonly calling_latest_hour: number | null;
}

/**
 * The organisation's configuration as it stands, with the history row for it alongside.
 *
 * No `where` clause and no organization id, which is the whole point: under RLS `organizations` holds
 * exactly one visible row, so the query that returns the caller's organisation and the query
 * that could return somebody else's are not two different queries with a condition between
 * them — the second one is unwritable.
 */
export const loadCurrentAgentConfig = async (
  scope: OrganizationScope,
): Promise<CurrentAgentConfig | null> => {
  const rows = await scope.query<CurrentRow>(
    `select a.config_version, ${configColumns("a")},
            t.business_open_hour, t.business_close_hour, t.business_days,
            a.dialled_number, t.audio_retention_days, t.consent_policy, t.consent_basis,
            t.calling_earliest_hour, t.calling_latest_hour,
            p.version, p.note, p.published_by, p.published_at
       from agents a
       join organizations t on t.id = a.organization_id
       left join agent_prompt_versions p
         on p.agent_id = a.id and p.version = a.config_version
      where a.deleted_at is null
      order by a.created_at, a.id
      limit 1`,
  );

  const row = rows[0];
  if (row === undefined) return null;
  return {
    version: row.config_version,
    config: toFields(row),
    published: toSummary(row),
    operatorManaged: {
      dialledNumber: row.dialled_number,
      audioRetentionDays: Number(row.audio_retention_days),
      consentPolicy: row.consent_policy,
      consentBasis: row.consent_basis,
      callingEarliestHour: row.calling_earliest_hour,
      callingLatestHour: row.calling_latest_hour,
    },
  };
};

/**
 * The tiebreaker for the history, ordered as a number.
 *
 * It used to be `lpad(p.version::text, 10, '0')`, because the keyset compared tiebreakers
 * as text and `'10' < '9'` lexically. Offset paging does no such comparison — it only
 * orders — so the padding went with the keyset and the column sorts as the integer it is.
 * The tiebreaker itself stays: two versions sharing a `published_at` needs two publishes in
 * one transaction and has never happened, but an arbitrary order under `offset` is a row
 * that appears on two pages or on none, and that is the kind of bug nobody finds.
 */
const VERSION_ORDER = "p.version";

interface VersionRow {
  readonly version: number;
  readonly note: string | null;
  readonly published_by: string;
  readonly published_at: Date;
}

/** Every version this organisation has published, newest first. */
export const listAgentConfigVersions = async (
  scope: OrganizationScope,
  page: PageRequest,
): Promise<PageSlice<ConfigVersionSummary>> => {
  const rows = await scope.query<VersionRow & WithTotal>(
    `select p.version, p.note, p.published_by, p.published_at, ${TOTAL_COLUMN}
       from agent_prompt_versions p
      ${pageOrder("p.published_at", VERSION_ORDER)}`,
    pageParams(page),
  );

  return toSlice(
    rows,
    (row): ConfigVersionSummary => ({
      version: row.version,
      note: row.note,
      publishedBy: row.published_by,
      publishedAt: row.published_at.toISOString(),
    }),
  );
};

interface SnapshotRow extends ConfigColumns, VersionColumns {}

const toVersion = (row: SnapshotRow): ConfigVersion | null => {
  const summary = toSummary(row);
  return summary === null ? null : { ...summary, config: toFields(row) };
};

/**
 * One version, addressable by its number.
 *
 * Null covers both "no such version" and — under RLS — "that version belongs to another
 * organisation", which are deliberately the same answer for the reason the README gives
 * about 404 and 403.
 */
export const loadAgentConfigVersion = async (
  scope: OrganizationScope,
  version: number,
): Promise<ConfigVersion | null> => {
  const rows = await scope.query<SnapshotRow>(
    `select p.version, p.note, p.published_by, p.published_at, ${configColumns("p")}
       from agent_prompt_versions p
      where p.version = $1`,
    [version],
  );
  const row = rows[0];
  return row === undefined ? null : toVersion(row);
};

interface TraceRow extends SnapshotRow {
  readonly call_id: string;
  readonly config_version: number | null;
}

/**
 * The configuration that served one call — R7.5's actual question, asked from the other end.
 *
 * A left join rather than two lookups, because the interesting answers are the ones where
 * the second lookup would have found nothing: a call with no version recorded, and a version
 * with no snapshot behind it, are different failures and both have to survive to the caller
 * rather than collapsing into "not found".
 */
export const loadConfigVersionForCall = async (
  scope: OrganizationScope,
  callId: string,
): Promise<CallConfigTrace | null> => {
  const rows = await scope.query<TraceRow>(
    `select c.id as call_id, c.config_version,
            p.version, p.note, p.published_by, p.published_at, ${configColumns("p")}
       from calls c
       /* Keyed on the agent that took the call, because two agents are routinely both on
          version 3 — organization-plus-version stopped identifying a snapshot the moment an
          organisation had a second one, and would have matched whichever the planner
          reached first.

          The coalesce is for calls answered before migration 0018, which genuinely have no
          agent and never will: back then a organization had exactly one, so organization-plus-version
          identified it precisely. Falling back to that keeps a call from three weeks ago
          explicable, which is the entire point of R7.5 and would otherwise have been the
          quiet cost of the agents table. */
       left join agent_prompt_versions p
         on p.organization_id = c.organization_id
        and p.version = c.config_version
        and p.agent_id = coalesce(c.agent_id, p.agent_id)
      where c.id = $1`,
    [callId],
  );

  const row = rows[0];
  if (row === undefined) return null;
  return { callId: row.call_id, configVersion: row.config_version, version: toVersion(row) };
};

/**
 * Publish a new version: bump `config_version`, snapshot the whole configuration, in one
 * statement. Returns the version that was created.
 *
 * **`tools` and `events` are carried forward, and that is not the same thing as a patch.**
 * `app.publish_agent_config` takes the whole configuration and writes nulls for whatever it
 * is not given — omitting `tools` is how a organization removes their tools, not how they leave
 * them alone. This API does not expose tool or event configuration, so it has no value to
 * send and must not send nothing: the current values are read and passed straight back
 * inside the same transaction, so a publish through the dashboard cannot silently delete a
 * connector somebody configured last week, and the snapshot the version records is still the
 * whole configuration rather than two thirds of it.
 *
 * Same transaction matters. The read and the publish are one unit of work, so there is no
 * window in which another writer's tools could be read, overwritten and lost.
 */
export const publishAgentConfig = async (
  scope: OrganizationScope,
  fields: AgentConfigFields,
  note: string,
): Promise<number> => {
  const current = await readStoredConfiguration(scope);
  if (current === null) {
    // Unreachable through the API — a session cannot exist without the row that owns it —
    // and worth a sentence rather than a null dereference if it ever is reached.
    throw new Error("no organization row is visible in this scope");
  }

  const hours = fields.businessHours;
  const escalation = fields.escalation;

  // Only the columns an organisation sets through the configuration API. `toolConfig` and
  // `eventConfig` are absent on purpose: absent means carried forward, and this API has no
  // value to send for them. Sending nothing would clear them, and the version history would
  // then record a connector somebody configured last week as deliberately deleted.
  return publishConfiguration(
    scope,
    current,
    {
      name: fields.name,
      voiceId: fields.voiceId,
      greeting: fields.greeting,
      persona: fields.persona,
      instructions: fields.instructions,
      keyterms: fields.keyterms,
      businessOpenHour: hours?.opensAtHour ?? null,
      businessCloseHour: hours?.closesAtHour ?? null,
      businessDays: hours === null || hours === undefined ? null : hours.openDays,
      escalationToNumber: escalation?.toNumber ?? null,
      escalationFromNumber: escalation?.fromNumber ?? null,
      escalationRingSeconds: escalation?.ringSeconds ?? null,
    },
    note,
  );
};
