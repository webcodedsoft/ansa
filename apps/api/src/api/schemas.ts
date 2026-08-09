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

export const uuid = (): Schema<string> => text({ format: "uuid", pattern: UUID });

export const email = (): Schema<string> => text({ format: "email", maxLength: 320, pattern: EMAIL });

export const timestamp = (): Schema<string> => text({ format: "date-time" });

export const role = (): Schema<MemberRole> => choice(MEMBER_ROLES);

/** An organisation, as the dashboard shows it. It is a `tenants` row; see migration 0016. */
export const organisation = object({ id: uuid(), name: text({ maxLength: 200 }) });
