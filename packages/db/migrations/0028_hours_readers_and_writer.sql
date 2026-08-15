-- The functions follow the columns.
--
-- Migration 0027 moved opening hours to `organizations`; these are the readers and the
-- writer, recreated from their live definitions so none was retyped. The three config
-- functions already joined `organizations` for the shared columns, so this is one more
-- column in a join that was happening anyway — the answer path still costs one round trip.
--
-- `agent_config_at_version` loses the hours entirely rather than reading the current ones:
-- a version snapshot exists to say what the agent was working from, and answering with
-- today's opening hours would be a lie dressed as history.

DROP FUNCTION IF EXISTS app.agent_config_at_version(uuid, integer);
CREATE FUNCTION app.agent_config_at_version(agent uuid, v integer)
 RETURNS TABLE(name text, voice_id text, greeting text, persona text, instructions text, keyterms text[], escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, version integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select p.name, p.voice_id, p.greeting, p.persona, p.instructions, p.keyterms,
                  p.escalation_to_number, p.escalation_from_number,
         p.escalation_ring_seconds, p.version
    from agent_prompt_versions p
   where p.agent_id = agent and p.version = v
$function$;

CREATE OR REPLACE FUNCTION app.agent_config_for_id(agent uuid)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, amd_enabled boolean, captured_fields jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select t.id, a.id, a.name, a.keyterms, a.voice_id, a.greeting, a.persona, a.instructions,
         t.business_open_hour, t.business_close_hour, t.business_days,
         t.tool_config,
         (select coalesce(array_agg(at.tool_name), '{}')
            from agent_tools at where at.agent_id = a.id),
         t.event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         (select jsonb_object_agg(c.ref, c.sealed)
            from organization_credentials c where c.organization_id = t.id),
         a.config_version, a.barge_in, a.answering_machine_detection,
         a.captured_fields
    from agents a
    join organizations t on t.id = a.organization_id
   where a.id = agent
   limit 1
$function$;

CREATE OR REPLACE FUNCTION app.agent_config_for_number(dialled text)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, amd_enabled boolean, captured_fields jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select t.id, a.id, a.name, a.keyterms, a.voice_id, a.greeting, a.persona, a.instructions,
         t.business_open_hour, t.business_close_hour, t.business_days,
         t.tool_config,
         (select coalesce(array_agg(at.tool_name), '{}')
            from agent_tools at where at.agent_id = a.id),
         t.event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         (select jsonb_object_agg(c.ref, c.sealed)
            from organization_credentials c where c.organization_id = t.id),
         a.config_version, a.barge_in, a.answering_machine_detection,
         a.captured_fields
    from agents a
    join organizations t on t.id = a.organization_id
   -- An archived agent does not answer. Its number should have been released first, but
   -- a number left behind must ring nobody rather than ring a retired script.
   where a.dialled_number = dialled and a.archived_at is null
   limit 1
$function$;

CREATE OR REPLACE FUNCTION app.agent_config_for_organization(organization uuid)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, amd_enabled boolean, captured_fields jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select * from app.agent_config_for_id((
    select a.id from agents a
     where a.organization_id = organization and a.archived_at is null
     order by a.created_at, a.id
     limit 1
  ))
$function$;

CREATE OR REPLACE FUNCTION app.publish_agent_config(organization uuid, p_name text, p_voice_id text, p_greeting text, p_persona text, p_instructions text, p_keyterms text[], p_open_hour integer, p_close_hour integer, p_business_days integer[], p_tool_config jsonb, p_event_config jsonb, p_escalation_to text, p_escalation_from text, p_escalation_ring integer, p_note text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  target_agent uuid;
  next_version integer;
begin
  -- Unchanged, and load-bearing: this is SECURITY INVOKER, so RLS is what stops one
  -- organisation publishing into another's configuration. The check turns a silently
  -- zero-row update into a loud failure when the scope was never set.
  if app.current_organization() is distinct from organization then
    raise exception
      'publish_tenant_config needs the organization scope set: select set_config(''app.organization_id'', ...)';
  end if;

  select a.id into target_agent
    from agents a
   where a.organization_id = organization and a.archived_at is null
   order by a.created_at, a.id
   limit 1;

  if target_agent is null then
    -- An organisation with no live agent has nothing to publish to. Before 0018 this could
    -- not happen, because the organization was the agent.
    raise exception 'organization % has no live agent to publish to', organization;
  end if;

  -- The organisation's own columns stay on `organizations`: the tool registry and the webhook
  -- subscriptions are shared across its agents, and 0018 left them there deliberately.
  update organizations
     set tool_config         = p_tool_config,
         event_config        = p_event_config,
         business_open_hour  = p_open_hour,
         business_close_hour = p_close_hour,
         business_days       = p_business_days
   where id = organization;

  -- Everything a caller experiences lives on the agent, which is what the three
  -- `app.*_config_*` functions read.
  update agents
     set name                    = coalesce(p_name, name),
         voice_id                = p_voice_id,
         greeting                = p_greeting,
         persona                 = p_persona,
         instructions            = p_instructions,
         keyterms                = coalesce(p_keyterms, '{}'),
         escalation_to_number    = p_escalation_to,
         escalation_from_number  = p_escalation_from,
         escalation_ring_seconds = p_escalation_ring,
         config_version          = config_version + 1
   where id = target_agent
   returning config_version into next_version;

  if next_version is null then
    raise exception 'no such agent: %', target_agent;
  end if;

  -- The history row, now keyed by the agent as well as the organization. `organization_id` stays
  -- because every policy on the table filters on it, and a policy that has to join to find
  -- its organization is a policy that gets dropped in a hurry.
  insert into agent_prompt_versions
    (organization_id, agent_id, version, name, voice_id, greeting, persona, instructions,
     keyterms,
     tool_config, event_config,
     escalation_to_number, escalation_from_number, escalation_ring_seconds, note)
  select a.organization_id, a.id, a.config_version, a.name, a.voice_id, a.greeting, a.persona,
         a.instructions, a.keyterms,
         p_tool_config, p_event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         p_note
    from agents a where a.id = target_agent;

  return next_version;
end
$function$;
