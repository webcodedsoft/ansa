-- A place in the diary.
--
-- "Can I come in on Thursday afternoon" is the question a clinic's phone exists to answer,
-- and until now the agent could only capture it as a field and leave a human to ring back.
-- Booking needs three things the schema did not have: a diary, the hours it is open, and
-- the appointments in it.
--
-- **Hosted and connected diaries are one table.** The product decision is that an
-- organisation can keep its diary here, or point at one it already keeps in Google or
-- Outlook, and the call must not care which. So `appointment_calendars.source` says which,
-- `external_ref` names the outside one, and both kinds hold `appointment_bookings` — for a
-- hosted diary because this is the diary, for a connected one because a call that booked a
-- slot must be able to say so without a round trip to somebody else's API. The connector
-- adapter writes the same rows the hosted path does, with `external_ref` set.
--
-- **Availability is a weekly pattern, not a list of dates.** A clinic is open Monday to
-- Friday nine to five, and that fact does not change on the third of next month. Windows are
-- weekday plus minutes-past-midnight in the diary's own timezone, and it is the API layer's
-- job to expand them into dated slots, subtract the bookings, and offer what is left. A row
-- per date would be an ever-growing table saying the same thing fifty-two times.
--
-- **Two bookings cannot hold one slot, and the database says so.** The unique index at the
-- bottom is the whole reason this is in Postgres rather than in memory: two calls at once
-- both hear "Thursday at two is free" and both try to take it, and one of them must lose.
-- The index only counts live rows, because a cancelled appointment frees the slot and a
-- constraint that kept it taken would make cancellation pointless.
--
-- **A hold expires.** `held` is the state between "the agent said it is free" and "the
-- caller said yes", and it takes the slot for the same reason a booking does — the caller
-- who is deciding must not lose it mid-sentence. But a hold whose call dropped would take
-- the slot forever, so a held row must say when it lapses, and the expansion above treats a
-- lapsed hold as free.

-- ---------------------------------------------------------------------------
-- Calendars
-- ---------------------------------------------------------------------------

create table if not exists appointment_calendars (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  name             text not null,
  -- An IANA name, 'Africa/Lagos' for nearly everyone. Required rather than defaulted: the
  -- availability windows below are in this zone, and a diary that did not state it would be
  -- one whose slots silently moved when a server did.
  timezone         text not null,
  slot_minutes     integer not null default 30 check (slot_minutes > 0),
  buffer_minutes   integer not null default 0 check (buffer_minutes >= 0),
  source           text not null default 'hosted',
  -- The outside diary's own id, for a connected calendar. Meaningless for a hosted one.
  external_ref     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint appointment_calendars_source_check
    check (source in ('hosted', 'connector')),
  -- A connected diary with nothing to connect to is not a diary.
  constraint appointment_calendars_connector_has_ref
    check (source = 'hosted' or external_ref is not null)
);

comment on table appointment_calendars is
  'A diary the agent can book into — kept here (hosted) or mirrored from an outside one (connector, named by external_ref). Both hold appointment_bookings.';

comment on column appointment_calendars.timezone is
  'IANA zone the availability windows are expressed in. Not defaulted on purpose; see migration 0062.';

create index if not exists appointment_calendars_organization_idx
  on appointment_calendars (organization_id, created_at desc);

-- One outside diary connects once per organisation. Partial, because hosted diaries have no
-- ref and must not collide on null.
create unique index if not exists appointment_calendars_external_ref_idx
  on appointment_calendars (organization_id, external_ref)
  where external_ref is not null;

-- ---------------------------------------------------------------------------
-- Availability
-- ---------------------------------------------------------------------------

create table if not exists appointment_availability (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  calendar_id      uuid not null references appointment_calendars(id) on delete cascade,
  -- 0 is Sunday, matching Postgres' `extract(dow …)` and JavaScript's `getDay()`, so nothing
  -- between them has to translate.
  weekday          integer not null check (weekday between 0 and 6),
  -- Minutes past midnight in the calendar's timezone. 540 is nine in the morning; 1020 is
  -- five in the afternoon. A window may end at 1440, which is midnight at the close of day.
  start_minute     integer not null check (start_minute between 0 and 1439),
  end_minute       integer not null check (end_minute between 1 and 1440),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint appointment_availability_window_is_forwards
    check (end_minute > start_minute)
);

