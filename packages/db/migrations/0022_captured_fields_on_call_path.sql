-- The form reaches the call, not just the console.
--
-- Migration 0021 gave `agents.captured_fields` somewhere to live and the console somewhere
-- to save it. Nothing on the answer path could see it, so an agent with a carefully
-- designed voice form conducted none of it — the definitions were real and inert.
--
-- This adds the column to the three config functions, which is the whole of what the call
-- path needs: it already reads all of an agent's configuration in one round trip at
-- ingress, and one more jsonb column on a query that was happening anyway costs nothing
-- measurable against the 800ms answer budget.

drop function if exists app.tenant_config_for_number(text);
create function app.tenant_config_for_number(dialled text)
  returns table (
    id                      uuid,
    agent_id                uuid,
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
    enabled_tools           text[],
    event_config            jsonb,
    escalation_to_number    text,
    escalation_from_number  text,
    escalation_ring_seconds integer,
    credentials             jsonb,
    config_version          integer,
    barge_in                boolean,
    amd_enabled             boolean,
    captured_fields         jsonb
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select t.id, a.id, a.name, a.keyterms, a.voice_id, a.greeting, a.persona, a.instructions,
         a.business_open_hour, a.business_close_hour, a.business_days,
         t.tool_config,
         (select coalesce(array_agg(at.tool_name), '{}')
            from agent_tools at where at.agent_id = a.id),
         t.event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         (select jsonb_object_agg(c.ref, c.sealed)
            from tenant_credentials c where c.tenant_id = t.id),
         a.config_version, a.barge_in, a.answering_machine_detection,
         a.captured_fields
    from agents a
    join tenants t on t.id = a.tenant_id
   -- An archived agent does not answer. Its number should have been released first, but
   -- a number left behind must ring nobody rather than ring a retired script.
   where a.dialled_number = dialled and a.archived_at is null
   limit 1
$$;

revoke all on function app.tenant_config_for_number(text) from public;
grant execute on function app.tenant_config_for_number(text) to ansa_app;

drop function if exists app.agent_config_for_id(uuid);
create function app.agent_config_for_id(agent uuid)
  returns table (
    id                      uuid,
    agent_id                uuid,
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
    enabled_tools           text[],
    event_config            jsonb,
    escalation_to_number    text,
    escalation_from_number  text,
    escalation_ring_seconds integer,
    credentials             jsonb,
    config_version          integer,
    barge_in                boolean,
    amd_enabled             boolean,
    captured_fields         jsonb
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select t.id, a.id, a.name, a.keyterms, a.voice_id, a.greeting, a.persona, a.instructions,
         a.business_open_hour, a.business_close_hour, a.business_days,
         t.tool_config,
         (select coalesce(array_agg(at.tool_name), '{}')
            from agent_tools at where at.agent_id = a.id),
         t.event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         (select jsonb_object_agg(c.ref, c.sealed)
            from tenant_credentials c where c.tenant_id = t.id),
         a.config_version, a.barge_in, a.answering_machine_detection,
         a.captured_fields
    from agents a
    join tenants t on t.id = a.tenant_id
   where a.id = agent
   limit 1
$$;

revoke all on function app.agent_config_for_id(uuid) from public;
grant execute on function app.agent_config_for_id(uuid) to ansa_app;

drop function if exists app.tenant_config_for_id(uuid);
create function app.tenant_config_for_id(tenant uuid)
  returns table (
    id                      uuid,
    agent_id                uuid,
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
    enabled_tools           text[],
    event_config            jsonb,
    escalation_to_number    text,
    escalation_from_number  text,
    escalation_ring_seconds integer,
    credentials             jsonb,
    config_version          integer,
    barge_in                boolean,
    amd_enabled             boolean,
    captured_fields         jsonb
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select * from app.agent_config_for_id((
    select a.id from agents a
     where a.tenant_id = tenant and a.archived_at is null
     order by a.created_at, a.id
     limit 1
  ))
$$;

revoke all on function app.tenant_config_for_id(uuid) from public;
grant execute on function app.tenant_config_for_id(uuid) to ansa_app;
