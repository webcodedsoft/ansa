-- How fast the agent speaks, per agent.
--
-- Beside `barge_in` and `answering_machine_detection` rather than in the publish path, which
-- is where the closest precedent sits: those are per-agent behaviour set through `PATCH
-- /agents/{id}`, and this is the same kind of thing. Voice *identity* is published and
-- versioned; the pace it is read at is a dial somebody turns while listening.
--
-- Null means the voice's own pace, and that is the default on purpose. A rate stored for
-- every agent would mean every agent carrying an opinion about something almost nobody has
-- one about, and a migration that had to invent a number for existing rows.
--
-- Bounded 0.7 to 1.2 because that is the range ElevenLabs synthesises without artefacts.
-- Outside it the voice does not merely sound fast, it sounds broken — and on an 8 kHz line
-- a caller has less signal to work with than the operator auditioning it had.

alter table agents
  add column if not exists speaking_rate real
    check (speaking_rate is null or (speaking_rate >= 0.7 and speaking_rate <= 1.2));

comment on column agents.speaking_rate is
  'Null means the voice''s own pace. 0.7 to 1.2, the range ElevenLabs renders cleanly.';

-- The three call-path readers, regenerated from what is deployed rather than retyped.
drop function if exists app.agent_config_for_id(agent uuid);
CREATE OR REPLACE FUNCTION app.agent_config_for_id(agent uuid)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, speaking_rate real, amd_enabled boolean, captured_fields jsonb)
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
         a.captured_fields
    from agents a
    join organizations t on t.id = a.organization_id
   where a.id = agent
   limit 1
$function$;

drop function if exists app.agent_config_for_number(dialled text);
CREATE OR REPLACE FUNCTION app.agent_config_for_number(dialled text)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, speaking_rate real, amd_enabled boolean, captured_fields jsonb)
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
         a.captured_fields
    from agents a
    join organizations t on t.id = a.organization_id
   -- An archived agent does not answer. Its number should have been released first, but
   -- a number left behind must ring nobody rather than ring a retired script.
   where a.dialled_number = dialled and a.deleted_at is null
   limit 1
$function$;

drop function if exists app.agent_config_for_organization(organization uuid);
CREATE OR REPLACE FUNCTION app.agent_config_for_organization(organization uuid)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, speaking_rate real, amd_enabled boolean, captured_fields jsonb)
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
