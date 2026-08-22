import { readOrganization, renameOrganization } from "@ansa/db";
import { Controller, Get, Inject, NotFoundException, Patch } from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import { apiRoute, FromBody } from "../http/request";
import { integer, nullable, object, text, type Infer } from "../http/schema";
import { timestamp, uuid } from "../schemas";
import { OrganizationContext } from "../tenancy/organization-context";

/**
 * The organisation itself.
 *
 * Small on purpose, and separate from `/config` on purpose. `/config` is the *agent's*
 * versioned script — greeting, persona, instructions, hours — and it is republished every
 * time somebody changes a word of it. This is the company: its name, how long a caller's
 * voice is kept, and the legal basis on which it may dial out. Those change rarely, are
 * not versioned, and mostly are not the organisation's to change at all.
 *
 * Keeping them apart rather than modelling one as defaults the other overrides is a
 * deliberate call. They answer different questions, and the organisation is where billing,
 * roles and retention policy will land — none of which an agent should inherit a field
 * from. See migration 0026.
 */

const NAME_LIMIT = 200;

const organization = object({
  organizationId: uuid(),
  name: text({ maxLength: NAME_LIMIT }),
  createdAt: timestamp(),
  /**
   * Read-only here, and the response says so by offering no way to change it.
   *
   * Shortening retention quietly deletes evidence the organisation may be asked for;
   * lengthening it holds a caller's voice past the basis their consent was collected
   * under. An operator sets it.
   */
  audioRetentionDays: integer({ minimum: 1 }),
  /**
   * How long the caller's words are kept — transcripts, call events and tool arguments.
   *
   * Shown beside the audio window and separate from it, because they are separate policies
   * and the words outlive the recording deliberately: the review loop corrects transcripts
   * and the eval corpus is built from those corrections. Read-only here for the same reason
   * `audioRetentionDays` is — the platform operator sets it, and a screen that could change
   * it would be a screen that could quietly extend how long identity numbers are held.
   */
  transcriptRetentionDays: integer({ minimum: 1 }),
  /** Read-only: the NDPR/NCC posture the outbound consent gate enforces on every call. */
  consent: object({
    policy: text({ maxLength: 64 }),
    basis: nullable(text({ maxLength: 500 })),
    callingEarliestHour: nullable(integer({ minimum: 0, maximum: 23 })),
    callingLatestHour: nullable(integer({ minimum: 0, maximum: 24 })),
  }),
});

/**
 * One field, because one field is what an organisation may change about itself today.
 *
 * A body of `{ name }` rather than a general patch: the other values on this document are
 * operator-set, and an endpoint that accepted them and ignored them would be worse than
 * one that does not accept them.
 */
const rename = object({ name: text({ maxLength: NAME_LIMIT }) });

@Controller(apiRoute("organization"))
export class OrganizationController {
  constructor(@Inject(OrganizationContext) private readonly db: OrganizationContext) {}

  @Get()
  @Endpoint({
    summary: "This organisation",
    description:
      "The company, not its agents. `/config` is the agent's script and is versioned; this is not. `audioRetentionDays` and `consent` are set by the platform operator and are shown here so a screen can explain them, not so it can change them.",
    capability: "config:read",
    response: organization,
  })
  async read(): Promise<Infer<typeof organization>> {
    const found = await this.db.tx((scope) => readOrganization(scope));
    // Only reachable if the organisation was deleted under a live session. The session
    // would outlive its own organisation, which is worth a 404 rather than a 500.
    if (found === null) throw new NotFoundException();
    return found;
  }

  @Patch()
  @Endpoint({
    summary: "Rename this organisation",
    description:
      "Cosmetic, and only here: an agent's name is what it says on a call, and this is not that. Renaming the organisation leaves every agent saying exactly what it said before.",
    capability: "config:write",
    body: rename,
    response: organization,
  })
  async rename(@FromBody() body: Infer<typeof rename>): Promise<Infer<typeof organization>> {
    const saved = await this.db.tx((scope) => renameOrganization(scope, body.name));
    if (saved === null) throw new NotFoundException();
    return saved;
  }
}
