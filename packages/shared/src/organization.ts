/**
 * Identifier for one organization. Branded so a bare string cannot drift into a position that
 * expects a organization, which is the mistake CLAUDE.md rule 3 exists to prevent.
 */
export type OrganizationId = string & { readonly __brand: "OrganizationId" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Internal: asOrganizationId is the only door, so nothing outside needs to ask separately. */
const isOrganizationId = (raw: string): boolean => UUID.test(raw);

export const asOrganizationId = (raw: string): OrganizationId => {
  if (!isOrganizationId(raw)) {
    throw new Error(`Not a valid organization id: ${JSON.stringify(raw)}`);
  }
  return raw as OrganizationId;
};

/**
 * Identifier for one agent. An organisation has many; a phone number reaches exactly one.
 *
 * Branded separately from `OrganizationId` rather than aliased to it, even though migration 0018
 * gives each backfilled agent the same uuid as its organization. That equality is a migration
 * convenience with a shelf life — the second agent an organisation creates gets its own
 * uuid — and a type that let the two swap would keep the mistake invisible right up until
 * a caller reached the wrong script.
 */
export type AgentId = string & { readonly __brand: "AgentId" };

export const asAgentId = (raw: string): AgentId => {
  if (!UUID.test(raw)) {
    throw new Error(`Not a valid agent id: ${JSON.stringify(raw)}`);
  }
  return raw as AgentId;
};

/**
 * Where an escalation goes for one organisation (R6.5).
 *
 * Here rather than in the handoff module for the same reason `BusinessHours` is here: it
 * is read in `@ansa/db`, carried through the organization registry, and acted on in
 * `apps/api/src/handoff`, and only the last of those may know what a transfer is.
 *
 * It is per organization because it was briefly not. One destination for the whole process is a
 * single-organization assumption, and the way it fails with a second organization is that their caller
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
