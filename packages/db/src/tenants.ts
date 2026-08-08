import { asTenantId, type TenantId } from "@ansa/shared";
import type { Db } from "./data-source";

import { withTenant } from "./tenant-scope";

/**
 * The slice of tenant configuration the call path needs.
 *
 * Deliberately small. R7.5's full config — escalation rules, business hours, registered
 * tools, knowledge base — lands with the slices that use it; adding columns nothing reads
 * would be pre-generalising.
 */
export interface TenantConfig {
  readonly tenantId: TenantId;
  readonly name: string;
  /** Vocabulary the transcriber should expect: products, staff names, places (R4.1.3). */
  readonly keyterms: readonly string[];
  readonly voiceId: string | null;
  readonly greeting: string | null;
  readonly persona: string | null;
  /**
   * The tenant's own rules — hours, what to do when unsure, who to transfer to.
   *
   * Bounded free text that is layered ON the base prompt and can never replace it. What
   * "bounded" means is enforced in `apps/api/src/prompts/tenant-layer.ts`, on the way
   * into the prompt rather than on the way into this column, so a row written by hand in
   * psql is filtered exactly like one written through onboarding.
   */
  readonly instructions: string | null;
  /** Recorded on every call, so a call from three weeks ago can be explained (R7.5). */
  readonly configVersion: number;
}

/** The row shape the three `app.tenant_config_*` functions all return. */
interface ConfigRow {
  id: string;
  name: string;
  keyterms: string[] | null;
  voice_id: string | null;
  greeting: string | null;
  persona: string | null;
  instructions: string | null;
  config_version: number;
}

const toConfig = (row: ConfigRow): TenantConfig => ({
  tenantId: asTenantId(row.id),
  name: row.name,
  keyterms: row.keyterms ?? [],
  voiceId: row.voice_id,
  greeting: row.greeting,
  persona: row.persona,
  instructions: row.instructions ?? null,
  configVersion: row.config_version,
});



/**
 * Resolution and configuration in one round trip (R7.3).
 *
 * The two-step version cost two seconds on the answer path, because loading the config
 * under RLS means opening a transaction to set the tenant context — six round trips to
 * a remote database before the carrier gets its TwiML. See migration 0004.
 */
export const loadTenantForNumber = async (
  dataSource: Db,
  dialledNumber: string,
): Promise<TenantConfig | null> => {
  const rows = (await dataSource.query("select * from app.tenant_config_for_number($1)", [
    dialledNumber,
  ])) as ConfigRow[];

  const row = rows[0];
  return row === undefined ? null : toConfig(row);
};

/**
 * Configuration for a tenant we already hold the id of, in one round trip.
 *
 * The counterpart to loadTenantForNumber, and it exists for the same reason: the RLS
 * path opens a transaction to set the tenant context, which is six round trips and was
 * measured at 1.74 seconds on the media socket. See migration 0005.
 */
export const loadTenantById = async (
  dataSource: Db,
  tenantId: TenantId,
): Promise<TenantConfig | null> => {
  const rows = (await dataSource.query("select * from app.tenant_config_for_id($1)", [
    tenantId,
  ])) as ConfigRow[];

  const row = rows[0];
  return row === undefined ? null : toConfig(row);
};

/*
 * Reading an OLD config version back — `app.tenant_config_at_version(tenant, version)`,
 * added by migration 0011 — deliberately has no function here yet.
 *
 * `calls.config_version` has been recorded on every call since Slice 2 and has never been
 * readable back: the version was a number pointing at nothing, because `tenants` only
 * held the current values. 0011 gives it something to point at. Nothing in the API reads
 * it yet, and an export nothing calls fails `pnpm lint` for good reasons, so the audit
 * path is `tools/tenant/config.mjs show <version>` until the call viewer wants it — at
 * which point this is a six-line function over the same SECURITY INVOKER function.
 */

/** The evidence the consent policy needs. Reading only; the verdict is not ours to make. */
export interface ConsentRecord {
  readonly grantedAt: Date;
  readonly revokedAt: Date | null;
}

/**
 * Consent and suppression for one tenant and one number.
 *
 * Runs inside the tenant's own scope under RLS, so a tenant cannot read another's consent
 * records — and cannot borrow them either, which is the more interesting failure.
 * Suppression deliberately includes global rows: someone who asks not to be called should
 * not have to ask each tenant separately.
 */
export const loadConsentFacts = async (
  dataSource: Db,
  tenantId: TenantId,
  phoneNumber: string,
): Promise<{ consent: ConsentRecord | null; suppressed: boolean }> =>
  withTenant(dataSource, tenantId, async (scope) => {
    const consents = await scope.query<{ granted_at: Date; revoked_at: Date | null }>(
      `select granted_at, revoked_at from outbound_consent
        where tenant_id = $1 and phone_number = $2
        order by granted_at desc limit 1`,
      [tenantId, phoneNumber],
    );
    const suppressions = await scope.query<{ n: string }>(
      `select count(*) as n from do_not_call
        where phone_number = $1 and (tenant_id = $2 or tenant_id is null)`,
      [phoneNumber, tenantId],
    );

    const row = consents[0];
    return {
      consent: row === undefined ? null : { grantedAt: row.granted_at, revokedAt: row.revoked_at },
      suppressed: Number(suppressions[0]?.n ?? 0) > 0,
    };
  });

export interface OutboundPolicy {
  readonly policy: string;
  readonly basis: string | null;
  readonly earliestHour: number | null;
  readonly latestHour: number | null;
}

/** The organisation's own consent settings, read inside its own scope. */
export const loadOutboundPolicy = async (
  dataSource: Db,
  tenantId: TenantId,
): Promise<OutboundPolicy | null> =>
  withTenant(dataSource, tenantId, async (scope) => {
    const rows = await scope.query<{
      consent_policy: string;
      consent_basis: string | null;
      calling_earliest_hour: number | null;
      calling_latest_hour: number | null;
    }>(
      `select consent_policy, consent_basis, calling_earliest_hour, calling_latest_hour
         from tenants where id = $1`,
      [tenantId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      policy: row.consent_policy,
      basis: row.consent_basis,
      earliestHour: row.calling_earliest_hour,
      latestHour: row.calling_latest_hour,
    };
  });

