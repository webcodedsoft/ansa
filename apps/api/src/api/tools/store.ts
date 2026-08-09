import type { TenantScope } from "@ansa/db";

/**
 * The statements this endpoint area runs, each taking a scope it cannot widen.
 *
 * They are here rather than in `@ansa/db` because they have exactly one consumer and it is
 * three files away. If a second one appears — the agent-configuration endpoints will want
 * `publishConfiguration` the moment they exist — they move, unchanged, and the signatures
 * are already the shape that package uses.
 *
 * Two things are worth reading before changing anything below.
 *
 * **There is no `where tenant_id = …` and there must not be.** `tenants` has an RLS policy
 * of `id = app.current_tenant()`, so `select … from tenants` inside a scope returns exactly
 * one row: this organisation's. Adding a predicate would not make it safer, it would make
 * it look as though the safety came from the predicate.
 *
 * **A publish is a whole configuration, never a patch.** `app.publish_tenant_config` rewrites
 * every field it takes and snapshots the result into `tenant_prompt_versions`, which is what
 * lets a call from three weeks ago be explained (R7.5). So changing the tool configuration
 * means reading the other fields and handing them straight back, inside the same
 * transaction. Omitting one would not "leave it alone" — it would clear it, and the version
 * history would then be a lie about what the agent was doing that day.
 */

/** Every column `app.publish_tenant_config` rewrites, as it stands right now. */
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

interface ConfigurationRow {
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

const CONFIGURATION_COLUMNS = `
  name, voice_id, greeting, persona, instructions, keyterms,
  business_open_hour, business_close_hour, business_days,
  escalation_to_number, escalation_from_number, escalation_ring_seconds,
  tool_config, event_config, config_version`;

/** Null when the organisation has been deleted out from under a live session. */
export const readConfiguration = async (
  scope: TenantScope,
): Promise<StoredConfiguration | null> => {
  const rows = await scope.query<ConfigurationRow>(
    `select ${CONFIGURATION_COLUMNS} from tenants`,
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

/** What this publish is changing. Everything else is carried over from `current`. */
export interface ConfigurationChange {
  /** The `tools` document to store. Null removes every tenant tool. */
  readonly toolConfig: unknown;
  /** The `events` document to store. Null stops every delivery. */
  readonly eventConfig: unknown;
  /** Recorded on the version. A version with no reason explains nothing later. */
  readonly note: string;
}

/** jsonb wants text on the wire; null has to stay null rather than become `"null"`. */
const asJsonb = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);

/**
 * Bump the configuration version and snapshot it, in one statement.
 *
 * The function refuses to run unless `app.tenant_id` names the tenant it was passed, which
 * is why the id is an argument at all — it is the function checking the scope, not this
 * layer choosing an organisation. The value comes off the scope, which came off the
 * principal, which came out of a session row RLS agreed to show.
 */
export const publishConfiguration = async (
  scope: TenantScope,
  current: StoredConfiguration,
  change: ConfigurationChange,
): Promise<number> => {
  const rows = await scope.query<{ version: number }>(
    `select app.publish_tenant_config(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
     ) as version`,
    [
      scope.tenantId,
      current.name,
      current.voiceId,
      current.greeting,
      current.persona,
      current.instructions,
      current.keyterms,
      current.businessOpenHour,
      current.businessCloseHour,
      current.businessDays,
      asJsonb(change.toolConfig),
      asJsonb(change.eventConfig),
      current.escalationToNumber,
      current.escalationFromNumber,
      current.escalationRingSeconds,
      change.note,
    ],
  );

  const version = rows[0]?.version;
  if (version === undefined) throw new Error("publish_tenant_config returned no version");
  return version;
};

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * What a credential looks like from outside the vault: a name and two dates.
 *
 * There is no field here for the value and there is not going to be one. Not the plaintext,
 * not the ciphertext, and not a masked form either — a mask that preserves length tells an
 * attacker whether they are looking at a 32-character API key or a passphrase, and tells a
 * legitimate reader nothing they can act on. Rotation is the only operation on a credential
 * whose value is wrong.
 */
export interface StoredCredential {
  readonly ref: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface CredentialRow {
  ref: string;
  created_at: Date;
  updated_at: Date;
}

export const listCredentials = async (
  scope: TenantScope,
): Promise<readonly StoredCredential[]> => {
  const rows = await scope.query<CredentialRow>(
    "select ref, created_at, updated_at from tenant_credentials order by ref",
  );
  return rows.map((row) => ({ ref: row.ref, createdAt: row.created_at, updatedAt: row.updated_at }));
};

/**
 * The sealed values, for the one thing that needs them: telling an auth credential from a
 * signing secret without revealing either.
 *
 * Ciphertext leaves this function and goes straight into an in-memory vault, which is the
 * only thing in the process holding the key. It never reaches a response, a log line or an
 * exception message — see `vault.ts`, which is the only caller.
 */
export const sealedCredentials = async (
  scope: TenantScope,
): Promise<ReadonlyMap<string, string>> => {
  const rows = await scope.query<{ ref: string; sealed: string }>(
    "select ref, sealed from tenant_credentials",
  );
  return new Map(rows.map((row) => [row.ref, row.sealed]));
};

/**
 * Write a credential, or replace the one already under that name.
 *
 * Upsert rather than insert-or-fail because rotation is the common case and two rows under
 * one name would be a silent ambiguity about which one the agent is using. The same
 * statement `tools/tenant/config.mjs` runs, for the same reason.
 */
export const putCredential = async (
  scope: TenantScope,
  ref: string,
  sealed: string,
): Promise<StoredCredential> => {
  const rows = await scope.query<CredentialRow>(
    `insert into tenant_credentials (tenant_id, ref, sealed)
          values ($1, $2, $3)
     on conflict (tenant_id, ref)
       do update set sealed = excluded.sealed, updated_at = now()
       returning ref, created_at, updated_at`,
    [scope.tenantId, ref, sealed],
  );

  const row = rows[0];
  if (row === undefined) throw new Error("the credential was neither inserted nor updated");
  return { ref: row.ref, createdAt: row.created_at, updatedAt: row.updated_at };
};

/** False when this organisation has no credential under that name. */
export const deleteCredential = async (scope: TenantScope, ref: string): Promise<boolean> => {
  // `mutate`, not `query`. A delete comes back as `[rows, affectedCount]` whatever it
  // matched, so `(await scope.query(…)).length > 0` is always true — the defect
  // `isolation.test.ts` caught on the members endpoint.
  const removed = await scope.mutate<{ ref: string }>(
    "delete from tenant_credentials where ref = $1 returning ref",
    [ref],
  );
  return removed.length > 0;
};
