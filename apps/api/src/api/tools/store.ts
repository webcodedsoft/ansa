import {
  publishConfiguration as dbPublishConfiguration,
  readStoredConfiguration,
  type StoredConfiguration as DbStoredConfiguration,
  type OrganizationScope,
} from "@ansa/db";

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
 * **There is no `where organization_id = …` and there must not be.** `organizations` has an RLS policy
 * of `id = app.current_organization()`, so `select … from organizations` inside a scope returns exactly
 * one row: this organisation's. Adding a predicate would not make it safer, it would make
 * it look as though the safety came from the predicate.
 *
 * **A publish is a whole configuration, never a patch.** `app.publish_agent_config` rewrites
 * every field it takes and snapshots the result into `agent_prompt_versions`, which is what
 * lets a call from three weeks ago be explained (R7.5). So changing the tool configuration
 * means reading the other fields and handing them straight back, inside the same
 * transaction. Omitting one would not "leave it alone" — it would clear it, and the version
 * history would then be a lie about what the agent was doing that day.
 */

/**
 * Reading and publishing the configuration document now live in `@ansa/db`.
 *
 * They were here, and there was a near-identical pair in `packages/db/src/organization-config.ts`
 * for agent configuration. Both went through the one SQL function, so there was never a
 * second path into the table — but each carried the other's columns forward by hand, and
 * adding a column would have meant editing both. Forgetting one would have nulled a
 * organization's configuration on their next publish, with the version history recording the loss
 * as intentional.
 *
 * `publishConfiguration` there takes a patch and does the carrying itself, so a caller says
 * what it is changing and nothing else. These aliases keep the names this area already uses.
 */
export type StoredConfiguration = DbStoredConfiguration;

export const readConfiguration = readStoredConfiguration;

/** What this publish is changing. Everything else is carried over from `current`. */
export interface ConfigurationChange {
  /** The `tools` document to store. Null removes every organization tool. */
  readonly toolConfig: unknown;
  /** The `events` document to store. Null stops every delivery. */
  readonly eventConfig: unknown;
  /** Recorded on the version. A version with no reason explains nothing later. */
  readonly note: string;
}

export const publishConfiguration = async (
  scope: OrganizationScope,
  current: StoredConfiguration,
  change: ConfigurationChange,
): Promise<number> =>
  dbPublishConfiguration(
    scope,
    current,
    { toolConfig: change.toolConfig, eventConfig: change.eventConfig },
    change.note,
  );

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
  scope: OrganizationScope,
): Promise<readonly StoredCredential[]> => {
  const rows = await scope.query<CredentialRow>(
    "select ref, created_at, updated_at from organization_credentials order by ref",
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
  scope: OrganizationScope,
): Promise<ReadonlyMap<string, string>> => {
  const rows = await scope.query<{ ref: string; sealed: string }>(
    "select ref, sealed from organization_credentials",
  );
  return new Map(rows.map((row) => [row.ref, row.sealed]));
};

/**
 * Write a credential, or replace the one already under that name.
 *
 * Upsert rather than insert-or-fail because rotation is the common case and two rows under
 * one name would be a silent ambiguity about which one the agent is using. The same
 * statement `tools/organization/config.mjs` runs, for the same reason.
 */
export const putCredential = async (
  scope: OrganizationScope,
  ref: string,
  sealed: string,
): Promise<StoredCredential> => {
  const rows = await scope.query<CredentialRow>(
    `insert into organization_credentials (organization_id, ref, sealed)
          values ($1, $2, $3)
     on conflict (organization_id, ref)
       do update set sealed = excluded.sealed, updated_at = now()
       returning ref, created_at, updated_at`,
    [scope.organizationId, ref, sealed],
  );

  const row = rows[0];
  if (row === undefined) throw new Error("the credential was neither inserted nor updated");
  return { ref: row.ref, createdAt: row.created_at, updatedAt: row.updated_at };
};

/** False when this organisation has no credential under that name. */
export const deleteCredential = async (scope: OrganizationScope, ref: string): Promise<boolean> => {
  // `mutate`, not `query`. A delete comes back as `[rows, affectedCount]` whatever it
  // matched, so `(await scope.query(…)).length > 0` is always true — the defect
  // `isolation.test.ts` caught on the members endpoint.
  const removed = await scope.mutate<{ ref: string }>(
    "delete from organization_credentials where ref = $1 returning ref",
    [ref],
  );
  return removed.length > 0;
};
