-- Where an escalation goes, per tenant (R6.5, and Slice 7's "different escalation rules").
--
-- Until now there was one destination for the whole process, read from HANDOFF_TO_NUMBER
-- at boot. `apps/api/src/handoff/destination.ts` has said since Slice 6 that this "is a
-- single-tenant assumption with a deadline on it". Onboarding a second tenant is that
-- deadline, and the failure it produces is not subtle: an angry caller to the second
-- organisation is dialled through to the first organisation's staff phone, and the whisper
-- summary of a conversation they have no relationship with is read out to whoever picks
-- up. RLS could not have stopped it, because no row was ever read across a boundary — the
-- number simply did not come from the tenant.
--
-- The environment variable stays, as the platform fallback for a deployment with one
-- tenant and no rows filled in. A tenant row wins over it whenever it is set.
--
-- Versioned like business hours and for the same reason: it changes what happens to a
-- caller, so "who did it transfer me to on the 3rd?" has to be answerable from the version
-- the call recorded (R7.5).

-- E.164. The person who picks up.
alter table tenants add column if not exists escalation_to_number    text;
-- E.164, and it must be a number the carrier account owns — the carrier rejects an
-- origination from anything else, at the moment the caller has just been told they are
-- being put through.
alter table tenants add column if not exists escalation_from_number  text;
-- How long their phone rings before the caller is given up on. Null takes the platform
-- default rather than storing a guess.
alter table tenants add column if not exists escalation_ring_seconds integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_escalation_sane') then
    -- Both numbers or neither: a destination with no origination cannot be dialled, and
    -- discovering that at the carrier means discovering it after the caller has been
    -- promised a person. The shape check is the same E.164 the application applies to the
    -- environment variable, so a typo fails on publish rather than on a transfer.
    alter table tenants add constraint tenants_escalation_sane check (
      (escalation_to_number is null and escalation_from_number is null)
      or (
        escalation_to_number   ~ '^\+[1-9][0-9]{6,14}$'
        and escalation_from_number ~ '^\+[1-9][0-9]{6,14}$'
      )
    );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'tenants_escalation_ring_sane') then
    -- Five seconds is not a transfer, and five minutes is a caller who has hung up.
    alter table tenants add constraint tenants_escalation_ring_sane check (
      escalation_ring_seconds is null
      or escalation_ring_seconds between 5 and 120
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Versioned
-- ---------------------------------------------------------------------------

alter table tenant_prompt_versions add column if not exists escalation_to_number    text;
alter table tenant_prompt_versions add column if not exists escalation_from_number  text;
alter table tenant_prompt_versions add column if not exists escalation_ring_seconds integer;

-- Whatever the tenant holds now belongs to the version it is currently on. Null for
-- everyone today; correct rather than empty for anyone who fills these in by hand between
-- this migration being written and being applied.
update tenant_prompt_versions p
   set escalation_to_number    = t.escalation_to_number,
       escalation_from_number  = t.escalation_from_number,
       escalation_ring_seconds = t.escalation_ring_seconds
  from tenants t
 where p.tenant_id = t.id
   and p.version = t.config_version
   and p.escalation_to_number is null
   and p.escalation_from_number is null;

-- ---------------------------------------------------------------------------
-- Publishing
-- ---------------------------------------------------------------------------

-- DROP then CREATE, not CREATE OR REPLACE: the signature changes. Same note as 0003, 0004,
-- 0005, 0011, 0012, 0013 and 0014, for the same reason.
drop function if exists app.publish_tenant_config(uuid, text, text, text, text, text, text[], integer, integer, integer[], jsonb, jsonb, text);
create function app.publish_tenant_config(
  tenant                uuid,
  p_name                text,
  p_voice_id            text,
  p_greeting            text,
  p_persona             text,
  p_instructions        text,
  p_keyterms            text[],
  p_open_hour           integer,
  p_close_hour          integer,
  p_business_days       integer[],
  p_tool_config         jsonb,
  p_event_config        jsonb,
  p_escalation_to       text,
  p_escalation_from     text,
  p_escalation_ring     integer,
  p_note                text
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
     set name                    = coalesce(p_name, name),
         voice_id                = p_voice_id,
         greeting                = p_greeting,
         persona                 = p_persona,
         instructions            = p_instructions,
         keyterms                = coalesce(p_keyterms, '{}'),
         business_open_hour      = p_open_hour,
         business_close_hour     = p_close_hour,
         business_days           = p_business_days,
         tool_config             = p_tool_config,
         event_config            = p_event_config,
         escalation_to_number    = p_escalation_to,
         escalation_from_number  = p_escalation_from,
         escalation_ring_seconds = p_escalation_ring,
         config_version          = config_version + 1
   where id = tenant
   returning config_version into next_version;

  if next_version is null then
    raise exception 'no such tenant: %', tenant;
  end if;

  insert into tenant_prompt_versions
    (tenant_id, version, name, voice_id, greeting, persona, instructions, keyterms,
     business_open_hour, business_close_hour, business_days, tool_config, event_config,
     escalation_to_number, escalation_from_number, escalation_ring_seconds, note)
  select id, config_version, name, voice_id, greeting, persona, instructions, keyterms,
         business_open_hour, business_close_hour, business_days, tool_config, event_config,
         escalation_to_number, escalation_from_number, escalation_ring_seconds, p_note
    from tenants where id = tenant;

  return next_version;
end
$$;

revoke all on function app.publish_tenant_config(uuid, text, text, text, text, text, text[], integer, integer, integer[], jsonb, jsonb, text, text, integer, text) from public;
grant execute on function app.publish_tenant_config(uuid, text, text, text, text, text, text[], integer, integer, integer[], jsonb, jsonb, text, text, integer, text) to ansa_app;

-- ---------------------------------------------------------------------------
-- The three readers
-- ---------------------------------------------------------------------------

drop function if exists app.tenant_config_at_version(uuid, integer);
create function app.tenant_config_at_version(tenant uuid, v integer)
  returns table (
    id                      uuid,
    name                    text,
    keyterms                text[],
    voice_id                text,
    greeting                text,
    persona                 text,
    instructions            text,
    business_open_hour      integer,
    business_close_hour     integer,
    business_days           integer[],
    tool_config             jsonb,
    event_config            jsonb,
    escalation_to_number    text,
    escalation_from_number  text,
    escalation_ring_seconds integer,
    config_version          integer
  )
  language sql
  stable
as $$
  select p.tenant_id, p.name, p.keyterms, p.voice_id, p.greeting, p.persona,
         p.instructions, p.business_open_hour, p.business_close_hour, p.business_days,
         p.tool_config, p.event_config, p.escalation_to_number, p.escalation_from_number,
         p.escalation_ring_seconds, p.version
    from tenant_prompt_versions p
   where p.tenant_id = tenant and p.version = v
$$;

revoke all on function app.tenant_config_at_version(uuid, integer) from public;
grant execute on function app.tenant_config_at_version(uuid, integer) to ansa_app;

-- Same trust boundary as 0003, 0004, 0005, 0011, 0012, 0013 and 0014: SECURITY DEFINER
-- because RLS cannot answer "which tenant?" when the tenant is the question, keyed on an
-- identifier the caller already holds, and returning one tenant's own row and nothing else.
drop function if exists app.tenant_config_for_number(text);
create function app.tenant_config_for_number(dialled text)
  returns table (
    id                      uuid,
    name                    text,
    keyterms                text[],
    voice_id                text,
    greeting                text,
    persona                 text,
    instructions            text,
    business_open_hour      integer,
    business_close_hour     integer,
    business_days           integer[],
    tool_config             jsonb,
    event_config            jsonb,
    escalation_to_number    text,
    escalation_from_number  text,
    escalation_ring_seconds integer,
    credentials             jsonb,
    config_version          integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select t.id, t.name, t.keyterms, t.voice_id, t.greeting, t.persona, t.instructions,
         t.business_open_hour, t.business_close_hour, t.business_days, t.tool_config,
         t.event_config, t.escalation_to_number, t.escalation_from_number,
         t.escalation_ring_seconds,
         (select jsonb_object_agg(c.ref, c.sealed)
            from tenant_credentials c where c.tenant_id = t.id),
         t.config_version
    from tenants t
   where t.dialled_number = dialled
   limit 1
$$;

revoke all on function app.tenant_config_for_number(text) from public;
grant execute on function app.tenant_config_for_number(text) to ansa_app;

drop function if exists app.tenant_config_for_id(uuid);
create function app.tenant_config_for_id(tenant uuid)
  returns table (
    id                      uuid,
    name                    text,
    keyterms                text[],
    voice_id                text,
    greeting                text,
    persona                 text,
    instructions            text,
    business_open_hour      integer,
    business_close_hour     integer,
    business_days           integer[],
    tool_config             jsonb,
    event_config            jsonb,
    escalation_to_number    text,
    escalation_from_number  text,
    escalation_ring_seconds integer,
    credentials             jsonb,
    config_version          integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select t.id, t.name, t.keyterms, t.voice_id, t.greeting, t.persona, t.instructions,
         t.business_open_hour, t.business_close_hour, t.business_days, t.tool_config,
         t.event_config, t.escalation_to_number, t.escalation_from_number,
         t.escalation_ring_seconds,
         (select jsonb_object_agg(c.ref, c.sealed)
            from tenant_credentials c where c.tenant_id = t.id),
         t.config_version
    from tenants t
   where t.id = tenant
   limit 1
$$;

revoke all on function app.tenant_config_for_id(uuid) from public;
grant execute on function app.tenant_config_for_id(uuid) to ansa_app;
