/**
 * Identifier for one tenant. Branded so a bare string cannot drift into a position that
 * expects a tenant, which is the mistake CLAUDE.md rule 3 exists to prevent.
 */
export type TenantId = string & { readonly __brand: "TenantId" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isTenantId = (raw: string): raw is TenantId => UUID.test(raw);

export const asTenantId = (raw: string): TenantId => {
  if (!isTenantId(raw)) {
    throw new Error(`Not a valid tenant id: ${JSON.stringify(raw)}`);
  }
  return raw as TenantId;
};
