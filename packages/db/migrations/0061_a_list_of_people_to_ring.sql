-- A list of people to ring, and the record of ringing them.
--
-- Outbound has existed since 0006 as a single verb: place one call to one number, having
-- proved consent first. What it has never had is a plan. An organisation that wants to ring
-- two hundred policyholders about their renewals has nowhere to write those two hundred
-- numbers down, nothing that works through the list, and nothing that says which of them
-- answered. That is three tables, and this migration adds them beside one that already
-- exists.
--
-- **The contact is the person, whichever way they arrived.** 0059 created `contacts` as the
-- caller — one row per number per organisation, minted the first time a call confirmed a
-- value. A person on an uploaded list is the same kind of thing, and the estate agency that
-- rings them and then takes their call back wants one record, not one per direction. So
-- there is no `leads` table. A contact gains `source`, which says how the row came into
-- being, and `notes`, which is where "spoke to her husband, call back Thursday" goes. The
-- unique key on the number is unchanged, and it is what makes an imported number that later
-- rings in the same person rather than a duplicate.
--
-- **The plan is a campaign; the intent to ring one person is a scheduled call.** A campaign
-- names the agent that speaks and the hours it may speak in. A scheduled call is one row per
-- contact per campaign and carries the state that changes: how many attempts, when the next
-- one is due, what the last one came to. The call itself, once placed, is a row in `calls`
-- like any other — the media path below the answer is shared and there is no second call
-- record here, only a foreign key to the one there is.
--
-- **Suppression and consent are not re-modelled.** `do_not_call` (0006, made writable in 0044)
-- and `outbound_consent` (0006) already exist, and `mayCall` in `apps/api/src/outbound` is
-- the only thing that reads them. A scheduler draining `scheduled_calls` must put every row
-- through that gate before dialling and write `suppressed` when it refuses; the `status`
-- vocabulary below has that word so the refusal is a recorded fact and not a row that
-- silently never fires. The gate stays in code, per CLAUDE.md — nothing in `calling_window`
-- can widen the hours `mayCall` clamps to, because `mayCall` does not read it as permission.

-- ---------------------------------------------------------------------------
-- Contacts, whichever way they arrived
-- ---------------------------------------------------------------------------

-- `display_name`, `created_at` and `updated_at` were on the table from 0059 and are left as
-- they are.
alter table contacts
  add column if not exists source text not null default 'call';

alter table contacts drop constraint if exists contacts_source_check;
alter table contacts add constraint contacts_source_check
  check (source in ('call', 'manual', 'import'));

alter table contacts
  add column if not exists notes text;

comment on column contacts.source is
  'How this row came into being: ''call'' from a confirmed capture, ''manual'' typed in the console, ''import'' from a contact_imports batch. Records the origin and does not change when the same number later arrives another way. See migration 0061.';

comment on column contacts.notes is
  'Free text an operator keeps about the person. Not spoken to anyone and not read by any call.';

