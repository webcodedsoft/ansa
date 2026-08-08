import type { Db } from "./data-source";

/**
 * Reading the retention policy, for a sweep that has no tenant.
 *
 * Every other query in this package runs inside `withTenant`. These three cannot: a timer
 * firing at four in the morning is acting for everybody, and RLS — correctly — shows a
 * connection with no `app.tenant_id` nothing at all. Migration 0010 answers that with
 * three security-definer functions narrow enough that being cross-tenant costs nothing:
 * they return identifiers and a count of days, never a word anyone said.
 */

export interface ExpiredCallAudio {
  /** The carrier's id, which is what a recording on disk is named after. */
  readonly carrierCallId: string;
  readonly tenantId: string;
  readonly retentionDays: number;
}

/** Calls whose audio has outlived its tenant's `audio_retention_days`. */
export const expiredCallAudio = async (dataSource: Db): Promise<readonly ExpiredCallAudio[]> => {
  const rows = (await dataSource.query("select * from app.expired_call_audio()")) as {
    carrier_call_id: string;
    tenant_id: string;
    retention_days: number;
  }[];
  return rows.map((r) => ({
    carrierCallId: r.carrier_call_id,
    tenantId: r.tenant_id,
    retentionDays: Number(r.retention_days),
  }));
};

/**
 * Which of these recordings belong to a call at all.
 *
 * The third answer the sweep needs. A file whose call is unknown cannot be judged against
 * any tenant's policy, and treating it as expired-by-default would delete audio a tenant
 * with a long retention is still entitled to.
 */
export const knownCallIds = async (
  dataSource: Db,
  carrierCallIds: readonly string[],
): Promise<ReadonlySet<string>> => {
  if (carrierCallIds.length === 0) return new Set();
  const rows = (await dataSource.query("select * from app.known_call_ids($1)", [
    [...carrierCallIds],
  ])) as { carrier_call_id: string }[];
  return new Set(rows.map((r) => r.carrier_call_id));
};

/**
 * The strictest retention anyone has configured.
 *
 * Applied to audio that cannot be attributed to a call. Unattributable audio is still
 * somebody's voice, so it expires on the shortest clock rather than being kept forever
 * for want of an owner.
 */
export const minAudioRetentionDays = async (dataSource: Db): Promise<number> => {
  const rows = (await dataSource.query("select app.min_audio_retention_days() as days")) as {
    days: number;
  }[];
  return Number(rows[0]?.days ?? 30);
};

/** Deletes `audio_segments` rows past their own `expires_at`. Returns how many went. */
export const purgeExpiredAudioSegments = async (dataSource: Db): Promise<number> => {
  const rows = (await dataSource.query(
    "select app.purge_expired_audio_segments() as removed",
  )) as { removed: number }[];
  return Number(rows[0]?.removed ?? 0);
};
