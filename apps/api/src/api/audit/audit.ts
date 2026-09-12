import { recordAuditEvent, type NewAuditEvent, type OrganizationScope } from "@ansa/db";

import type { Principal } from "../auth/principal";

/**
 * Write an audit row as the caller, inside the transaction that did the thing.
 *
 * The actor is the session's principal — never a body field — so a row cannot claim to be
 * somebody it is not. Called from the handlers that change something a person would want
 * to know about later: who published, who listened, who removed whom.
 */
export const audit = (
  scope: OrganizationScope,
  caller: Principal,
  event: Omit<NewAuditEvent, "actorUserId" | "actorName">,
): Promise<void> =>
  recordAuditEvent(scope, { actorUserId: caller.userId, actorName: caller.displayName, ...event });
