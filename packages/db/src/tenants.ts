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
  /** Recorded on every call, so a call from three weeks ago can be explained (R7.5). */
  readonly configVersion: number;
}

/**
 * Which tenant owns the number that was dialled (R7.3).
 *
 * Runs without tenant context, because the tenant is what we are looking up. The
 * SECURITY DEFINER function it calls returns only an id — see migration 0003 for why
 * that is the narrowest safe answer to the chicken-and-egg.
 */
export const resolveTenantByNumber = async (
  dataSource: Db,
  dialledNumber: string,
): Promise<TenantId | null> => {
  const rows = (await dataSource.query("select app.tenant_for_number($1) as id", [
    dialledNumber,
  ])) as { id: string | null }[];

  const id = rows[0]?.id ?? null;
  return id === null ? null : asTenantId(id);
};

/** Everything else is read inside the tenant's own scope, under RLS like any other row. */
export const loadTenantConfig = async (
  dataSource: Db,
  tenantId: TenantId,
): Promise<TenantConfig | null> =>
  withTenant(dataSource, tenantId, async (scope) => {
    const rows = await scope.query<{
      id: string;
      name: string;
      keyterms: string[] | null;
      voice_id: string | null;
      greeting: string | null;
      persona: string | null;
      config_version: number;
    }>(
      `select id, name, keyterms, voice_id, greeting, persona, config_version
         from tenants where id = $1`,
      [tenantId],
    );

    const row = rows[0];
    if (row === undefined) return null;
    return {
      tenantId: asTenantId(row.id),
      name: row.name,
      keyterms: row.keyterms ?? [],
      voiceId: row.voice_id,
      greeting: row.greeting,
      persona: row.persona,
      configVersion: row.config_version,
    };
  });