-- One import batch, so a list of eighty numbers that came in together can be seen — and
-- undone — together. Append-only: a batch is a thing that happened.
create table if not exists contact_imports (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  -- Where the list came from, in words the operator chose: 'CSV', 'Google', a spreadsheet's
  -- name. Free text because an enum here would guess at connectors that do not exist yet.
  source_label     text not null,
  row_count        integer not null default 0 check (row_count >= 0),
  imported_at      timestamptz not null default now(),
  /* Who uploaded it. Nulled rather than cascaded when the member goes, for the reason
     `agent_config_drafts.updated_by` gives: losing the person must not lose the record. */
  created_by       uuid references users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table contact_imports is
  'One row per batch of contacts brought in from outside. The contacts themselves are rows in contacts with source = ''import'' and import_id pointing here.';

-- Which batch a contact came in on. Null for every contact that was not imported, and set
-- to null rather than deleting the contact if the batch record goes: the person is still a
-- person, the import is only how we met them.
alter table contacts
  add column if not exists import_id uuid references contact_imports(id) on delete set null;

create index if not exists contacts_organization_import_idx
  on contacts (organization_id, import_id)
  where import_id is not null;

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------

create table if not exists campaigns (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  /* The agent that places the calls. Not cascaded: an agent is soft-deleted in practice
     (0032), and a hard delete that took a campaign's history with it would be a loss nobody
     asked for. The default `no action` is checked at the end of the statement, so deleting
     an organisation — which cascades here through organization_id first — still succeeds. */
  agent_id         uuid not null references agents(id),
  name             text not null,
  status           text not null default 'draft',
  /* Time-of-day and weekday limits, as a document the API layer defines. Nullable, and null
     means "the default window" — 08:00 to 20:00 WAT, which `mayCall` applies regardless.
     This can narrow that window and cannot widen it, because the gate does not consult it
     as permission. */
  calling_window   jsonb,
  created_by       uuid references users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint campaigns_status_check
    check (status in ('draft', 'scheduled', 'running', 'paused', 'done')),
  constraint campaigns_calling_window_is_object
    check (calling_window is null or jsonb_typeof(calling_window) = 'object')
);

comment on table campaigns is
  'A plan to ring a list of contacts with one agent, inside a calling window. The list itself is scheduled_calls.';

comment on column campaigns.calling_window is
  'Hours and weekdays this campaign may dial, as an object the API layer shapes. Null means the default window. Narrows the window mayCall enforces and can never widen it.';

create index if not exists campaigns_organization_status_idx
  on campaigns (organization_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Scheduled calls
-- ---------------------------------------------------------------------------

create table if not exists scheduled_calls (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  -- Deleting the plan deletes the intent to ring. Calls already placed stay in `calls`.
  campaign_id      uuid not null references campaigns(id) on delete cascade,
  -- Deleting the person deletes the intent too: there is nobody left to ring.
  contact_id       uuid not null references contacts(id) on delete cascade,
  status           text not null default 'pending',
  attempts         integer not null default 0 check (attempts >= 0),
  -- When the queue should next pick this up. Null once there is nothing left to try.
  next_attempt_at  timestamptz,
  last_attempt_at  timestamptz,
  -- What the last attempt came to, in words: the carrier's reason, `mayCall`'s refusal, the
  -- agent's summary. Free text; `status` is the part code reads.
  outcome          text,
  /* The call that was actually placed, once one was. Nulled if the call row is deleted —
     the retention sweep (0032) removes old calls and must not remove the fact that a
     campaign rang somebody. */
  call_id          uuid references calls(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint scheduled_calls_status_check
    check (status in ('pending', 'placing', 'answered', 'no_answer', 'busy', 'voicemail',
                      'failed', 'suppressed')),
  -- One intent per person per campaign. Ringing the same number twice from one list is the
  -- complaint outbound exists to avoid, so the database refuses it rather than the import.
  unique (campaign_id, contact_id)
);

comment on table scheduled_calls is
  'One row per contact per campaign: the intent to ring them, how many times it has been tried, and what came of it. Every row passes mayCall before it is dialled; ''suppressed'' records that it did not.';

comment on column scheduled_calls.status is
  'pending and placing are live; the rest are terminal for this attempt. A no_answer or busy row is re-queued by setting next_attempt_at and status back to pending, which is why attempts is a counter and not derived.';

create index if not exists scheduled_calls_organization_campaign_status_idx
  on scheduled_calls (organization_id, campaign_id, status);

-- The queue. Only rows that could be dialled are in it, so a finished campaign of a
-- thousand rows costs the scheduler nothing to skip.
create index if not exists scheduled_calls_organization_due_idx
  on scheduled_calls (organization_id, next_attempt_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- Isolation
-- ---------------------------------------------------------------------------

alter table contact_imports enable row level security;
alter table contact_imports force row level security;

drop policy if exists organization_isolation on contact_imports;
create policy organization_isolation on contact_imports
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

alter table campaigns enable row level security;
alter table campaigns force row level security;

drop policy if exists organization_isolation on campaigns;
create policy organization_isolation on campaigns
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

alter table scheduled_calls enable row level security;
alter table scheduled_calls force row level security;

drop policy if exists organization_isolation on scheduled_calls;
create policy organization_isolation on scheduled_calls
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

grant select, insert, update, delete on contact_imports to ansa_app;
grant select, insert, update, delete on campaigns to ansa_app;
grant select, insert, update, delete on scheduled_calls to ansa_app;

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

-- The trigger 0031 attached to every table then existing, for the three tables above and
-- for `contacts`, which 0059 created with the column and without the trigger. Not for
-- `contact_values`: its `updated_at` is the moment the caller confirmed the value, written
-- on purpose from `call_captures.confirmed_at` and compared on the way in, and a trigger
-- stamping now() over it would break the "last confirmation wins, and only forwards" rule.
do $migration$
declare
  target text;
begin
  foreach target in array array['contacts', 'contact_imports', 'campaigns', 'scheduled_calls'] loop
    execute format('drop trigger if exists %I on %I', target || '_touch_updated_at', target);
    execute format(
      'create trigger %I before update on %I for each row execute function app.touch_updated_at()',
      target || '_touch_updated_at',
      target
    );
  end loop;
end
$migration$;
