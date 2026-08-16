import { asOrganizationId, type OrganizationId } from "@ansa/shared";

import type { OrganizationScope } from "./organization-scope";

/**
 * The organisation itself — not its agents, and not its versioned configuration.
 *
 * Deliberately small, and it stays small for a while. An organisation owns what is true of
 * the company rather than of a conversation: what it is called, how long a caller's voice
 * is kept, and the legal basis on which it may place a call. Everything a caller
 * experiences belongs to an agent, and the two are separate documents rather than one with
 * defaults and overrides — see migration 0026 for why.
 *
 * Most of what is here is read-only to the organisation. That is the interesting part of
 * the shape, so it is written down rather than discovered through a failed write.
 */

export interface Organization {
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly createdAt: string;
  /**
   * How long stored call audio is kept, in days. Operator-set.
   *
   * An organisation shortening this quietly deletes evidence it may be asked for later, and
   * one lengthening it holds a caller's voice beyond the basis the consent was collected
   * under. Neither is a self-serve decision.
   */
  readonly audioRetentionDays: number;
  /** Operator-set: the NDPR/NCC posture the outbound consent gate enforces. */
  readonly consent: {
    readonly policy: string;
    readonly basis: string | null;
    readonly callingEarliestHour: number | null;
    readonly callingLatestHour: number | null;
  };
}

interface OrganizationRow {
  id: string;
  name: string;
  created_at: Date | string;
  audio_retention_days: number;
  consent_policy: string;
  consent_basis: string | null;
  calling_earliest_hour: number | null;
  calling_latest_hour: number | null;
}

/** Postgres hands back `Date` for timestamptz; the API speaks ISO 8601 and nothing else. */
const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;

const toOrganization = (row: OrganizationRow): Organization => ({
  organizationId: asOrganizationId(row.id),
  name: row.name,
  createdAt: iso(row.created_at),
  audioRetentionDays: row.audio_retention_days,
  consent: {
    policy: row.consent_policy,
    basis: row.consent_basis,
    callingEarliestHour: row.calling_earliest_hour,
    callingLatestHour: row.calling_latest_hour,
  },
});

/**
 * The caller's own organisation.
 *
 * No `where id = …`, and there must not be one: the policy on `organizations` is
 * `id = app.current_organization()`, so this returns exactly one row inside a scope. A
 * predicate would not add safety — it would make it look as though the safety came from
 * the predicate.
 *
 * Null when the organisation was deleted out from under a live session.
 */
export const readOrganization = async (
  scope: OrganizationScope,
): Promise<Organization | null> => {
  const rows = await scope.query<OrganizationRow>(
    `select id, name, created_at, audio_retention_days,
            consent_policy, consent_basis, calling_earliest_hour, calling_latest_hour
       from organizations`,
  );
  const row = rows[0];
  return row === undefined ? null : toOrganization(row);
};

/**
 * Rename it. The one thing an organisation may change about itself today.
 *
 * Cosmetic here and nowhere else: an agent's name is what it calls itself on a call, and
 * this is not that. They were the same string before migration 0018 and are not now, so
 * renaming the organisation leaves every agent saying exactly what it said before.
 */
export const renameOrganization = async (
  scope: OrganizationScope,
  name: string,
): Promise<Organization | null> => {
  /* `mutate`, not `query`: an update with `returning` comes back as `[rows, affectedCount]`,
     so the check below was always false and a rename of a deleted organisation — where RLS
     and the soft-delete filter match nothing — reported success. The third instance of this
     exact mistake in this package, which is why there is now a test that refuses it. */
  const updated = await scope.mutate<{ id: string }>(
    `update organizations set name = $1 where deleted_at is null returning id`,
    [name],
  );
  if (updated.length === 0) return null;
  return readOrganization(scope);
};
