-- A campaign that runs again on its own.
--
-- A campaign runs its list once and is done. Most of the catalogue repeats — rent on the
-- first, premiums monthly, dormant accounts quarterly — and the operator's workflow for
-- those was Duplicate, Add contacts, Start, by hand, every time. The campaign that matters
-- most is the one somebody forgot.
--
-- A series is a rhythm and a template. Each run is an ordinary campaign, created here by the
-- sweeper the way Duplicate creates one, with its start and end set, and handed to
-- start_due_campaigns like any scheduled campaign. Nothing downstream — the dialler, the
-- brief, the outcomes, the page — learns the word "series", so nothing that proves a
-- campaign works has to be proved twice.
--
-- The template is a real campaign, not a frozen copy, because it is the thing the operator
-- edits: a change to its purpose lands on the next run, since each run copies at creation.
-- Unlike Duplicate, a run copies the template's list — re-ringing everyone is the point.
-- A person the last run suppressed is not copied; the consent gate would refuse them again,
-- but a row that exists only to be refused is a row somebody has to read past.
--
-- `every` is an interval, not a cron: "1 month" from the 31st lands where Postgres puts it,
-- and nobody on the phone has ever asked for the third Tuesday. `next_run_at` is
-- materialised so the sweeper reads one column. `(series_id, run_number)` is unique, which
-- is what makes create_due_runs safe to run from two sweepers at once: the second insert
-- of the same run fails the key and creates nothing.

create table if not exists campaign_series (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  template_id     uuid not null references campaigns(id) on delete cascade,
  name            text not null,
  every           interval not null,
  -- The first run's start. Run n starts at anchor_at + n * every.
  anchor_at       timestamptz not null,
  -- How long each run may take; a run's ends_at is its starts_at + this.
  run_for         interval not null,
  next_run_at     timestamptz not null,
  runs_created    integer not null default 0,
  paused_at       timestamptz,
  ended_at        timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint campaign_series_every_check check (every >= interval '1 day'),
  constraint campaign_series_run_for_check check (run_for >= interval '1 hour' and run_for <= every),
  -- One series per template. A template that fed two rhythms would ring people twice.
  constraint campaign_series_template_key unique (template_id)
);

alter table campaign_series enable row level security;
alter table campaign_series force row level security;

drop policy if exists campaign_series_organization on campaign_series;
create policy campaign_series_organization on campaign_series
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

grant select, insert, update, delete on campaign_series to ansa_app;

create index if not exists campaign_series_due_idx
  on campaign_series (next_run_at)
  where paused_at is null and ended_at is null;

alter table campaigns
  add column if not exists series_id uuid references campaign_series(id) on delete set null,
  add column if not exists run_number integer;

create unique index if not exists campaigns_series_run_key
  on campaigns (series_id, run_number)
  where series_id is not null;

comment on column campaigns.series_id is
  'The series that created this campaign as one of its runs. Null for a one-off, and for the template itself.';
comment on column campaigns.run_number is
  'Which run of the series this is, from 1. Unique per series, which is what stops a run being created twice.';

-- Create every run that has come due. Unscoped and security definer like start_due_campaigns
-- beside it, for the same reason: the sweeper has no organisation in hand.
drop function if exists app.create_due_runs();
create or replace function app.create_due_runs()
  returns table(out_campaign_id uuid, out_series_id uuid, out_organization_id uuid, out_run_number integer)
  language plpgsql
  volatile
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
declare
  s record;
  run_id uuid;
  n integer;
begin
  for s in
    select cs.*
      from campaign_series cs
     where cs.paused_at is null
       and cs.ended_at is null
       and cs.next_run_at <= now()
     order by cs.next_run_at
     for update skip locked
  loop
    n := s.runs_created + 1;

    insert into campaigns
      (organization_id, agent_id, name, status, calling_window, purpose, opening, flow,
       outcomes, voicemail, max_attempts, retry_after_minutes, max_concurrent_calls,
       max_calls_per_hour, starts_at, ends_at, series_id, run_number, created_by)
    select cp.organization_id, cp.agent_id,
           s.name || ' — run ' || n,
           'scheduled', cp.calling_window, cp.purpose, cp.opening, cp.flow, cp.outcomes,
           cp.voicemail, cp.max_attempts, cp.retry_after_minutes, cp.max_concurrent_calls,
           cp.max_calls_per_hour,
           s.next_run_at, s.next_run_at + s.run_for,
           s.id, n, s.created_by
      from campaigns cp
     where cp.id = s.template_id
    returning id into run_id;

    -- The template's list, minus anybody a previous run suppressed. Facts come across as
    -- the template holds them: the template is where the operator keeps them current.
    insert into scheduled_calls (organization_id, campaign_id, contact_id, next_attempt_at, facts)
    select sc.organization_id, run_id, sc.contact_id, s.next_run_at, sc.facts
      from scheduled_calls sc
     where sc.campaign_id = s.template_id
       and not exists (
         select 1
           from scheduled_calls prior
           join campaigns pc on pc.id = prior.campaign_id
          where pc.series_id = s.id
            and prior.contact_id = sc.contact_id
            and prior.status = 'suppressed'
       )
    on conflict (campaign_id, contact_id) do nothing;

    update campaign_series
       set runs_created = n,
           next_run_at = s.next_run_at + s.every,
           updated_at = now()
     where id = s.id;

    out_campaign_id := run_id;
    out_series_id := s.id;
    out_organization_id := s.organization_id;
    out_run_number := n;
    return next;
  end loop;
end
$function$;

revoke all on function app.create_due_runs() from public;
grant execute on function app.create_due_runs() to ansa_app;
