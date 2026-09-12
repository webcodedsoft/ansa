import { AUDIT_ACTIONS, AUDIT_KINDS, listAuditEvents } from "@ansa/db";
import { Controller, Get, Inject } from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import { PAGE_PROPS, pageResponse, toPageBody, toPageRequest } from "../http/pagination";
import { apiRoute, FromQuery } from "../http/request";
import { choice, map, nullable, object, optional, text, type Infer } from "../http/schema";
import { timestamp, uuid } from "../schemas";
import { OrganizationContext } from "../tenancy/organization-context";

/**
 * Who did what, and when.
 *
 * Read-only by design: rows are written by the handlers that do things, as they do them,
 * and the application role cannot update or delete one (migration 0086). Owners and admins
 * read it — it says who listened to which recording, which is not a member's business.
 */

const auditEvent = object({
  id: uuid(),
  occurredAt: timestamp(),
  actorUserId: nullable(uuid()),
  /** As they were called at the time; survives their removal. */
  actorName: nullable(text({ maxLength: 200 })),
  action: choice(AUDIT_ACTIONS),
  subjectKind: nullable(
    choice(["account", "member", "invitation", "agent", "call", "contact", "organisation", "credential", "number"] as const),
  ),
  subjectId: nullable(text({ maxLength: 200 })),
  subjectLabel: nullable(text({ maxLength: 500 })),
  /** What the action wants to say — a version, a role, a phone number. Shape is per action. */
  detail: map(nullable(text({ maxLength: 2000 }))),
});

const auditQuery = object({
  ...PAGE_PROPS,
  /** Which bucket of the log; omitted is everything. */
  kind: optional(choice(AUDIT_KINDS)),
});

const auditPage = pageResponse(auditEvent);

@Controller(apiRoute("audit"))
export class AuditController {
  constructor(@Inject(OrganizationContext) private readonly db: OrganizationContext) {}

  @Get()
  @Endpoint({
    summary: "The audit log, newest first",
    description:
      "Every act of a person on this organisation: sign-ins, invitations, role changes and removals, publishes and rollbacks, recordings listened to, settings changed. Filter with `kind`. Rows written before the log existed carry no actor where the source table recorded none.",
    capability: "config:write",
    query: auditQuery,
    response: auditPage,
  })
  async list(@FromQuery() query: Infer<typeof auditQuery>): Promise<Infer<typeof auditPage>> {
    const page = toPageRequest(query);
    const slice = await this.db.tx((scope) => listAuditEvents(scope, page, query.kind ?? null));
    return toPageBody(slice, query);
  }
}
