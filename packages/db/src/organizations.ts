import { asOrganizationId, type BusinessHours, type OrganizationId } from "@ansa/shared";

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
  /**
   * How long the caller's *words* are kept — transcripts, call events and tool arguments.
   *
   * Separate from the audio because they outlive it on purpose: the review loop corrects
   * transcripts and the eval corpus is built from those corrections. See migration 0049.
   */
  readonly transcriptRetentionDays: number;
  /**
   * When this organisation counts as open. Null is "always open", which is a setting.
   *
   * On the organisation since migration 0053 rather than travelling through an agent's
   * publish, which is where it always lived in the database and never in a version.
   */
  readonly businessHours: BusinessHours | null;
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
  transcript_retention_days: number;
  business_open_hour: number | null;
  business_close_hour: number | null;
  business_days: number[] | null;
  consent_policy: string;
  consent_basis: string | null;
  calling_earliest_hour: number | null;
  calling_latest_hour: number | null;
}

/** Postgres hands back `Date` for timestamptz; the API speaks ISO 8601 and nothing else. */
const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;

/** All three or none, matching the CHECK constraint in migration 0012. Null is always open. */
const toBusinessHours = (row: OrganizationRow): BusinessHours | null => {
  const opens = row.business_open_hour;
  const closes = row.business_close_hour;
  const days = row.business_days;
  if (opens == null || closes == null || days == null) return null;
  return { opensAtHour: opens, closesAtHour: closes, openDays: days };
};

const toOrganization = (row: OrganizationRow): Organization => ({
  organizationId: asOrganizationId(row.id),
  name: row.name,
  createdAt: iso(row.created_at),
  audioRetentionDays: row.audio_retention_days,
  transcriptRetentionDays: row.transcript_retention_days,
  businessHours: toBusinessHours(row),
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
    `select id, name, created_at, audio_retention_days, transcript_retention_days,
            business_open_hour, business_close_hour, business_days,
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

/** One number this organisation holds, and which of its agents answers it. */
export interface HeldNumber {
  readonly number: string;
  /** Why the operator gave it to them, in their words. Null when they wrote nothing. */
  readonly note: string | null;
  /** Null when the number is held but routed to nobody, which is a real and visible state. */
  readonly agentId: string | null;
  readonly agentName: string | null;
}

/**
 * Every number this organisation holds, from the table that holds them.
 *
 * `GET /numbers` used to answer this question by reading one agent's `dialled_number`, which
 * made an endpoint named for the organisation report a single agent's line — and report
 * nothing at all for a number the organisation holds but has not routed yet. That is the
 * state an operator most needs to see: the number is attached, and no agent answers it.
 *
 * Left joined on the agent rather than the other way round, so a held-but-unrouted number
 * appears with a null agent instead of vanishing.
 */
export const listHeldNumbers = async (scope: OrganizationScope): Promise<readonly HeldNumber[]> => {
  const rows = await scope.query<{
    number: string;
    note: string | null;
    agent_id: string | null;
    agent_name: string | null;
  }>(
    `select n.number, n.note, a.id as agent_id, a.name as agent_name
       from organization_numbers n
       left join agents a
         on a.dialled_number = n.number and a.deleted_at is null
      order by n.number`,
  );
  return rows.map((row) => ({
    number: row.number,
    note: row.note,
    agentId: row.agent_id,
    agentName: row.agent_name,
  }));
};
