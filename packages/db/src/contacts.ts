import type { OrganizationId } from "@ansa/shared";

import { pageOrder, pageParams, TOTAL_COLUMN, toSlice, type PageRequest, type PageSlice, type WithTotal }
  from "./paging";
import type { OrganizationScope } from "./organization-scope";

/**
 * The caller as a person, assembled from what they have told us across every call.
 *
 * `call_captures` is the per-call record and stays exactly as it is: what was confirmed, on
 * which call, at what moment. This is the other question — who is this — and it is the one
 * an operator working a list of enquiries actually asks. The two are kept apart on purpose:
 * a call is history and cannot change, a contact is current truth and does.
 *
 * Identity is the caller's number. Nothing here invents a second notion of it; the
 * orchestrator already treats `calls.caller` as "have I spoken to this person before".
 */

export interface ContactValue {
  readonly fieldKey: string;
  readonly fieldType: string;
  readonly value: string;
  readonly sourceCallId: string | null;
  readonly updatedAt: Date;
}

/**
 * How a contact came into being (0061). `contacts_source_check` is the enforcement; this
 * union exists so a caller cannot reach the constraint by accident.
 */
export type ContactSource = "call" | "manual" | "import";

export interface Contact {
  readonly id: string;
  readonly phone: string;
  /** An operator's correction, or null when nobody has made one. */
  readonly displayName: string | null;
  /** The origin of the row. Does not change when the same number later arrives another way. */
  readonly source: ContactSource;
  /** Free text an operator keeps. Never spoken and never read by a call. */
  readonly notes: string | null;
  /** The `contact_imports` batch this came in on, or null for anyone who was not imported. */
  readonly importId: string | null;
  /**
   * Whether this person has ever told us anything.
   *
   * False is a real caller we hold a number for and nothing else — a wrong number, a misdial,
   * somebody who hung up. They are remembered, and the directory keeps them behind a filter
   * rather than in front of the customers.
   */
  readonly identified: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A contact with the counts the list needs, all derived from `calls`. */
export interface ContactSummary extends Contact {
  readonly callCount: number;
  readonly firstCallAt: Date | null;
  readonly lastCallAt: Date | null;
  readonly values: readonly ContactValue[];
}

const asContact = (row: Record<string, unknown>): Contact => ({
  id: String(row["id"]),
  phone: String(row["phone"]),
  displayName: row["display_name"] === null ? null : String(row["display_name"]),
  source: String(row["source"]) as ContactSource,
  notes: row["notes"] === null ? null : String(row["notes"]),
  importId: row["import_id"] === null ? null : String(row["import_id"]),
  identified: row["identified"] === true,
  createdAt: new Date(String(row["created_at"])),
  updatedAt: new Date(String(row["updated_at"])),
});

const asValue = (row: Record<string, unknown>): ContactValue => ({
  fieldKey: String(row["field_key"]),
  fieldType: String(row["field_type"]),
  value: String(row["value"]),
  sourceCallId: row["source_call_id"] === null ? null : String(row["source_call_id"]),
  updatedAt: new Date(String(row["updated_at"])),
});

/**
 * Fold one call's confirmed values onto the person who gave them.
 *
 * It no longer creates the person. `recordCallStarted` resolves them when the call record
 * opens (0075), so this follows the link the call already carries — which is also what makes
 * it right for outbound, where the old insert would have read `calls.caller` and made a
 * contact for our own number. A call with a withheld number carries no link and writes
 * nothing, correctly: there is nobody to file it under, and one contact per anonymous call
 * would be a list of strangers who are all the same stranger.
 *
 * Confirming a value is also what marks somebody `identified`, which is the difference
 * between a person the directory leads with and a misdial behind its filter.
 *
 * Called after `recordCaptures` and inside the same organisation scope. Not a trigger: a
 * trigger would put this on the call path's write, and it belongs to the console's read.
 */
export const mergeCapturesIntoContact = async (
  scope: OrganizationScope,
  callRowId: string,
): Promise<void> => {
  /* The person already exists: `recordCallStarted` resolved them when the call record
     opened (0075). This reads that link rather than minting a second one from `caller`,
     which on an outbound call is our own number and would have created a contact for
     ourselves. Confirming a value is also what makes somebody `identified` — they have now
     told us something, so they belong in the directory rather than behind its filter. */
  const linked = await scope.mutate<Record<string, unknown>>(
    `update contacts ct
        set identified = true, updated_at = now()
       from calls c
      where c.id = $1 and ct.id = c.contact_id
      returning ct.id`,
    [callRowId],
  );

  const contactId = linked[0]?.["id"];
  if (contactId === undefined) return;

  /* Last confirmation wins, and only forwards. The guard on `updated_at` matters because
     batches from one call can land out of order under retry, and a stale flush must not
     overwrite a correction the caller made after it. */
  await scope.query(
    `insert into contact_values
       (organization_id, contact_id, field_key, field_type, value, source_call_id, updated_at)
     select cc.organization_id, $2::uuid, cc.field_key, cc.field_type, cc.value, cc.call_id,
            cc.confirmed_at
       from call_captures cc
      where cc.call_id = $1
     on conflict (contact_id, field_key) do update
       set value = excluded.value,
           field_type = excluded.field_type,
           source_call_id = excluded.source_call_id,
           updated_at = excluded.updated_at
     where excluded.updated_at >= contact_values.updated_at`,
    [callRowId, String(contactId)],
  );
};

export interface ContactQuery {
  /** Matches the number or any stored value, so searching a name finds the person. */
  readonly search?: string | null;
  /**
   * True for the people who have told us something, false for the ones who have not, and
   * undefined for everybody.
   *
   * The directory leads with the identified, because everyone being remembered is only useful
   * if the customers are not buried under the misdials.
   */
  readonly identified?: boolean | null;
}

/**
 * Everyone this organisation has collected something from, most recent first.
 *
 * The counts come from `calls` rather than from columns on `contacts`. A stored counter is
 * a number that drifts the first time a call is deleted or a range is backfilled, and the
 * query answering it exactly is one join.
 */
export const readContacts = async (
  scope: OrganizationScope,
  page: PageRequest,
  query: ContactQuery = {},
): Promise<PageSlice<ContactSummary>> => {
  const search = query.search?.trim() ?? "";
  const identified = query.identified ?? null;

  /* `count(*) over()` counts groups, not rows, because window functions are evaluated after
     GROUP BY — so the total is the number of people matching, which is what the pager needs,
     and not the number of their calls. */
  const rows = await scope.query<Record<string, unknown> & WithTotal>(
    `select ct.id, ct.phone, ct.display_name, ct.source, ct.notes, ct.import_id, ct.identified,
            ct.created_at, ct.updated_at,
            count(c.id)::int          as call_count,
            min(c.created_at)         as first_call_at,
            max(c.created_at)         as last_call_at,
            ${TOTAL_COLUMN}
       from contacts ct
       left join calls c on c.contact_id = ct.id
      where ($1 = ''
             or ct.phone ilike '%' || $1 || '%'
             or coalesce(ct.display_name, '') ilike '%' || $1 || '%'
             or exists (select 1 from contact_values v
                         where v.contact_id = ct.id and v.value ilike '%' || $1 || '%'))
        and ($4::boolean is null or ct.identified = $4::boolean)
      group by ct.id
      order by max(c.created_at) desc nulls last, ct.updated_at desc
      limit $2 offset $3`,
    [search, page.limit, page.offset, identified],
  );
  if (rows.length === 0) return { items: [], total: 0 };

  const values = await scope.query<Record<string, unknown>>(
    `select contact_id, field_key, field_type, value, source_call_id, updated_at
       from contact_values
      where contact_id = any($1::uuid[])
      order by field_key`,
    [rows.map((row) => String(row["id"]))],
  );

  const byContact = new Map<string, ContactValue[]>();
  for (const row of values) {
    const key = String(row["contact_id"]);
    const list = byContact.get(key) ?? [];
    list.push(asValue(row));
    byContact.set(key, list);
  }

  return toSlice(rows, (row) => ({
    ...asContact(row),
    callCount: Number(row["call_count"]),
    firstCallAt: row["first_call_at"] === null ? null : new Date(String(row["first_call_at"])),
    lastCallAt: row["last_call_at"] === null ? null : new Date(String(row["last_call_at"])),
    values: byContact.get(String(row["id"])) ?? [],
  }));
};

export interface ContactStats {
  readonly total: number;
  /** How many of them have ever told us anything. The rest are numbers and nothing else. */
  readonly identified: number;
  /** People who have rung more than once — the ones a callback list is actually about. */
  readonly repeatCallers: number;
  /** First heard from in the last seven days. */
  readonly newThisWeek: number;
}

/**
 * The three numbers the directory is worth stating.
 *
 * Counted across the whole organisation rather than the page on screen. A total derived from
 * the rows a page happens to hold is wrong the moment there is a second page, and a number
 * that is wrong is worse than no number.
 */
export const readContactStats = async (scope: OrganizationScope): Promise<ContactStats> => {
  const rows = await scope.query<Record<string, unknown>>(
    `with per as (
       select ct.id, ct.created_at, ct.identified, count(c.id)::int as calls
         from contacts ct
         left join calls c on c.contact_id = ct.id
        group by ct.id
     )
     select count(*)::int                                                    as total,
            count(*) filter (where identified)::int                          as identified,
            count(*) filter (where calls > 1)::int                           as repeat_callers,
            count(*) filter (where created_at >= now() - interval '7 days')::int as new_this_week
       from per`,
  );
  const row = rows[0];
  return {
    total: Number(row?.["total"] ?? 0),
    identified: Number(row?.["identified"] ?? 0),
    repeatCallers: Number(row?.["repeat_callers"] ?? 0),
    newThisWeek: Number(row?.["new_this_week"] ?? 0),
  };
};

/** One person, or null when this organisation holds no such contact. */
export const readContact = async (
  scope: OrganizationScope,
  contactId: string,
): Promise<ContactSummary | null> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select ct.id, ct.phone, ct.display_name, ct.source, ct.notes, ct.import_id, ct.identified,
            ct.created_at, ct.updated_at,
            count(c.id)::int  as call_count,
            min(c.created_at) as first_call_at,
            max(c.created_at) as last_call_at
       from contacts ct
       left join calls c on c.contact_id = ct.id
      where ct.id = $1
      group by ct.id`,
    [contactId],
  );
  const row = rows[0];
  if (row === undefined) return null;

  const values = await scope.query<Record<string, unknown>>(
    `select field_key, field_type, value, source_call_id, updated_at
       from contact_values
      where contact_id = $1
      order by field_key`,
    [contactId],
  );

  return {
    ...asContact(row),
    callCount: Number(row["call_count"]),
    firstCallAt: row["first_call_at"] === null ? null : new Date(String(row["first_call_at"])),
    lastCallAt: row["last_call_at"] === null ? null : new Date(String(row["last_call_at"])),
    values: values.map(asValue),
  };
};

export interface ContactCall {
  readonly callId: string;
  readonly carrierCallId: string;
  readonly agentId: string | null;
  readonly calledAt: Date;
  readonly endReason: string | null;
  readonly durationSeconds: number | null;
  readonly direction: string;
  /** Null while the call is still up. The only honest way to tell "live" from "ended quietly". */
  readonly endedAt: Date | null;
  /** What the call came to, when the sweeper has written it. Null until then. */
  readonly summary: string | null;
}

/**
 * Every call this person has made or been made, newest first.
 *
 * Through `calls.contact_id` (0075), not the number. It used to match on the string, on the
 * reasoning that a call belongs to a caller before any contact exists for them — which was
 * true while the contact was created by the first confirmed value. It is not true now: the
 * person is resolved when the call record opens, so every call has its key from the start,
 * and the old ones were backfilled.
 *
 * The string join also had a defect the reasoning hid. It matched `calls.caller`, and on an
 * outbound call `caller` is *our* number — so a person a campaign rang could never appear in
 * their own history. The key is resolved from the counterparty and both directions land here.
 */
export const readContactCalls = async (
  scope: OrganizationScope,
  contactId: string,
  page: PageRequest,
): Promise<PageSlice<ContactCall>> => {
  /* The contact id binds first, so the limit and offset start at $2 — `pageOrder`'s `from`
     exists for exactly this, and without it a filtered list has to bind its own parameter
     after the limit, which is how a uuid ends up bound to `limit`. */
  /* The summary rides along so the timeline can say what each call was about under its
     title, which is the line somebody actually reads. Left-joined: a call summarised later
     than this page loads simply has null here, not a missing row. */
  const rows = await scope.query<Record<string, unknown> & WithTotal>(
    `select c.id, c.carrier_call_id, c.agent_id, c.created_at, c.ended_at, c.end_reason,
            c.duration_seconds, c.direction, s.summary, ${TOTAL_COLUMN}
       from calls c
       left join call_summaries s on s.call_id = c.id
      where c.contact_id = $1
      ${pageOrder("c.created_at", "c.id", 2)}`,
    [contactId, ...pageParams(page)],
  );
  return toSlice(rows, (row) => ({
    callId: String(row["id"]),
    carrierCallId: String(row["carrier_call_id"]),
    agentId: row["agent_id"] === null ? null : String(row["agent_id"]),
    calledAt: new Date(String(row["created_at"])),
    endedAt: row["ended_at"] === null ? null : new Date(String(row["ended_at"])),
    endReason: row["end_reason"] === null ? null : String(row["end_reason"]),
    durationSeconds: row["duration_seconds"] === null ? null : Number(row["duration_seconds"]),
    direction: String(row["direction"]),
    summary: row["summary"] === null || row["summary"] === undefined ? null : String(row["summary"]),
  }));
};

/** An appointment this person holds, as the contact timeline needs it. */
export interface ContactAppointment {
  readonly id: string;
  readonly startsAt: Date;
  readonly status: string;
  readonly title: string | null;
  /** The call that booked or moved it, when one did. Null for an import or a console edit. */
  readonly callId: string | null;
  /** When the row last changed — which is when the *booking* happened, not when it is for. */
  readonly bookedAt: Date;
}

/**
 * What this person has booked.
 *
 * On the timeline the entry sits at `bookedAt`, not `startsAt`: the spine is a record of what
 * has happened, and a viewing on Thursday has not happened yet. The date it is *for* is the
 * detail line, which is the thing somebody actually reads.
 */
export const readContactAppointments = async (
  scope: OrganizationScope,
  contactId: string,
): Promise<readonly ContactAppointment[]> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select id, starts_at, status, title, call_id, updated_at
       from appointment_bookings
      where contact_id = $1
      order by updated_at desc
      limit 50`,
    [contactId],
  );
  return rows.map((row) => ({
    id: String(row["id"]),
    startsAt: new Date(String(row["starts_at"])),
    status: String(row["status"]),
    title: row["title"] === null ? null : String(row["title"]),
    callId: row["call_id"] === null ? null : String(row["call_id"]),
    bookedAt: new Date(String(row["updated_at"])),
  }));
};

