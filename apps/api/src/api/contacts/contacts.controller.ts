import {
  readContact,
  readContactCalls,
  readContactStats,
  readContacts,
  renameContact,
  setContactValue,
} from "@ansa/db";
import { Controller, Get, Inject, NotFoundException, Patch, Put } from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import {
  PAGE_PROPS,
  pageQuery,
  pageResponse,
  toPageBody,
  toPageRequest,
  type PageQuery,
} from "../http/pagination";
import { apiRoute, FromBody, FromPath, FromQuery } from "../http/request";
import { integer, list, nullable, object, optional, text, type Infer } from "../http/schema";
import { timestamp, uuid } from "../schemas";
import { OrganizationContext } from "../tenancy/organization-context";

/**
 * The people who have called, rather than the calls they made.
 *
 * `GET /calls/captures` answers "what have we collected", one row per confirmed value. This
 * answers "who is this", which is the question somebody working a list of enquiries asks.
 * The two read the same confirmations; only one of them is keyed on a person.
 *
 * Values are returned as the caller gave them and nothing is masked, for the reason the
 * captures endpoint states: R5.2.4, and the organisation is the data controller of their
 * own callers' data.
 */

const contactValue = object({
  fieldKey: text({ maxLength: 128 }),
  fieldType: text({ maxLength: 32 }),
  value: text({ maxLength: 4096 }),
  /** The call that last set it, or null when somebody typed it in here. */
  sourceCallId: nullable(uuid()),
  updatedAt: timestamp(),
});

const contact = object({
  id: uuid(),
  phone: text({ maxLength: 32 }),
  /** An operator's correction. Null means the captured name still stands. */
  displayName: nullable(text({ maxLength: 200 })),
  callCount: integer({ minimum: 0 }),
  firstCallAt: nullable(timestamp()),
  lastCallAt: nullable(timestamp()),
  values: list(contactValue),
  createdAt: timestamp(),
  updatedAt: timestamp(),
});

const contactsQuery = object({
  ...PAGE_PROPS,
  /** Matches the number, the corrected name, or any value they gave. */
  search: optional(text({ maxLength: 200 })),
});

/**
 * Three counts taken across the whole organisation, not the page.
 *
 * Derived here rather than by the client because a total worked out from the rows one page
 * happens to hold is wrong the moment there is a second page, and a number that is wrong is
 * worse than no number.
 */
const contactStats = object({
  people: integer({ minimum: 0 }),
  /** People who have rung more than once — what a callback list is actually about. */
  repeatCallers: integer({ minimum: 0 }),
  newThisWeek: integer({ minimum: 0 }),
});

const contactsPage = pageResponse(contact);

const contactsResponse = object({
  page: contactsPage,
  stats: contactStats,
});

const contactPath = object({ contactId: uuid() });

const contactCall = object({
  callId: uuid(),
  carrierCallId: text({ maxLength: 128 }),
  agentId: nullable(uuid()),
  calledAt: timestamp(),
  endReason: nullable(text({ maxLength: 64 })),
  durationSeconds: nullable(integer({ minimum: 0 })),
  direction: text({ maxLength: 16 }),
});

const contactDetail = object({
  contact,
  /**
   * Every call from this number, newest first, whether or not it collected anything.
   *
   * Paginated for the reason the calls list is: a number that rings a contact centre weekly
   * has hundreds, and a page that renders all of them is slow for the one person who wanted
   * the last three.
   */
  calls: pageResponse(contactCall),
});

const rename = object({ displayName: nullable(text({ maxLength: 200 })) });

const valueChange = object({
  fieldKey: text({ maxLength: 128 }),
  fieldType: text({ maxLength: 32 }),
  value: text({ maxLength: 4096 }),
});

@Controller(apiRoute("contacts"))
export class ContactsController {
  constructor(@Inject(OrganizationContext) private readonly db: OrganizationContext) {}

