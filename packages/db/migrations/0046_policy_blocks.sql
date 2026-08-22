-- Business policies as named blocks, rather than a run of prose.
--
-- An organisation's rules arrive today as `instructions`: bounded free text, fenced into
-- the prompt, with 8g's limit stated after the fence so the model cannot generalise past
-- what they wrote. That limit is the half that changes what a caller hears. This is the
-- other half — giving the rules a shape, so the model can find the one that applies
-- instead of re-reading a paragraph every turn and picking whichever clause is nearest.
--
-- Stored as jsonb on the agent and snapshotted into `agent_prompt_versions`, because R7.5
-- requires a call to be attributable to the configuration in force when it was placed. A
-- policy field that published but never versioned would make the history say the agent had
-- always had whatever it has now.
--
-- The publish parameter goes last and defaults to null. Every existing caller passes its
-- arguments positionally, so appending is the only change that does not silently reassign
-- somebody else's value to a new field — and a deployment that never publishes one keeps
-- the behaviour it has.
--
-- The readers are dropped and recreated rather than replaced: widening `RETURNS TABLE` is
-- not something `create or replace` will do. They are otherwise unchanged, generated from
-- the live definitions rather than retyped, so nothing else about them can drift here.

alter table agents               add column if not exists policy_blocks jsonb;
alter table agent_prompt_versions add column if not exists policy_blocks jsonb;

drop function if exists app.agent_config_for_organization(uuid);
drop function if exists app.agent_config_for_number(text);
drop function if exists app.agent_config_for_id(uuid);

CREATE OR REPLACE FUNCTION app.agent_config_for_id(agent uuid)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, speaking_rate real, amd_enabled boolean, captured_fields jsonb, policy_blocks jsonb)
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
         a.config_version, a.barge_in, a.speaking_rate, a.answering_machine_detection,
         a.captured_fields,
         a.policy_blocks
    from agents a
    join organizations t on t.id = a.organization_id
   where a.id = agent
   limit 1
$function$;

CREATE OR REPLACE FUNCTION app.agent_config_for_number(dialled text)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, speaking_rate real, amd_enabled boolean, captured_fields jsonb, policy_blocks jsonb)
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
         a.config_version, a.barge_in, a.speaking_rate, a.answering_machine_detection,
         a.captured_fields,
         a.policy_blocks
    from agents a
    join organizations t on t.id = a.organization_id
   -- An archived agent does not answer. Its number should have been released first, but
   -- a number left behind must ring nobody rather than ring a retired script.
   where a.dialled_number = dialled and a.deleted_at is null
   limit 1
$function$;

CREATE OR REPLACE FUNCTION app.agent_config_for_organization(organization uuid)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, speaking_rate real, amd_enabled boolean, captured_fields jsonb, policy_blocks jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select * from app.agent_config_for_id((
    select a.id from agents a
     where a.organization_id = organization and a.deleted_at is null
     order by a.created_at, a.id
     limit 1
  ))
$function$;

-- Replaced rather than added to: the old seventeen-argument form must not linger as an
-- overload, or a caller that forgets the new argument resolves to it and publishes a
-- configuration with the policies silently dropped.
drop function if exists app.publish_agent_config(uuid, text, text, real, text, text, text, text[], integer, integer, integer[], jsonb, jsonb, text, text, integer, text);

CREATE OR REPLACE FUNCTION app.publish_agent_config(organization uuid, p_name text, p_voice_id text, p_speaking_rate real, p_greeting text, p_persona text, p_instructions text, p_keyterms text[], p_open_hour integer, p_close_hour integer, p_business_days integer[], p_tool_config jsonb, p_event_config jsonb, p_escalation_to text, p_escalation_from text, p_escalation_ring integer, p_note text, p_policy_blocks jsonb DEFAULT NULL)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  target_agent uuid;
  next_version integer;
begin
  if app.current_organization() is distinct from organization then
    raise exception
      'publish_agent_config needs the organization scope set: select set_config(''app.organization_id'', ...)';
  end if;

  select a.id into target_agent
    from agents a
   where a.organization_id = organization and a.deleted_at is null
   order by a.created_at, a.id
   limit 1;

  if target_agent is null then
    raise exception 'organization % has no live agent to publish to', organization;
  end if;

  update organizations
     set tool_config         = p_tool_config,
         event_config        = p_event_config,
         business_open_hour  = p_open_hour,
         business_close_hour = p_close_hour,
         business_days       = p_business_days
   where id = organization;

  update agents
     set name                    = coalesce(p_name, name),
         voice_id                = p_voice_id,
         speaking_rate           = p_speaking_rate,
         greeting                = p_greeting,
         persona                 = p_persona,
         instructions            = p_instructions,
         keyterms                = coalesce(p_keyterms, '{}'),
         escalation_to_number    = p_escalation_to,
         escalation_from_number  = p_escalation_from,
         escalation_ring_seconds = p_escalation_ring,
         /* Null leaves them alone; an empty array clears them. The same distinction
            `agent_config_drafts` already draws, and here it is load-bearing rather than
            tidy: the console publishes the whole document and has no policy editor, so a
            null that overwrote would have the first save from a screen that cannot show
            policies silently delete them. */
         policy_blocks           = coalesce(p_policy_blocks, policy_blocks),
         config_version          = config_version + 1
   where id = target_agent
   returning config_version into next_version;

  if next_version is null then
    raise exception 'no such agent: %', target_agent;
  end if;

  insert into agent_prompt_versions
    (organization_id, agent_id, version, name, voice_id, greeting, persona, instructions,
     keyterms, captured_fields, speaking_rate,
     tool_config, event_config,
     escalation_to_number, escalation_from_number, escalation_ring_seconds, note,
     policy_blocks)
  select a.organization_id, a.id, a.config_version, a.name, a.voice_id, a.greeting, a.persona,
         a.instructions, a.keyterms, a.captured_fields, a.speaking_rate,
         p_tool_config, p_event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         p_note,
         a.policy_blocks
    from agents a where a.id = target_agent;

  -- The new statement. Unconditional, because there is usually no draft: a publish can come
  -- from a script or from `tools/organization/config.mjs`, neither of which saves one, and
  -- deleting nothing is not a failure. What matters is that a draft cannot survive its own
  -- publication and leave the console reporting unpublished changes that are already live.
  delete from agent_config_drafts where agent_id = target_agent;

  return next_version;
end
$function$;
