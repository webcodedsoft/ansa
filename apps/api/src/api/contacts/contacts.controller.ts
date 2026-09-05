import {
  addContacts,
  readContact,
  readContactCalls,
  readContactStats,
  readContacts,
  recordContactImport,
  renameContact,
  setContactValue,
  type NewContact,
} from "@ansa/db";
import { Controller, Get, Inject, NotFoundException, Patch, Post, Put, UnprocessableEntityException } from "@nestjs/common";

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
import { flag, integer, list, nullable, object, optional, text, type Infer } from "../http/schema";
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

/**
 * One person added by hand, for somebody who did not ring first.
 *
 * The phone is E.164 here — the same rule every other number field in this API enforces —
 * The phone is free text and normalised the same way the import route normalises it, not the
 * strict `phoneNumber()` the rest of the API uses: the add form promises "a Nigerian number
 * written however you have it, tidied to +234 when saved", and an operator typing `08030000000`
 * into it must get the same person a spreadsheet of the same number would. One normalisation
 * rule for both write paths; a number that cannot be read as one at all is a 422 on `phone`.
 */
const newContact = object({
  phone: text({ maxLength: 32 }),
  displayName: optional(text({ maxLength: 200 })),
  notes: optional(text({ maxLength: 2000 })),
});

/** What `addContacts` gives back for the one row: its id, and whether it was new. */
const addedContact = object({
  id: uuid(),
  phone: text({ maxLength: 32 }),
  /** False when the number was already known and the existing record was kept. */
  created: flag(),
});

/**
 * The largest batch one import may carry.
 *
 * A ceiling rather than a limit anyone reaches on purpose: it stops a single request from
 * becoming an unbounded insert and an unbounded parse, and a genuine list larger than this
 * is two imports, which the counts make legible anyway.
 */
const MAX_IMPORT_ROWS = 5000;

/**
 * One row of an uploaded list.
 *
 * The phone is free text, not `phoneNumber()`, on purpose: a spreadsheet holds `08030000000`
 * far more often than `+2348030000000`, and both are the same line. The handler normalises
 * each one and skips the cells that cannot be a number rather than rejecting the whole file
 * over one bad row.
 */
const importRow = object({
  phone: text({ minLength: 1, maxLength: 32 }),
  displayName: optional(text({ maxLength: 200 })),
  notes: optional(text({ maxLength: 2000 })),
});

const importRequest = object({
  sourceLabel: text({ minLength: 1, maxLength: 200 }),
  rows: list(importRow, { maxItems: MAX_IMPORT_ROWS }),
});

const importResult = object({
  importId: uuid(),
  /** Every row the operator sent, counted before anything was normalised or folded. */
  received: integer({ minimum: 0 }),
  /** Distinct numbers that did not already have a record. */
  added: integer({ minimum: 0 }),
  /** Distinct numbers that were already on the list; their existing record was kept. */
  alreadyKnown: integer({ minimum: 0 }),
  /** Rows whose phone could not be read as a number, and so were left out. */
  skipped: integer({ minimum: 0 }),
});

/**
 * A number from a list turned into the one form the rest of the system dials.
 *
 * E.164 passes through. A Nigerian national number — `0` then a mobile prefix then nine
 * digits — becomes `+234…`, because there is no other country it could be and refusing it
 * would fail on the commonest input rather than an unusual one; a bare `234…` is the same
 * number missing its plus. Anything else returns null, which the import counts as skipped.
 * This is the same shape `outbound/consent.ts` recognises, kept here as a third small copy
 * rather than a shared one for the reason `schemas.ts` gives about the E.164 pattern: a
 * malformed cell becomes a skipped row with a count, not a failure somewhere downstream.
 */
const E164 = /^\+[1-9][0-9]{6,14}$/;
const NIGERIAN_NATIONAL = /^0[789]\d{9}$/;

const toE164 = (raw: string): string | null => {
  const trimmed = raw.replace(/[\s()-]/g, "");
  if (E164.test(trimmed)) return trimmed;
  if (NIGERIAN_NATIONAL.test(trimmed)) return `+234${trimmed.slice(1)}`;
  if (/^234[789]\d{9}$/.test(trimmed)) return `+${trimmed}`;
  return null;
};

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

  @Post()
  @Endpoint({
    summary: "Add one person to the list by hand",
    description:
      "For somebody who did not ring first. The number is upserted, so adding a number that has already called returns that caller's existing record rather than a second one — `created` says which happened. The origin is recorded as `manual`.",
    capability: "contacts:write",
    body: newContact,
    response: addedContact,
    status: 201,
  })
  async add(@FromBody() body: Infer<typeof newContact>): Promise<Infer<typeof addedContact>> {
    const phone = toE164(body.phone);
    if (phone === null) {
      throw new UnprocessableEntityException("that phone number could not be read — a Nigerian number, or one in full +234 form");
    }
    const rows = await this.db.tx((scope) =>
      addContacts(
        scope,
        [{ phone, displayName: body.displayName ?? null, notes: body.notes ?? null }],
        "manual",
      ),
    );
    const added = rows[0];
    // addContacts returns one row per distinct phone, and one was given. An empty result
    // would mean the upsert wrote nothing, which is a bug rather than a not-found.
    if (added === undefined) throw new Error("adding one contact returned no row");
    return { id: added.id, phone: added.phone, created: added.created };
  }

  @Post("imports")
  @Endpoint({
    summary: "Bring in a list of people at once",
    description:
      "Accepts a labelled batch of rows. Each phone is normalised — a Nigerian national number becomes `+234…` — and a row whose phone cannot be read as a number is left out and counted in `skipped`, so one bad cell does not fail the whole upload. The batch is recorded first so every contact it creates carries its `importId`. `received` is what was sent; `added`, `alreadyKnown` and `skipped` are the outcome per distinct number.",
    capability: "contacts:write",
    body: importRequest,
    response: importResult,
    status: 201,
  })
  async import(@FromBody() body: Infer<typeof importRequest>): Promise<Infer<typeof importResult>> {
    let skipped = 0;
    const normalised: NewContact[] = [];
    for (const row of body.rows) {
      const phone = toE164(row.phone);
      if (phone === null) {
        skipped += 1;
        continue;
      }
      normalised.push({ phone, displayName: row.displayName ?? null, notes: row.notes ?? null });
    }

    const { batch, addedRows } = await this.db.tx(async (scope) => {
      // Recorded first, so `addContacts` has an id to stamp on every row it writes.
      // `rowCount` is what the operator uploaded, not what was new — the difference is
      // visible from the contacts themselves.
      const recorded = await recordContactImport(scope, {
        sourceLabel: body.sourceLabel,
        rowCount: body.rows.length,
        createdBy: this.db.caller.userId,
      });
      return { batch: recorded, addedRows: await addContacts(scope, normalised, "import", recorded.id) };
    });

    // A number listed twice in one batch is folded to a single row by `addContacts`, so
    // `added + alreadyKnown` counts distinct numbers rather than uploaded rows. `received`
    // is the raw count, which is why the four numbers need not sum.
    const added = addedRows.filter((row) => row.created).length;
    return {
      importId: batch.id,
      received: body.rows.length,
      added,
      alreadyKnown: addedRows.length - added,
      skipped,
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
