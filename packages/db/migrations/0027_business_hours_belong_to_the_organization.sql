-- Opening hours are the company's, not the agent's.
--
-- Migration 0018 moved every column a caller experiences onto `agents`, and swept business
-- hours along with them because they sat in the same block. That was wrong on inspection:
-- a greeting and a persona differ between an agent that answers sales and one that takes
-- messages after hours, but "when is this company open" has one answer, and two agents
-- disagreeing about it is a bug rather than a configuration.
--
-- It also made the after-hours case incoherent. An after-hours agent exists precisely
-- because the office is shut; if it carried its own opening hours it could be configured
-- to believe the office is open, which is the one thing it must never think.
--
-- So they come back to `organizations`, and the agent reads them. The call path is
-- unaffected in shape — the three config functions already join `organizations` for the
-- shared columns, so this is one more column in a join that was happening anyway.

alter table organizations add column if not exists business_open_hour  integer;
alter table organizations add column if not exists business_close_hour integer;
alter table organizations add column if not exists business_days       integer[];

-- Backfilled from the organisation's oldest live agent, which is where 0018 put the
-- organisation's own values in the first place. Nothing has been able to make two agents
-- disagree since, because nothing has offered a per-agent hours screen.
update organizations o
   set business_open_hour  = a.business_open_hour,
       business_close_hour = a.business_close_hour,
       business_days       = a.business_days
  from (
    select distinct on (organization_id)
           organization_id, business_open_hour, business_close_hour, business_days
      from agents
     where archived_at is null
     order by organization_id, created_at, id
  ) a
 where a.organization_id = o.id
   and a.business_open_hour is not null;

-- The same three-or-none rule migration 0012 wrote, now where it belongs. Two of three
-- columns is not a partially configured schedule, it is one nobody can evaluate.
alter table organizations drop constraint if exists organizations_business_hours_all_or_none;
alter table organizations add constraint organizations_business_hours_all_or_none check (
  (business_open_hour is null and business_close_hour is null and business_days is null)
  or
  (business_open_hour is not null and business_close_hour is not null and business_days is not null)
);

-- And off the agent, including out of its history: a version snapshot that still carried
-- opening hours would be recording something the agent never owned.
alter table agents drop constraint if exists agents_business_hours_all_or_none;
alter table agents drop column if exists business_open_hour;
alter table agents drop column if exists business_close_hour;
alter table agents drop column if exists business_days;

alter table agent_prompt_versions drop column if exists business_open_hour;
alter table agent_prompt_versions drop column if exists business_close_hour;
alter table agent_prompt_versions drop column if exists business_days;
