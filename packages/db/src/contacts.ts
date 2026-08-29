import type { OrganizationId } from "@ansa/shared";

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

export interface Contact {
  readonly id: string;
  readonly phone: string;
  /** An operator's correction, or null when nobody has made one. */
  readonly displayName: string | null;
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
 * Driven from the call rather than from a caller string handed in, which is what keeps the
 * number honest: the insert reads `calls.caller` in the same statement, so a contact can
 * only ever be created for a call this organisation actually holds. A call with a withheld
 * number selects no row and writes nothing — correctly, because there is nobody to file it
 * under, and one contact per anonymous call would be a list of strangers who are all the
 * same stranger.
 *
 * Called after `recordCaptures` and inside the same organisation scope. Not a trigger: a
 * trigger would put this on the call path's write, and it belongs to the console's read.
 */
export const mergeCapturesIntoContact = async (
  scope: OrganizationScope,
  callRowId: string,
): Promise<void> => {
  const created = await scope.query<Record<string, unknown>>(
    `insert into contacts (organization_id, phone)
     select c.organization_id, c.caller
       from calls c
      where c.id = $1
        and c.caller is not null
        and c.caller <> ''
     on conflict (organization_id, phone) do update
       set updated_at = now()
     returning id`,
    [callRowId],
  );

  const contactId = created[0]?.["id"];
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
  readonly limit?: number;
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
  query: ContactQuery = {},
): Promise<readonly ContactSummary[]> => {
  const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? 200)), 1_000);
  const search = query.search?.trim() ?? "";

  const rows = await scope.query<Record<string, unknown>>(
    `select ct.id, ct.phone, ct.display_name, ct.created_at, ct.updated_at,
            count(c.id)::int          as call_count,
            min(c.created_at)         as first_call_at,
            max(c.created_at)         as last_call_at
       from contacts ct
       left join calls c on c.caller = ct.phone
      where ($1 = ''
             or ct.phone ilike '%' || $1 || '%'
             or coalesce(ct.display_name, '') ilike '%' || $1 || '%'
             or exists (select 1 from contact_values v
                         where v.contact_id = ct.id and v.value ilike '%' || $1 || '%'))
      group by ct.id
      order by max(c.created_at) desc nulls last, ct.updated_at desc
      limit $2`,
    [search, limit],
  );
  if (rows.length === 0) return [];

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

  return rows.map((row) => ({
    ...asContact(row),
    callCount: Number(row["call_count"]),
    firstCallAt: row["first_call_at"] === null ? null : new Date(String(row["first_call_at"])),
    lastCallAt: row["last_call_at"] === null ? null : new Date(String(row["last_call_at"])),
    values: byContact.get(String(row["id"])) ?? [],
  }));
};

/** One person, or null when this organisation holds no such contact. */
export const readContact = async (
  scope: OrganizationScope,
  contactId: string,
): Promise<ContactSummary | null> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select ct.id, ct.phone, ct.display_name, ct.created_at, ct.updated_at,
            count(c.id)::int  as call_count,
            min(c.created_at) as first_call_at,
            max(c.created_at) as last_call_at
       from contacts ct
       left join calls c on c.caller = ct.phone
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
  const rows = await scope.query<Record<string, unknown>>(
    `update contacts
        set display_name = $2, updated_at = now()
      where id = $1
      returning id`,
    [contactId, trimmed === "" ? null : trimmed],
  );
  return rows.length > 0;
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
