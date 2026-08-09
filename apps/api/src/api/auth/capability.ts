import type { MemberRole } from "@ansa/db";

/**
 * What a route needs, rather than who is allowed to call it.
 *
 * Routes name a capability; roles hold capabilities. The indirection earns its place the
 * first time a fourth role appears: with `role === "owner"` scattered through handlers,
 * adding one means finding every comparison and deciding about it; with this, it is one
 * entry in the table below and every route keeps working.
 *
 * It also makes the OpenAPI document honest — each operation can state what it requires,
 * because the requirement is a value and not an `if`.
 */
export type Capability =
  /** Read call history, transcripts and recordings. */
  | "calls:read"
  /**
   * Record a review verdict on a transcript.
   *
   * The only writable part of a call record. Everything else in it is written by the call
   * itself and a dashboard that could edit it would be editing evidence — so this grants
   * exactly one thing: saying what the caller actually said.
   */
  | "calls:write"
  /** See who else is in the organisation. */
  | "members:read"
  /** Change someone's role, or remove them. */
  | "members:write"
  | "invitations:read"
  | "invitations:write"
  /** Read the agent's configuration: prompts, tools, numbers, hours. */
  | "config:read"
  /** Change it. This is the one that alters what callers hear. */
  | "config:write";

/**
 * Three roles, and the reason each exists.
 *
 * `member` can look but not touch — the shape of a support agent reviewing their own
 * calls. `admin` configures the agent, which is the day-to-day work, but cannot change
 * who has access. `owner` can do both, and only an owner can remove an owner.
 *
 * `calls:write` sits with `admin` rather than `member` even though a support agent is
 * often the person who knows what the caller said. A verdict is what every accuracy figure
 * is measured against, so it is a write in the sense that matters, and "member changes
 * nothing" is an invariant `capability.test.ts` checks rather than a description. If the
 * review queue turns out to belong to the people on the phones, that is a considered
 * change to this table and to that test — not a quiet grant here.
 */
const GRANTS: Readonly<Record<MemberRole, readonly Capability[]>> = {
  member: ["calls:read", "members:read", "config:read"],
  admin: [
    "calls:read",
    "calls:write",
    "members:read",
    "config:read",
    "config:write",
    "invitations:read",
  ],
  owner: [
    "calls:read",
    "calls:write",
    "members:read",
    "members:write",
    "invitations:read",
    "invitations:write",
    "config:read",
    "config:write",
  ],
};

export const can = (role: MemberRole, capability: Capability): boolean =>
  GRANTS[role].includes(capability);

/**
 * Everything a role may do, for `GET /auth/me`.
 *
 * The dashboard hides controls the caller cannot use, and it has to learn what those are
 * from the same table the guard enforces. Shipping a second copy of this list to the
 * frontend is how a button appears that always returns 403.
 */
export const capabilitiesOf = (role: MemberRole): readonly Capability[] => GRANTS[role];

/** Every capability, for the OpenAPI document's enumeration of what routes can require. */
export const ALL_CAPABILITIES: readonly Capability[] = GRANTS.owner;