/** A consent grant or withdrawal, as a moment on the spine. */
export interface ContactConsentEvent {
  readonly at: Date;
  readonly kind: "granted" | "withdrawn";
  readonly basis: string | null;
}

/**
 * When this number's consent was recorded, and when it was withdrawn.
 *
 * Both halves are moments and both belong on the spine: "consent recorded — existing
 * relationship" is the answer to "why were we allowed to ring them", and a withdrawal is the
 * answer to why the calls stopped. The consent panel says what the position is *now*; this
 * says when it changed, which is the question a complaint asks.
 *
 * Scoped by `app.current_organization()` like every other read here — a grant is evidence one
 * organisation holds, and it is not another's to see.
 */
export const readContactConsentEvents = async (
  scope: OrganizationScope,
  phone: string,
): Promise<readonly ContactConsentEvent[]> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select granted_at, revoked_at, basis
       from outbound_consent
      where organization_id = app.current_organization() and phone_number = $1
      order by granted_at desc
      limit 20`,
    [phone],
  );

  const events: ContactConsentEvent[] = [];
  for (const row of rows) {
    const basis = row["basis"] === null ? null : String(row["basis"]);
    events.push({ at: new Date(String(row["granted_at"])), kind: "granted", basis });
    /* A withdrawal is its own entry rather than a flag on the grant. They happened at two
       different times and the gap between them is the interesting part. */
    if (row["revoked_at"] !== null) {
      events.push({ at: new Date(String(row["revoked_at"])), kind: "withdrawn", basis });
    }
  }
  return events;
};

/**
 * How many of this person's calls ended up with a human.
 *
 * Counted from the `escalated to a human` event rather than from an end reason, because that
 * event is what the handoff path actually writes — a call can be escalated and still end for
 * some other reason, and counting end reasons would miss exactly those.
 *
 * Across their whole history, not the page: unlike the weekly count, this figure cannot be
 * wrong for a paged history, so there is no reason to withhold it.
 */
export const readContactHandoffs = async (
  scope: OrganizationScope,
  contactId: string,
): Promise<number> => {
  const rows = await scope.query<{ n: string }>(
    `select count(distinct c.id) as n
       from calls c
       join call_events e on e.call_id = c.id
      where c.contact_id = $1 and e.kind = 'escalated to a human'`,
    [contactId],
  );
  return Number(rows[0]?.n ?? 0);
};

/**
 * The person a call belongs to, for the call page's way back.
 *
 * The name is chosen the way the console chooses it everywhere — an operator's correction,
 * then the captured name, then nothing — so the link at the top of a call says the same
 * thing as the row in the directory it leads to. Null when the call has nobody: a withheld
 * number, or a record from before 0075 that the backfill could not place.
 */
export const readCallContact = async (
  scope: OrganizationScope,
  callId: string,
): Promise<{ readonly id: string; readonly name: string | null } | null> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select ct.id,
            coalesce(
              nullif(trim(ct.display_name), ''),
              (select nullif(trim(v.value), '') from contact_values v
                where v.contact_id = ct.id and v.field_type = 'name'
                order by v.updated_at desc limit 1)
            ) as name
       from calls c
       join contacts ct on ct.id = c.contact_id
      where c.id = $1`,
    [callId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { id: String(row["id"]), name: row["name"] === null ? null : String(row["name"]) };
};