comment on table appointment_availability is
  'Recurring weekly opening windows for a calendar, as weekday plus minutes past midnight in the calendar''s timezone. Expanded into dated slots by the API layer.';

create index if not exists appointment_availability_organization_calendar_idx
  on appointment_availability (organization_id, calendar_id, weekday);

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------

create table if not exists appointment_bookings (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  /* Not cascaded. A diary with appointments in it is a set of promises to callers, and
     deleting the diary must not quietly break them; the API removes the bookings first or
     refuses. The default `no action` still lets an organisation delete cascade through
     organization_id, for the reason 0061 gives on campaigns.agent_id. */
  calendar_id      uuid not null references appointment_calendars(id),
  -- Who it is for, when we know. Nulled rather than cascaded: the slot is still taken if the
  -- contact record goes.
  contact_id       uuid references contacts(id) on delete set null,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  status           text not null default 'booked',
  -- A hold's lapse time. Required while held, meaningless otherwise; see the header.
  hold_expires_at  timestamptz,
  source           text not null default 'call',
  -- The call that made it, for the recording. Nulled when the retention sweep removes the
  -- call, because the appointment is still an appointment.
  call_id          uuid references calls(id) on delete set null,
  -- The outside diary's id for this booking, when a connector wrote it there.
  external_ref     text,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint appointment_bookings_status_check
    check (status in ('held', 'booked', 'cancelled')),
  constraint appointment_bookings_source_check
    check (source in ('call', 'manual', 'connector')),
  constraint appointment_bookings_is_forwards
    check (ends_at > starts_at),
  constraint appointment_bookings_hold_lapses
    check (status <> 'held' or hold_expires_at is not null)
);

comment on table appointment_bookings is
  'One appointment in a calendar. held is a slot a caller is deciding on and lapses at hold_expires_at; booked is confirmed; cancelled frees the slot. See migration 0062.';

create index if not exists appointment_bookings_organization_calendar_starts_idx
  on appointment_bookings (organization_id, calendar_id, starts_at);

-- Two live bookings cannot start at the same moment in the same diary. Cancelled rows are
-- outside the index so a cancellation frees the slot. A lapsed hold is *inside* it on
-- purpose: the row is still live until something cancels it, and it is the API's job to
-- cancel lapsed holds before offering the slot — the database cannot know the current time
-- in an index.
create unique index if not exists appointment_bookings_one_per_slot_idx
  on appointment_bookings (calendar_id, starts_at)
  where status <> 'cancelled';

-- ---------------------------------------------------------------------------
-- Isolation
-- ---------------------------------------------------------------------------

alter table appointment_calendars enable row level security;
alter table appointment_calendars force row level security;

drop policy if exists organization_isolation on appointment_calendars;
create policy organization_isolation on appointment_calendars
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

alter table appointment_availability enable row level security;
alter table appointment_availability force row level security;

drop policy if exists organization_isolation on appointment_availability;
create policy organization_isolation on appointment_availability
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

alter table appointment_bookings enable row level security;
alter table appointment_bookings force row level security;

drop policy if exists organization_isolation on appointment_bookings;
create policy organization_isolation on appointment_bookings
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

grant select, insert, update, delete on appointment_calendars to ansa_app;
grant select, insert, update, delete on appointment_availability to ansa_app;
grant select, insert, update, delete on appointment_bookings to ansa_app;

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

-- The trigger 0031 attached to every table then existing, for the three above.
do $migration$
declare
  target text;
begin
  foreach target in array array[
    'appointment_calendars', 'appointment_availability', 'appointment_bookings'
  ] loop
    execute format('drop trigger if exists %I on %I', target || '_touch_updated_at', target);
    execute format(
      'create trigger %I before update on %I for each row execute function app.touch_updated_at()',
      target || '_touch_updated_at',
      target
    );
  end loop;
end
$migration$;
