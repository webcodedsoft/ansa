-- When the organisation is open, so the agent can stop guessing (R6.5).
--
-- Deliberately NOT the columns 0007 already added. `calling_earliest_hour` and
-- `calling_latest_hour` bound when *we* may dial someone: a legal constraint about other
-- people's evenings, clamped to 08:00-20:00 and not the tenant's to widen. Opening hours
-- are when the tenant's own staff are there, they are the tenant's to set, and a business
-- that answers its phones from 07:00 is making a claim about itself rather than about a
-- stranger. Reusing one pair of columns for both would be wrong for whichever tenant
-- noticed second.
--
-- Stored in WAT, with no timezone column. Every tenant on this platform serves Nigerian
-- callers on a Nigerian clock; a timezone nobody sets is a timezone that is wrong the
-- first time somebody does. See packages/shared/src/clock.ts for the one definition of
-- what WAT means.
--
-- Null on every existing row, and that is the honest default. A tenant who has not told
-- us their hours has an agent that says it does not know them, which is the same rule the
-- rest of Slice 5 follows: an assistant answering confidently from configuration nobody
-- wrote is worse than one that says it cannot check.

-- Inclusive. 0-23.
alter table tenants add column if not exists business_open_hour  integer;
-- Exclusive, so a line that shuts at five stores 17 and is closed at 17:00. 1-24, which
-- allows a round-the-clock line to store 0 and 24.
alter table tenants add column if not exists business_close_hour integer;
-- ISO-8601 weekdays: 1 is Monday, 7 is Sunday. Not Postgres's 0-is-Sunday, because
-- opening hours are written down as "Monday to Friday" and a working week that wraps
-- around zero turns every comparison into an off-by-one.
alter table tenants add column if not exists business_days       integer[];

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_business_hours_sane') then
    -- All three together or none of them: two thirds of an opening-hours row cannot be
    -- reasoned about, and the application would have to invent the missing third.
    --
    -- An overnight window is refused rather than stored. `22 to 2` could be a night shift
    -- or a typo, the two produce opposite answers to "are you open now", and there is no
    -- way to tell them apart from the row. A tenant who genuinely works overnight needs
    -- this constraint reconsidered on purpose rather than a guess made on their behalf.
    alter table tenants add constraint tenants_business_hours_sane check (
      (business_open_hour is null and business_close_hour is null and business_days is null)
      or (
        business_open_hour between 0 and 23
        and business_close_hour between 1 and 24
        and business_open_hour < business_close_hour
        and business_days is not null
        and array_length(business_days, 1) between 1 and 7
        and business_days <@ array[1, 2, 3, 4, 5, 6, 7]
      )
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Versioned, because the agent says them out loud
-- ---------------------------------------------------------------------------

-- 0011 left knowledge base, tools and escalation rules out of the history on the grounds
-- that nothing read them. Opening hours are read on every call that asks, and they change
-- the words a caller hears, so "why did it tell me you were shut on the 3rd?" has to be
-- answerable from the version the call recorded (R7.5).

alter table tenant_prompt_versions add column if not exists business_open_hour  integer;
alter table tenant_prompt_versions add column if not exists business_close_hour integer;
alter table tenant_prompt_versions add column if not exists business_days       integer[];

-- Backfill: whatever the tenant holds now belongs to the version it is currently on. Null
-- for everyone today, and correct rather than empty for anyone who set hours by hand
-- between this migration being written and being applied.
update tenant_prompt_versions p
   set business_open_hour  = t.business_open_hour,
       business_close_hour = t.business_close_hour,
       business_days       = t.business_days
  from tenants t
 where p.tenant_id = t.id
   and p.version = t.config_version
   and p.business_open_hour is null
   and p.business_close_hour is null
   and p.business_days is null;

-- Whole config, never a patch: a version that silently inherited half its values from the
-- last one makes the history unreadable. So the three hours parameters are applied as
-- given, nulls included, exactly as voice_id and greeting already are.
drop function if exists app.publish_tenant_config(uuid, text, text, text, text, text, text[], text);
create function app.publish_tenant_config(
  tenant              uuid,
  p_name              text,
  p_voice_id          text,
  p_greeting          text,
  p_persona           text,
  p_instructions      text,
  p_keyterms          text[],
  p_open_hour         integer,
  p_close_hour        integer,
  p_business_days     integer[],
  p_note              text
) returns integer
  language plpgsql
  volatile
as $$
declare
  next_version integer;
begin
  if app.current_tenant() is distinct from tenant then
    raise exception
      'publish_tenant_config needs the tenant scope set: select set_config(''app.tenant_id'', ...)';
  end if;

  update tenants
     set name                = coalesce(p_name, name),
         voice_id            = p_voice_id,
         greeting            = p_greeting,
         persona             = p_persona,
         instructions        = p_instructions,
         keyterms            = coalesce(p_keyterms, '{}'),
         business_open_hour  = p_open_hour,
         business_close_hour = p_close_hour,
         business_days       = p_business_days,
         config_version      = config_version + 1
   where id = tenant
   returning config_version into next_version;

  if next_version is null then
    raise exception 'no such tenant: %', tenant;
  end if;

  insert into tenant_prompt_versions
    (tenant_id, version, name, voice_id, greeting, persona, instructions, keyterms,
     business_open_hour, business_close_hour, business_days, note)
  select id, config_version, name, voice_id, greeting, persona, instructions, keyterms,
         business_open_hour, business_close_hour, business_days, p_note
    from tenants where id = tenant;

  return next_version;
end
$$;

revoke all on function app.publish_tenant_config(uuid, text, text, text, text, text, text[], integer, integer, integer[], text) from public;
grant execute on function app.publish_tenant_config(uuid, text, text, text, text, text, text[], integer, integer, integer[], text) to ansa_app;

drop function if exists app.tenant_config_at_version(uuid, integer);
create function app.tenant_config_at_version(tenant uuid, v integer)
  returns table (
    id                  uuid,
    name                text,
    keyterms            text[],
    voice_id            text,
    greeting            text,
    persona             text,
    instructions        text,
    business_open_hour  integer,
    business_close_hour integer,
    business_days       integer[],
    config_version      integer
  )
  language sql
  stable
as $$
  select p.tenant_id, p.name, p.keyterms, p.voice_id, p.greeting, p.persona,
         p.instructions, p.business_open_hour, p.business_close_hour, p.business_days,
         p.version
    from tenant_prompt_versions p
   where p.tenant_id = tenant and p.version = v
$$;

revoke all on function app.tenant_config_at_version(uuid, integer) from public;
grant execute on function app.tenant_config_at_version(uuid, integer) to ansa_app;

-- ---------------------------------------------------------------------------
-- The one-round-trip readers learn about them
-- ---------------------------------------------------------------------------

-- DROP then CREATE, not CREATE OR REPLACE: the return type changes and Postgres will not
-- replace a function whose OUT columns differ. Unchanged in every other respect — same
-- trust boundary, same one round trip, same grants. See 0003, 0004, 0005 and 0011.

drop function if exists app.tenant_config_for_number(text);
create function app.tenant_config_for_number(dialled text)
  returns table (
    id                  uuid,
    name                text,
    keyterms            text[],
    voice_id            text,
    greeting            text,
    persona             text,
    instructions        text,
    business_open_hour  integer,
    business_close_hour integer,
    business_days       integer[],
    config_version      integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select t.id, t.name, t.keyterms, t.voice_id, t.greeting, t.persona, t.instructions,
         t.business_open_hour, t.business_close_hour, t.business_days, t.config_version
    from tenants t
   where t.dialled_number = dialled
   limit 1
$$;

revoke all on function app.tenant_config_for_number(text) from public;
grant execute on function app.tenant_config_for_number(text) to ansa_app;

drop function if exists app.tenant_config_for_id(uuid);
create function app.tenant_config_for_id(tenant uuid)
  returns table (
    id                  uuid,
    name                text,
    keyterms            text[],
    voice_id            text,
    greeting            text,
    persona             text,
    instructions        text,
    business_open_hour  integer,
    business_close_hour integer,
    business_days       integer[],
    config_version      integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select t.id, t.name, t.keyterms, t.voice_id, t.greeting, t.persona, t.instructions,
         t.business_open_hour, t.business_close_hour, t.business_days, t.config_version
    from tenants t
   where t.id = tenant
   limit 1
$$;

revoke all on function app.tenant_config_for_id(uuid) from public;
grant execute on function app.tenant_config_for_id(uuid) to ansa_app;
