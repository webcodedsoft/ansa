-- A day the office is shut.
--
-- The diary (0062) knows the week: open Monday to Friday, nine to five. It does not know
-- that the first of October is Independence Day, so on the first of October the agent
-- cheerfully offers a caller ten o'clock and somebody drives across Lagos to a locked door.
-- That is not a prompt problem. A model told "do not book on public holidays" will book on
-- public holidays, because it does not have a list and cannot be given one that stays
-- correct. So the list lives here and the slot arithmetic reads it, and the offer is
-- withheld by code that cannot be talked out of it.
--
-- **A holiday is a date, not an instant.** `on_date` is `date` rather than `timestamptz`
-- and this is the whole design of the table. "1 October" is a square on a calendar; it
-- begins when midnight arrives wherever the calendar is kept. Stored as an instant it would
-- have to be stamped with *some* zone, and every calendar in another zone would then see the
-- holiday begin at the wrong hour — an office in Lagos shut from 01:00 on the second because
-- somebody typed the date while the server thought in UTC. A `date` carries no hour to get
-- wrong. The API turns it into a day in the calendar's own timezone, which is where a day
-- means something, and `packages/db` never does that arithmetic — the same division of
-- labour 0062 drew for availability windows.
--
-- **Organisation-wide, not per calendar.** The meaning of a row here is "this office is
-- shut", and an office that is shut is shut for the consulting room, the second consulting
-- room and the surveyor's diary alike. A `calendar_id` would make the common case — one
-- organisation, one list of Nigerian public holidays — into n copies that drift, and the
-- first symptom of the drift is one diary offering Christmas Day. If a genuine requirement
-- ever appears for one calendar to keep different closures from another, that is a second
-- table with a reason, not a nullable column added here in anticipation.
--
-- **No recurrence rule.** The tempting column is `repeats_annually`, and it is wrong for the
-- calendar this product actually serves. Christmas is the 25th of December every year;
-- Eid al-Fitr moves through the Gregorian year by roughly eleven days and its date is
-- announced by moon sighting, so it is not computable in advance at all; Nigerian public
-- holidays are gazetted each year and are moved to the Monday when they fall on a weekend.
-- A recurrence engine that handles Christmas and lies about Eid is worse than no engine,
-- because the lie is silent. One row per date per year is more rows and it is the honest
-- model: every row is a date somebody asserted, and none is a date a rule inferred.
--
-- **Unique on (organization_id, on_date).** One day is shut once. Two rows for the first of
-- October are two names for one fact, and the second is either a typo or a duplicate import;
-- either way the API answers 409 rather than growing the list. Not unique on the name — an
-- organisation may well have "Public holiday" against four different dates.
--
-- Nothing is seeded. The dates are the organisation's own assertion about its own office,
-- and a seeded list would be this repository claiming to know which days a particular
-- business closes — including the ones it closes for reasons no gazette has, like a
-- stocktake or the week the owner is away.

create table if not exists holidays (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  -- The calendar square, with no hour on it. See the header: an instant here would start the
  -- holiday at the wrong time for every zone but the one it was written in.
  on_date          date not null,
  -- What it is: 'Independence Day', 'Eid al-Fitr', 'Stocktake'. Required, because a date with
  -- no name in a console list is a row nobody dares delete.
  name             text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint holidays_name_not_blank check (btrim(name) <> '')
);

comment on table holidays is
  'Dates an organisation''s office is shut. Organisation-wide, one row per date per year, no recurrence rule — see migration 0064. The slot arithmetic reads these and offers nothing on them; a booking may still be written on one deliberately.';

comment on column holidays.on_date is
  'A calendar date, not an instant. Judged in the calendar''s own timezone by the API. Deliberately `date`; see migration 0064.';

-- One day is shut once.
create unique index if not exists holidays_organization_date_idx
  on holidays (organization_id, on_date);

-- ---------------------------------------------------------------------------
-- Isolation
-- ---------------------------------------------------------------------------

alter table holidays enable row level security;
alter table holidays force  row level security;

drop policy if exists organization_isolation on holidays;
create policy organization_isolation on holidays
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

grant select, insert, update, delete on holidays to ansa_app;

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

drop trigger if exists holidays_touch_updated_at on holidays;
create trigger holidays_touch_updated_at
  before update on holidays
  for each row execute function app.touch_updated_at();