/**
 * Correct the name on a record.
 *
 * Stored beside the captured name rather than over it. Somebody in the office knows the
 * caller who said "Sikiru" is Sikiru Adeyemi; if that overwrote the capture, the next call
 * would put the short name back and the correction would look like the agent losing it.
 * Passing null clears the correction and the captured name shows again.
 */
export const renameContact = async (
  scope: OrganizationScope,
  contactId: string,
  displayName: string | null,
): Promise<boolean> => {
  const trimmed = displayName?.trim() ?? "";
  /* `mutate`, not `query`: an update comes back as `[rows, affectedCount]`, so `.length > 0`
     on the raw result is a two-element array test that is true even when nothing matched —
     which for a contact belonging to another organisation means reporting a write RLS
     refused. See the note on `OrganizationScope.mutate`. */
  const rows = await scope.mutate<Record<string, unknown>>(
    `update contacts
        set display_name = $2, updated_at = now()
      where id = $1
      returning id`,
    [contactId, trimmed === "" ? null : trimmed],
  );
  return rows.length > 0;
};


export interface NewContact {
  /** E.164, as it will be dialled. The API normalises; this stores what it is given. */
  readonly phone: string;
  readonly displayName?: string | null;
  readonly notes?: string | null;
}

export interface AddedContact {
  readonly id: string;
  readonly phone: string;
  /** False when the number was already known and the existing row was kept. */
  readonly created: boolean;
}

