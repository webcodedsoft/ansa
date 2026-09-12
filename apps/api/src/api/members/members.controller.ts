import { listMembers, removeMember, restoreMember, setMemberRole, suspendMember } from "@ansa/db";
import {
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Patch,
  Post,
} from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import { pageQuery, pageResponse, toPageBody, toPageRequest } from "../http/pagination";
import { apiRoute, FromBody, FromPath, FromQuery } from "../http/request";
import { nullable, object, text, type Infer } from "../http/schema";
import { email, role, timestamp, uuid } from "../schemas";
import { OrganizationContext } from "../tenancy/organization-context";
import { Caller, type Principal } from "../auth/principal";

/**
 * Who is in the organisation, and what they may do.
 *
 * The three handlers here are the shortest complete example of the pipeline: a paginated
 * read, a write with both a path parameter and a body, and a delete. None of them mentions
 * a organization, because there is nowhere in the pipeline for one to be mentioned.
 */

const member = object({
  userId: uuid(),
  email: email(),
  displayName: text({ maxLength: 200 }),
  role: role(),
  createdAt: timestamp(),
  /** Set while their access is revoked. They stay listed with their role; nothing authenticates. */
  suspendedAt: nullable(timestamp()),
});

const memberPage = pageResponse(member);

const memberPath = object({ userId: uuid() });

const roleChange = object({ role: role() });

const roleChanged = object({ userId: uuid(), role: role() });

/**
 * The last-owner rule lives in a deferred constraint trigger (migration 0016), so it holds
 * for every writer including a psql session. What reaches here is a driver error, and this
 * turns it into the 409 it actually is rather than the 500 it looks like.
 *
 * Matching on the message is not lovely. The alternative is counting owners in the handler
 * first, which is a check that races and that a second write path would not repeat — and
 * the message is one we wrote, in a file that is next to this one in the diff.
 */
const OWNER_RULE = "must keep at least one owner";

const asConflict = (error: unknown): never => {
  if (error instanceof Error && error.message.includes(OWNER_RULE)) {
    throw new ConflictException("an organisation must keep at least one owner");
  }
  throw error;
};

@Controller(apiRoute("members"))
export class MembersController {
  constructor(@Inject(OrganizationContext) private readonly db: OrganizationContext) {}

  @Get()
  @Endpoint({
    summary: "List the people in this organisation, newest first",
    capability: "members:read",
    query: pageQuery,
    response: memberPage,
  })
  async list(@FromQuery() query: Infer<typeof pageQuery>): Promise<Infer<typeof memberPage>> {
    const page = toPageRequest(query);
    return toPageBody(await this.db.tx((scope) => listMembers(scope, page)), query);
  }

  @Patch(":userId")
  @Endpoint({
    summary: "Change someone's role",
    description: "Refuses with 409 if it would leave the organisation without an owner.",
    capability: "members:write",
    params: memberPath,
    body: roleChange,
    response: roleChanged,
  })
  async setRole(
    @FromPath() path: Infer<typeof memberPath>,
    @FromBody() body: Infer<typeof roleChange>,
  ): Promise<Infer<typeof roleChanged>> {
    const changed = await this.db
      .tx((scope) => setMemberRole(scope, path.userId, body.role))
      .catch(asConflict);
    // Not a member here — which, under RLS, is also what a member of another organisation
    // looks like. Answering 404 to both is the point: a 403 would confirm the id exists.
    if (!changed) throw new NotFoundException();
    return { userId: path.userId, role: body.role };
  }

  @Delete(":userId")
  @Endpoint({
    summary: "Remove someone from this organisation",
    description: "Their account survives; only the membership goes. Refuses to remove the last owner.",
    capability: "members:write",
    params: memberPath,
  })
  async remove(@FromPath() path: Infer<typeof memberPath>): Promise<void> {
    const removed = await this.db
      .tx((scope) => removeMember(scope, path.userId))
      .catch(asConflict);
    if (!removed) throw new NotFoundException();
  }

  @Post(":userId/suspension")
  @Endpoint({
    summary: "Revoke someone's access without removing them",
    description:
      "Their sessions end now and signing in no longer offers this organisation, but the membership stands — role and joined date kept, still listed — so restoring them is one call rather than an invitation. Refuses to suspend the last owner, or yourself. 404 if they are not a member or are already suspended.",
    capability: "members:write",
    params: memberPath,
    status: 204,
  })
  async suspend(@FromPath() path: Infer<typeof memberPath>, @Caller() caller: Principal): Promise<void> {
    /* Refused here rather than left to the last-owner rule, which would only catch it when
       you are the last owner. Revoking your own access ends the session making the request,
       and the natural next question — "why am I signed out?" — has no good answer. */
    if (caller.userId === path.userId) {
      throw new ConflictException("you cannot revoke your own access");
    }
    const suspended = await this.db
      .tx((scope) => suspendMember(scope, path.userId))
      .catch(asConflict);
    if (!suspended) throw new NotFoundException();
  }

  @Delete(":userId/suspension")
  @Endpoint({
    summary: "Restore someone's access",
    description: "Undoes a suspension. They sign in as before, with the role they held. 404 if they are not suspended.",
    capability: "members:write",
    params: memberPath,
    status: 204,
  })
  async restore(@FromPath() path: Infer<typeof memberPath>): Promise<void> {
    const restored = await this.db.tx((scope) => restoreMember(scope, path.userId));
    if (!restored) throw new NotFoundException();
  }
}
