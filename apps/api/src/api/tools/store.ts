import {
  publishOrganizationDocuments,
  readOrganizationDocuments,
  type OrganizationDocuments,
  type OrganizationScope,
} from "@ansa/db";

/**
 * The statements this endpoint area runs, each taking a scope it cannot widen.
 *
 * **There is no `where organization_id = …` and there must not be.** `organizations` has an
 * RLS policy of `id = app.current_organization()`, so `select … from organizations` inside a
 * scope returns exactly one row: this organisation's. Adding a predicate would not make it
 * safer, it would make it look as though the safety came from the predicate.
 *
 * **The documents here are the organisation's, not an agent's.** The tool registry and the
 * webhook subscriptions used to be saved by publishing an agent configuration version,
 * because that was the only versioned write there was. The resolver that picked the agent
 * refused — correctly — the moment an organisation had two, and from then on nothing could
 * be saved here at all. Migration 0089 gave the documents a version of their own; these
 * read and bump it, and agent publishes go on snapshotting the documents into their own
 * versions untouched.
 */
export type StoredDocuments = OrganizationDocuments;

export const readDocuments = readOrganizationDocuments;

/** Null means somebody saved first; the caller answers 409 with the version it read. */
export const publishDocuments = publishOrganizationDocuments;

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
