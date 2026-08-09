import { MEMBER_ROLES, type MemberRole } from "@ansa/db";

import { choice, object, text, type Schema } from "./http/schema";

/**
 * The field shapes more than one endpoint needs.
 *
 * Kept small on purpose. A schema used by exactly one endpoint belongs in that endpoint's
 * file, next to the handler it describes — the point of this layer is that the shape and
 * the code are read together.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Permissive by design. Anything stricter rejects addresses that exist — the only
 * authority on whether an address is real is whether mail to it arrives, and an
 * invitation is exactly that test.
 */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * E.164, as migration 0015's CHECK constraint spells it and as `handoff/destination.ts`
 * spells it for the environment fallback. Those two are a SQL constraint and a
 * module-private constant, so this is a third copy rather than a shared one; what it buys is
 * that a malformed number is a 422 with the field named instead of a 500 from the database.
 */
const E164 = /^\+[1-9][0-9]{6,14}$/;

export const uuid = (): Schema<string> => text({ format: "uuid", pattern: UUID });

/** A number in E.164, which is the only form anything downstream of the API accepts. */
export const phoneNumber = (): Schema<string> => text({ maxLength: 16, pattern: E164 });

export const email = (): Schema<string> => text({ format: "email", maxLength: 320, pattern: EMAIL });

export const timestamp = (): Schema<string> => text({ format: "date-time" });

export const role = (): Schema<MemberRole> => choice(MEMBER_ROLES);

/** An organisation, as the dashboard shows it. It is a `tenants` row; see migration 0016. */
export const organisation = object({ id: uuid(), name: text({ maxLength: 200 }) });
