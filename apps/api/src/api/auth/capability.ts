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
  /** Read the people who have called, and what they have told the agent. */
  | "contacts:read"
  /**
   * Correct a contact: their name, or a value the agent misheard.
   *
   * Separate from `calls:write`, which is documented above as granting exactly one thing.
   * A contact is not part of a call record — it is the organisation's own view of a person,
   * assembled across calls and meant to be edited — so it needs a capability of its own
   * rather than a quiet widening of one whose whole point is that it is narrow.
   */
  | "contacts:write"
  /** Read the outbound campaigns and the calls scheduled under them. */
  | "campaigns:read"
  /**
   * Create a campaign, edit it, move it between states, and put contacts on it.
   *
   * Its own pair rather than a reuse of `contacts:write` or `config:write`: `contacts:write`
   * is deliberately narrow — correcting one person's record — and a campaign places calls,
   * which is a materially larger thing to grant; `config:write` is what a caller hears, and a
   * campaign decides who is called, not what they hear.
   */
  | "campaigns:write"
  /** See who else is in the organisation. */
  | "members:read"
  /** Change someone's role, or remove them. */
  | "members:write"
  | "invitations:read"
  | "invitations:write"
  /** Read the diary: calendars, opening hours, free slots and the bookings in them. */
  | "appointments:read"
  /**
   * Change the diary: edit a calendar or its hours, book a slot, confirm a hold, cancel.
   *
   * Its own capability rather than a widening of `config:write`, for the reason `contacts:write`
   * is its own: a booking is the organisation's operational data, made and cancelled day to day,
   * not part of what a caller hears. A member reviewing calls should be able to see the diary
   * without being able to move an appointment in it.
   */
  | "appointments:write"
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
  member: ["calls:read", "contacts:read", "campaigns:read", "members:read", "appointments:read", "config:read"],
  admin: [
    "calls:read",
    "calls:write",
    "contacts:read",
    "contacts:write",
    "campaigns:read",
    "campaigns:write",
    "members:read",
    "appointments:read",
    "appointments:write",
    "config:read",
    "config:write",
    "invitations:read",
  ],
  owner: [
    "calls:read",
    "calls:write",
    "contacts:read",
    "contacts:write",
    "campaigns:read",
    "campaigns:write",
    "members:read",
    "members:write",
    "invitations:read",
    "invitations:write",
    "appointments:read",
    "appointments:write",
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