/**
 * Put people on the list who did not ring us first.
 *
 * An upsert on the number, which is what keeps one person one row: an imported number that
 * has already called is the caller's existing record, not a second one. On that existing
 * row the origin stays what it was, a name fills in only where nobody had one — an
 * operator's correction outranks a spreadsheet — and notes fill in the same way.
 *
 * Returns every row, new or not, because what the caller does next — enqueue them on a
 * campaign — needs all the ids and not only the fresh ones.
 *
 * A number listed twice in one batch is folded to one row before the insert. Postgres
 * refuses to update the same row twice in one `on conflict`, and a spreadsheet with a
 * duplicate line is the normal case rather than the error.
 */
export const addContacts = async (
  scope: OrganizationScope,
  contacts: readonly NewContact[],
  source: Exclude<ContactSource, "call">,
  importId: string | null = null,
): Promise<readonly AddedContact[]> => {
  if (contacts.length === 0) return [];
  const rows = await scope.query<Record<string, unknown>>(
    /* `identified` is true for everyone who arrives this way: an operator typed them in, or
       they came off a list of people somebody already knew. It is only a caller who has told
       us nothing that stays behind the directory's filter. */
    `insert into contacts (organization_id, phone, display_name, notes, source, import_id, identified)
     select app.current_organization(), p.phone, p.display_name, p.notes, $3, $4::uuid, true
       from (select distinct on (phone) phone, display_name, notes
               from unnest($1::text[], $2::text[], $5::text[]) as u(phone, display_name, notes)
              order by phone, display_name nulls last) as p
     on conflict (organization_id, phone) do update
       set display_name = coalesce(contacts.display_name, excluded.display_name),
           notes        = coalesce(contacts.notes, excluded.notes),
           identified   = true
     returning id, phone, (xmax = 0) as created`,
    [
      contacts.map((c) => c.phone),
      contacts.map((c) => c.displayName?.trim() || null),
      source,
      importId,
      contacts.map((c) => c.notes?.trim() || null),
    ],
  );
  return rows.map((row) => ({
    id: String(row["id"]),
    phone: String(row["phone"]),
    created: row["created"] === true,
  }));
};

/**
 * Correct one collected value, or add one nobody said.
 *
 * The provenance goes to null, which is the honest record: this value did not come from a
 * call and must not claim one. The console shows the difference.
 */
export const setContactValue = async (
  scope: OrganizationScope,
  contactId: string,
  input: { readonly fieldKey: string; readonly fieldType: string; readonly value: string },
): Promise<void> => {
  await scope.query(
    `insert into contact_values
       (organization_id, contact_id, field_key, field_type, value, source_call_id, updated_at)
     values ($1, $2, $3, $4, $5, null, now())
     on conflict (contact_id, field_key) do update
       set value = excluded.value,
           field_type = excluded.field_type,
           source_call_id = null,
           updated_at = now()`,
    [scope.organizationId, contactId, input.fieldKey, input.fieldType, input.value],
  );
};

export type { OrganizationId };
