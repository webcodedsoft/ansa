-- The caller as a record of their own, rather than a fact about one call.
--
-- `call_captures` answers "what did we collect on this call" and answers it well: one
-- confirmed value per field per call, written at the moment of confirmation. What it cannot
-- answer is "who is this". It is keyed on `call_id`, so a caller who rings on Monday,
-- Wednesday and Friday is three unrelated sets of rows and nothing in the schema knows they
-- are one person. An estate agency does not want a log of confirmations. It wants the
-- enquirer: their name, their number, what they are looking for, and every call they have
-- made, in one place somebody can work through.
--
-- Identity is the caller's number, scoped to the organisation. Not a choice made here —
-- `readCallerHistory` already treats `calls.caller` as "have I spoken to this person
-- before", and a second notion of identity beside it would be two answers to one question.
-- A withheld number gets no contact at all: there is nobody to attach it to, and minting a
-- row per anonymous call would fill the list with strangers who are all the same stranger.
-- Those calls keep their `call_captures` rows, which is where an unattributable value
-- belongs.
--
-- Nothing here is a counter. How many times somebody has called, and when they first and
-- last did, are questions `calls` already answers exactly; storing them again would be a
-- number that drifts the first time a row is deleted or backfilled.

create table if not exists contacts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  -- E.164, copied from `calls.caller` at the moment a value is confirmed.
  phone            text not null,
  /* An operator's correction, and deliberately not the captured name.
   *
   * A caller says "Sikiru" and somebody in the office knows it is Sikiru Adeyemi and fixes
   * it. If that lived in the same column the capture writes, the next call would overwrite
   * the correction with the shorter name and the fix would look like a bug in the agent.
   * Null means "no one has corrected it"; the captured name is still in `contact_values`
   * and the console prefers this when it is set. */
  display_name     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- One person per number per organisation. This is the whole point of the table.
  unique (organization_id, phone)
);

comment on table contacts is
  'One record per caller number per organisation. Identity only; call counts and dates are derived from calls, and collected values live in contact_values.';

create table if not exists contact_values (
  organization_id  uuid not null references organizations(id) on delete cascade,
  contact_id       uuid not null references contacts(id) on delete cascade,
  -- Same key and type vocabulary as `call_captures`, so a value means the same thing in
  -- both places and one can be traced to the other.
  field_key        text not null,
  field_type       text not null,
  value            text not null,
  /* Which call last set it. A value with no provenance is an assertion; with it, an
     operator asking "where did this number come from" gets the recording. Nulled rather
     than cascaded on delete, because losing the call must not lose the value. */
  source_call_id   uuid references calls(id) on delete set null,
  updated_at       timestamptz not null default now(),
  -- Last confirmation wins. Somebody who corrects their number has one number; the earlier
  -- one is still on its own call in `call_captures`, which is where history belongs.
  primary key (contact_id, field_key)
);

comment on table contact_values is
  'The current value of each field for a contact, last confirmation wins, with the call that set it. History stays in call_captures.';

create index if not exists contacts_organization_updated_idx
  on contacts (organization_id, updated_at desc);

create index if not exists contact_values_organization_idx
  on contact_values (organization_id);

alter table contacts enable row level security;
alter table contacts force row level security;

drop policy if exists organization_isolation on contacts;
create policy organization_isolation on contacts
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

alter table contact_values enable row level security;
alter table contact_values force row level security;

drop policy if exists organization_isolation on contact_values;
create policy organization_isolation on contact_values
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

grant select, insert, update, delete on contacts to ansa_app;
grant select, insert, update, delete on contact_values to ansa_app;
