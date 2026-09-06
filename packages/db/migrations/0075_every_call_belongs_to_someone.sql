-- Every call files itself under a person.
--
-- The contact was a side effect of confirming a value: `merge_captures_into_contact` runs from
-- `recordCaptures`, which returns early when a call captured nothing, so a call where the agent
-- confirmed nothing created no person at all. And the way back from a person to their calls was
-- the string join `contacts.phone = calls.caller`, which outbound can never satisfy — on an
-- outbound call `caller` is *our* number and `dialled` is theirs. A person a campaign rang showed
-- "0 calls" on a page promising every call from that number.
--
-- Two columns fix both. `calls.contact_id` makes the relationship real, resolved once when the
-- call record opens, from the *counterparty* rather than the caller: inbound that is `caller`,
-- outbound it is `dialled`. Null stays legal and stays meaningful — a withheld number has nobody
-- to file it under, which is the existing design and not a gap.
--
-- `contacts.identified` is the answer to "should every caller really be in the directory". Yes,
-- everyone is remembered — but a wrong number and a three-second hangup are not customers, so a
-- person is `identified` only once they confirm something, and the directory shows those by
-- default with the rest behind a filter. Without it, "any caller becomes a contact" means
-- scrolling past misdials to find somebody.

alter table calls
  add column if not exists contact_id uuid references contacts(id) on delete set null;

comment on column calls.contact_id is
  'The person on the other end, resolved when the call record opens. Null for a withheld number, which has nobody to file it under.';

create index if not exists calls_contact_recent_idx
  on calls (organization_id, contact_id, created_at desc)
  where contact_id is not null;

alter table contacts
  add column if not exists identified boolean not null default false;

comment on column contacts.identified is
  'True once this person has confirmed something — a name, a callback number, any captured field. False is a caller we have rung or who rang us and who has told us nothing yet.';

create index if not exists contacts_identified_idx
  on contacts (organization_id, identified);

-- Backfill, per direction, because the counterparty is not the same column on both.
update calls c
   set contact_id = ct.id
  from contacts ct
 where ct.organization_id = c.organization_id
   and c.contact_id is null
   and ct.phone = case when c.direction = 'outbound' then c.dialled else c.caller end;

-- Anybody who has ever confirmed a value, or whose name an operator corrected, was identified
-- all along; the column is new, the fact is not.
update contacts ct
   set identified = true
 where identified = false
   and (ct.display_name is not null
        or exists (select 1 from contact_values v where v.contact_id = ct.id));
