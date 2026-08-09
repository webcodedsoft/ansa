/**
 * Identifier for one tenant. Branded so a bare string cannot drift into a position that
 * expects a tenant, which is the mistake CLAUDE.md rule 3 exists to prevent.
 */
export type TenantId = string & { readonly __brand: "TenantId" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Internal: asTenantId is the only door, so nothing outside needs to ask separately. */
const isTenantId = (raw: string): boolean => UUID.test(raw);

export const asTenantId = (raw: string): TenantId => {
  if (!isTenantId(raw)) {
    throw new Error(`Not a valid tenant id: ${JSON.stringify(raw)}`);
  }
  return raw as TenantId;
};

/**
 * Where an escalation goes for one organisation (R6.5).
 *
 * Here rather than in the handoff module for the same reason `BusinessHours` is here: it
 * is read in `@ansa/db`, carried through the tenant registry, and acted on in
 * `apps/api/src/handoff`, and only the last of those may know what a transfer is.
 *
 * It is per tenant because it was briefly not. One destination for the whole process is a
 * single-tenant assumption, and the way it fails with a second tenant is that their caller
 * is dialled through to the first organisation's staff — no row crossed a boundary, so RLS
 * had nothing to say about it.
 */
export interface HandoffDestination {
  /** E.164. The person who picks up. */
  readonly to: string;
  /** E.164, and must be a number the carrier account owns. */
  readonly from: string;
  readonly ringSeconds: number;
}
