-- Two behaviours an organisation can actually choose, stored per agent.
--
-- The Conversation tab drew three switches and none of them was connected to anything.
-- Two of them become real here; the third deliberately does not, and the difference is
-- the point of this migration.
--
--   barge_in                     the caller can cut the agent off mid-sentence. On by
--                                default because that is how a person expects a phone
--                                call to work, and off is for the rare line that must
--                                finish a legal disclosure before it stops talking.
--
--   answering_machine_detection  an outbound call that reaches voicemail hangs up
--                                instead of talking to a greeting. Off by default
--                                because it costs a carrier feature and a second of
--                                answer latency, and inbound agents never need it.
--
-- What is NOT here is "transfer to a human on escalation". An irreversible tool transfers
-- instead of executing, and that is enforced in the dispatch path exactly so that neither
-- a setting nor a prompt can talk it out of it — see CLAUDE.md on risk tiers. A column
-- here would be a switch for turning off a safety rail, and the honest interface for
-- something that cannot be changed is one that does not offer to change it.

alter table agents add column if not exists barge_in boolean not null default true;
alter table agents add column if not exists answering_machine_detection boolean not null default false;

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
    amd_enabled             boolean
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
         a.config_version, a.barge_in, a.answering_machine_detection
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
    amd_enabled             boolean
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
         a.config_version, a.barge_in, a.answering_machine_detection
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
    amd_enabled             boolean
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
