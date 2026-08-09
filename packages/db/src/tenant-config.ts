import type { BusinessHours } from "@ansa/shared";

import {
  keysetOrder,
  keysetParams,
  keysetWhere,
  toSlice,
  type PageRequest,
  type PageSlice,
} from "./paging";
import type { TenantScope } from "./tenant-scope";

/**
 * Tenant configuration for the dashboard: the current values, the history behind them, and
 * the version a given call actually ran on.
 *
 * `tenants.ts` next door is the call path's view — one round trip, no transaction, the
 * narrow slice the media socket needs, and it deliberately left the version reader unwired
 * because nothing called it. This is the other caller it was waiting for, and it looks
 * different for the reasons the README gives: every function here takes a `TenantScope` and
 * none of them takes a tenant id, so there is no scope to forget and no id to pass wrong.
 *
 * **`tenants` is the truth and `tenant_prompt_versions` is the record.** The call path reads
 * the first, so that is what `loadCurrentTenantConfig` returns; the version row beside it is
 * joined on for the note, the author and the date, and is null when the current version
 * predates migration 0011's backfill. Reading the current configuration out of the history
 * instead would be neater and would quietly lie the first time somebody edits a column in
 * psql without publishing.
 *
 * The one write here goes through `app.publish_tenant_config`, which bumps the version and
 * snapshots it in a single statement, exactly as `tools/tenant/config.mjs` does. There is no
 * second path into these columns and there must not be one: an `update tenants` that skipped
 * the function would advance the configuration a call runs on while leaving the history
 * pointing at values that no longer exist, which is the failure migration 0011 was written
 * to close.
 */

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
 * omission: see `publishTenantConfig`.
 */
export interface TenantConfigFields {
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
  readonly config: TenantConfigFields;
}

/**
 * The columns on the tenant row that the organisation does not set — the operator does.
 *
 * Read here, never written here, and there is no function in this file that could write
 * them. `docs/TENANT_CONFIGURATION.md` §5 explains each one; the short version is that
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

export interface CurrentTenantConfig {
  /** What `calls.config_version` records for a call answered right now. */
  readonly version: number;
  readonly config: TenantConfigFields;
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
 * `tenants` and `tenant_prompt_versions` deliberately spell them the same way, so the same
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
  "business_open_hour",
  "business_close_hour",
  "business_days",
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
 * here — the same reason `tenants.ts` refuses it: two thirds of an opening-hours row cannot
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

const toFields = (row: ConfigColumns): TenantConfigFields => ({
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
 * No `where` clause and no tenant id, which is the whole point: under RLS `tenants` holds
 * exactly one visible row, so the query that returns the caller's organisation and the query
 * that could return somebody else's are not two different queries with a condition between
 * them — the second one is unwritable.
 */
export const loadCurrentTenantConfig = async (
  scope: TenantScope,
): Promise<CurrentTenantConfig | null> => {
  const rows = await scope.query<CurrentRow>(
    `select t.config_version, ${configColumns("t")},
            t.dialled_number, t.audio_retention_days, t.consent_policy, t.consent_basis,
            t.calling_earliest_hour, t.calling_latest_hour,
            p.version, p.note, p.published_by, p.published_at
       from tenants t
       left join tenant_prompt_versions p
         on p.tenant_id = t.id and p.version = t.config_version
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
 * The keyset tiebreaker for the history, zero-padded so it sorts as a number.
 *
 * `keysetWhere` compares the tiebreaker as text, and `'10' < '9'` lexically. Two versions
 * sharing a `published_at` needs two publishes in one transaction and has never happened,
 * but a pagination bug that only appears under that condition is the kind nobody finds — so
 * the ordering is made correct rather than made unlikely.
 */
const PADDED_VERSION = "lpad(p.version::text, 10, '0')";

const padVersion = (version: number): string => String(version).padStart(10, "0");

interface VersionRow {
  readonly version: number;
  readonly note: string | null;
  readonly published_by: string;
  readonly published_at: Date;
}

/** Every version this organisation has published, newest first. */
export const listTenantConfigVersions = async (
  scope: TenantScope,
  page: PageRequest,
): Promise<PageSlice<ConfigVersionSummary>> => {
  const rows = await scope.query<VersionRow>(
    `select p.version, p.note, p.published_by, p.published_at
       from tenant_prompt_versions p
      where ${keysetWhere("p.published_at", PADDED_VERSION)}
      ${keysetOrder("p.published_at", PADDED_VERSION)}`,
    keysetParams(page),
  );

  const versions = rows.map(
    (row): ConfigVersionSummary => ({
      version: row.version,
      note: row.note,
      publishedBy: row.published_by,
      publishedAt: row.published_at.toISOString(),
    }),
  );
  return toSlice(versions, page, (summary) => ({
    createdAt: summary.publishedAt,
    id: padVersion(summary.version),
  }));
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
export const loadTenantConfigVersion = async (
  scope: TenantScope,
  version: number,
): Promise<ConfigVersion | null> => {
  const rows = await scope.query<SnapshotRow>(
    `select p.version, p.note, p.published_by, p.published_at, ${configColumns("p")}
       from tenant_prompt_versions p
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
  scope: TenantScope,
  callId: string,
): Promise<CallConfigTrace | null> => {
  const rows = await scope.query<TraceRow>(
    `select c.id as call_id, c.config_version,
            p.version, p.note, p.published_by, p.published_at, ${configColumns("p")}
       from calls c
       left join tenant_prompt_versions p
         on p.tenant_id = c.tenant_id and p.version = c.config_version
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
 * `app.publish_tenant_config` takes the whole configuration and writes nulls for whatever it
 * is not given — omitting `tools` is how a tenant removes their tools, not how they leave
 * them alone. This API does not expose tool or event configuration, so it has no value to
 * send and must not send nothing: the current values are read and passed straight back
 * inside the same transaction, so a publish through the dashboard cannot silently delete a
 * connector somebody configured last week, and the snapshot the version records is still the
 * whole configuration rather than two thirds of it.
 *
 * Same transaction matters. The read and the publish are one unit of work, so there is no
 * window in which another writer's tools could be read, overwritten and lost.
 */
export const publishTenantConfig = async (
  scope: TenantScope,
  fields: TenantConfigFields,
  note: string,
): Promise<number> => {
  const carried = await scope.query<{ tool_config: unknown; event_config: unknown }>(
    "select tool_config, event_config from tenants limit 1",
  );
  const current = carried[0];
  if (current === undefined) {
    // Unreachable through the API — a session cannot exist without the row that owns it —
    // and worth a sentence rather than a null dereference if it ever is reached.
    throw new Error("no tenant row is visible in this scope");
  }

  const hours = fields.businessHours;
  const escalation = fields.escalation;
  const rows = await scope.query<{ version: number }>(
    `select app.publish_tenant_config($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                                      $13, $14, $15, $16) as version`,
    [
      scope.tenantId,
      fields.name,
      fields.voiceId,
      fields.greeting,
      fields.persona,
      fields.instructions,
      [...fields.keyterms],
      hours?.opensAtHour ?? null,
      hours?.closesAtHour ?? null,
      hours === null ? null : [...hours.openDays],
      // jsonb wants text on the way in; the driver hands these back already parsed.
      current.tool_config == null ? null : JSON.stringify(current.tool_config),
      current.event_config == null ? null : JSON.stringify(current.event_config),
      escalation?.toNumber ?? null,
      escalation?.fromNumber ?? null,
      escalation?.ringSeconds ?? null,
      note,
    ],
  );

  const published = rows[0];
  if (published === undefined) throw new Error("publish_tenant_config returned no version");
  return Number(published.version);
};
