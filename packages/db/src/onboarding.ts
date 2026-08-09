import type { BusinessHours } from "@ansa/shared";

import type { TenantScope } from "./tenant-scope";

/**
 * Everything "is this organisation actually live?" is decided from, in one transaction.
 *
 * Deliberately not the same read as `tenant-config.ts` next door, which answers "what has
 * this organisation configured" and is the dashboard's configuration screen. This answers a
 * different question and needs three things that one has no reason to hold: the raw `tools`
 * and `events` documents (readiness re-parses them exactly as config load does, because a
 * document that fails to parse is silently dropped on every call), the *names* in the
 * credential vault, and whether a call has ever arrived at all.
 *
 * That last one is the cheapest evidence in the product that step 1 of the onboarding
 * runbook was done. A tenant provisioned with the carrier webhook forgotten looks perfect
 * in every column and has no rows in `calls`, forever.
 *
 * No `where` clause and no tenant id anywhere, which is the point: under RLS each of these
 * tables shows exactly this organisation's rows, so the query that reads somebody else's is
 * not a query with a missing condition — it is unwritable.
 *
 * **Sealed credential values are never read here, only their reference names.** A name is
 * the organisation's own word for a secret and appears in their configuration; the
 * ciphertext beside it has no business being loaded to answer a yes/no question.
 */

export interface OnboardingFacts {
  readonly organisationName: string;
  /** The ingress routing key. Null means no caller can reach this organisation at all. */
  readonly dialledNumber: string | null;
  readonly greeting: string | null;
  readonly voiceId: string | null;
  /** All three columns or none, matching the CHECK constraint in migration 0012. */
  readonly businessHours: BusinessHours | null;
  readonly consentPolicy: string | null;
  readonly consentBasis: string | null;
  /** Both numbers or neither, matching the CHECK constraint in migration 0015. */
  readonly escalationConfigured: boolean;
  /** The `tool_config` document exactly as stored, for readiness to parse as config load does. */
  readonly toolConfig: unknown;
  /** The `event_config` document exactly as stored, same reason. */
  readonly eventConfig: unknown;
  /** Names only. Never the sealed values. */
  readonly credentialRefs: readonly string[];
  readonly configVersion: number;
  /** Every call the carrier has ever announced to us for this organisation. */
  readonly callsReceived: number;
  readonly lastCallAt: string | null;
  /** Deliveries this organisation's receivers gave up on. */
  readonly failedDeliveries: number;
  readonly pendingDeliveries: number;
}

/**
 * `select *` rather than a column list, so a deployment that has not applied a migration
 * returns a row without those columns instead of failing the whole statement.
 *
 * Migration 0012 is the live example: `TASKS.md` records it as unapplied, and business
 * hours reading as "not configured" on such a deployment is exactly right — it is what the
 * call path does too.
 */
type TenantRow = Record<string, unknown>;

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const wholeNumberOrNull = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
};

/** Three columns or none. Two thirds of an opening-hours row cannot be reasoned about. */
const toBusinessHours = (row: TenantRow): BusinessHours | null => {
  const opens = wholeNumberOrNull(row["business_open_hour"]);
  const closes = wholeNumberOrNull(row["business_close_hour"]);
  const days = row["business_days"];
  if (opens === null || closes === null || !Array.isArray(days)) return null;
  return { opensAtHour: opens, closesAtHour: closes, openDays: days.map(Number) };
};

const toIsoOrNull = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value !== "") return new Date(value).toISOString();
  return null;
};

/**
 * Null when no tenant row is visible in this scope, which through the dashboard cannot
 * happen — a session exists because the row that owns it does. Reported rather than
 * asserted, because the alternative is a null dereference in a health endpoint.
 */
export const loadOnboardingFacts = async (scope: TenantScope): Promise<OnboardingFacts | null> => {
  const tenants = await scope.query<TenantRow>("select * from tenants limit 1");
  const row = tenants[0];
  if (row === undefined) return null;

  const credentials = await scope.query<{ ref: string }>(
    "select ref from tenant_credentials order by ref",
  );

  // `::int` because the driver hands a bigint back as a string, and a count compared with
  // `> 0` as a string is true for "0".
  const traffic = await scope.query<{ received: number; last_at: unknown }>(
    "select count(*)::int as received, max(created_at) as last_at from calls",
  );

  const deliveries = await scope.query<{ failed: number; pending: number }>(
    `select count(*) filter (where status = 'failed')::int  as failed,
            count(*) filter (where status = 'pending')::int as pending
       from event_deliveries`,
  );

  return {
    organisationName: typeof row["name"] === "string" ? row["name"] : "",
    dialledNumber: textOrNull(row["dialled_number"]),
    greeting: textOrNull(row["greeting"]),
    voiceId: textOrNull(row["voice_id"]),
    businessHours: toBusinessHours(row),
    consentPolicy: textOrNull(row["consent_policy"]),
    consentBasis: textOrNull(row["consent_basis"]),
    escalationConfigured:
      textOrNull(row["escalation_to_number"]) !== null &&
      textOrNull(row["escalation_from_number"]) !== null,
    toolConfig: row["tool_config"] ?? null,
    eventConfig: row["event_config"] ?? null,
    credentialRefs: credentials.map((entry) => entry.ref),
    configVersion: wholeNumberOrNull(row["config_version"]) ?? 0,
    callsReceived: Number(traffic[0]?.received ?? 0),
    lastCallAt: toIsoOrNull(traffic[0]?.last_at),
    failedDeliveries: Number(deliveries[0]?.failed ?? 0),
    pendingDeliveries: Number(deliveries[0]?.pending ?? 0),
  };
};
