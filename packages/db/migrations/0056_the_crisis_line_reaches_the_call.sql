-- The crisis line reaches the call.
--
-- Appended to the end of each RETURNS TABLE rather than beside `escalation_to_number` where
-- it belongs logically. These are positional: inserting a column in the middle silently
-- reassigns every one after it, which is the note migration 0046 left about `policy_blocks`.
--
-- Dropped and recreated rather than replaced, because Postgres refuses to change the return
-- type of an existing function. That makes the grants this migration's problem: they are
-- restored below exactly as they were, and `agent_config_for_id` deliberately keeps none —
-- migration 0050 revoked ansa_app's EXECUTE on it so that an agent id from a request path
-- cannot read another organisation's configuration, and recreating it grantable would undo
-- that silently.
--
-- Dropped children first. `agent_config_for_organization` delegates to `agent_config_for_id`
-- with `select *`, so the two must widen together or the row shapes disagree.
--
-- `agent_config_at_version` is left alone: it describes a configuration somebody published,
-- and where a distressed caller is sent is a property of the organisation, not of a version.

drop function if exists app.agent_config_for_organization(uuid);
drop function if exists app.agent_config_for_number(text);
drop function if exists app.agent_config_for_agent(uuid);
drop function if exists app.agent_config_for_id(uuid);

CREATE FUNCTION app.agent_config_for_id(agent uuid)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, speaking_rate real, amd_enabled boolean, captured_fields jsonb, policy_blocks jsonb, crisis_handoff_number text)
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
         a.policy_blocks,
         t.crisis_handoff_number
    from agents a
    join organizations t on t.id = a.organization_id
   where a.id = agent
   limit 1
$function$;

CREATE FUNCTION app.agent_config_for_number(dialled text)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, speaking_rate real, amd_enabled boolean, captured_fields jsonb, policy_blocks jsonb, crisis_handoff_number text)
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
         a.policy_blocks,
         t.crisis_handoff_number
    from agents a
    join organizations t on t.id = a.organization_id
   -- An archived agent does not answer. Its number should have been released first, but
   -- a number left behind must ring nobody rather than ring a retired script.
   where a.dialled_number = dialled and a.deleted_at is null
   limit 1
$function$;

CREATE FUNCTION app.agent_config_for_organization(organization uuid)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, speaking_rate real, amd_enabled boolean, captured_fields jsonb, policy_blocks jsonb, crisis_handoff_number text)
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

CREATE FUNCTION app.agent_config_for_agent(agent uuid)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, speaking_rate real, amd_enabled boolean, captured_fields jsonb, policy_blocks jsonb, crisis_handoff_number text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  owner_organization uuid;
begin
  if app.current_organization() is null then
    raise exception
      'agent_config_for_agent needs the organization scope set: select set_config(''app.organization_id'', ...)';
  end if;

  select a.organization_id into owner_organization
    from agents a where a.id = agent;

  -- Not ours reads exactly as does not exist, which is the same answer RLS would give and the
  -- same one `GET /agents/:agentId` gives. Distinguishing them would confirm that an id
  -- belongs to somebody, and the id is the only thing an attacker needs to be told.
  if owner_organization is null or owner_organization is distinct from app.current_organization() then
    return;
  end if;

  return query select * from app.agent_config_for_id(agent);
end;
$function$;

-- Exactly the grants that were there before. `agent_config_for_id` gets none, on purpose.
grant execute on function app.agent_config_for_agent(uuid) to ansa_app;