  @Get()
  @Endpoint({
    summary: "Everyone who has called, most recent first",
    description:
      "One record per caller number, carrying what they have told the agent across every call. `search` matches the number, an operator's corrected name, or any value they gave, so looking up a name finds the person. Values are returned as the caller gave them and nothing is masked.",
    capability: "contacts:read",
    query: contactsQuery,
    response: contactsResponse,
  })
  async list(
    @FromQuery() query: Infer<typeof contactsQuery>,
  ): Promise<Infer<typeof contactsResponse>> {
    const { slice, stats } = await this.db.tx(async (scope) => ({
      slice: await readContacts(scope, toPageRequest(query), { search: query.search ?? null }),
      stats: await readContactStats(scope),
    }));
    return {
      page: toPageBody({ items: slice.items.map(asBody), total: slice.total }, query),
      stats: {
        people: stats.total,
        repeatCallers: stats.repeatCallers,
        newThisWeek: stats.newThisWeek,
      },
    };
  }

  @Get(":contactId")
  @Endpoint({
    summary: "One person, and every call they have made",
    description:
      "The call list is matched on the number rather than through a key, so calls made before this contact existed are still theirs.",
    capability: "contacts:read",
    params: contactPath,
    query: pageQuery,
    response: contactDetail,
  })
  async detail(
    @FromPath() path: Infer<typeof contactPath>,
    @FromQuery() query: PageQuery,
  ): Promise<Infer<typeof contactDetail>> {
    const found = await this.db.tx(async (scope) => {
      const person = await readContact(scope, path.contactId);
      if (person === null) return null;
      return { person, calls: await readContactCalls(scope, path.contactId, toPageRequest(query)) };
    });
    // Not ours, which under RLS is also what another organisation's contact looks like.
    // Answering 404 to both is the point: a 403 would confirm the id exists.
    if (found === null) throw new NotFoundException();
    return {
      contact: asBody(found.person),
      calls: toPageBody(
        {
          items: found.calls.items.map((call) => ({
            callId: call.callId,
            carrierCallId: call.carrierCallId,
            agentId: call.agentId,
            calledAt: call.calledAt.toISOString(),
            endReason: call.endReason,
            durationSeconds: call.durationSeconds,
            direction: call.direction,
          })),
          total: found.calls.total,
        },
        query,
      ),
    };
  }

  @Patch(":contactId")
  @Endpoint({
    summary: "Correct the name on a record",
    description:
      "Stored beside the captured name, never over it, so the next call cannot put the old one back. Send null to clear the correction and let the captured name show again.",
    capability: "contacts:write",
    params: contactPath,
    body: rename,
    response: object({ id: uuid(), displayName: nullable(text({ maxLength: 200 })) }),
  })
  async rename(
    @FromPath() path: Infer<typeof contactPath>,
    @FromBody() body: Infer<typeof rename>,
  ): Promise<{ id: string; displayName: string | null }> {
    const changed = await this.db.tx((scope) =>
      renameContact(scope, path.contactId, body.displayName),
    );
    if (!changed) throw new NotFoundException();
    return { id: path.contactId, displayName: body.displayName };
  }

  @Put(":contactId/values")
  @Endpoint({
    summary: "Correct a collected value, or add one",
    description:
      "The value's provenance becomes null, which is the honest record: this did not come from a call and must not claim one.",
    capability: "contacts:write",
    params: contactPath,
    body: valueChange,
    response: contact,
  })
  async setValue(
    @FromPath() path: Infer<typeof contactPath>,
    @FromBody() body: Infer<typeof valueChange>,
  ): Promise<Infer<typeof contact>> {
    const updated = await this.db.tx(async (scope) => {
      const person = await readContact(scope, path.contactId);
      if (person === null) return null;
      await setContactValue(scope, path.contactId, body);
      return readContact(scope, path.contactId);
    });
    if (updated === null) throw new NotFoundException();
    return asBody(updated);
  }
}

/** One shape on the wire, whichever handler produced it. */
const asBody = (person: Awaited<ReturnType<typeof readContact>> & object): Infer<typeof contact> => ({
  id: person.id,
  phone: person.phone,
  displayName: person.displayName,
  callCount: person.callCount,
  firstCallAt: person.firstCallAt?.toISOString() ?? null,
  lastCallAt: person.lastCallAt?.toISOString() ?? null,
  values: person.values.map((value) => ({
    fieldKey: value.fieldKey,
    fieldType: value.fieldType,
    value: value.value,
    sourceCallId: value.sourceCallId,
    updatedAt: value.updatedAt.toISOString(),
  })),
  createdAt: person.createdAt.toISOString(),
  updatedAt: person.updatedAt.toISOString(),
});
