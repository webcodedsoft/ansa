-- Speaking rate joins the published configuration, so one button saves the voice and its pace.
--
-- 0035 put it on `agents` and left it to `PATCH`, beside `barge_in`. Two things were wrong
-- with that. On screen it meant the Voice tab had a "save rate" button and no way to save the
-- voice beside it, because the voice is published — one panel, two save paths, and the more
-- obvious one saved the thing nobody came to change.
--
-- The other is the reason to move it rather than add a second button: a rate set by `PATCH`
-- never reaches `agent_prompt_versions`, so "what did this call sound like" could not be
-- answered from the version the call recorded. Which voice answered was versioned and how
-- fast it read was not, which is half an answer. 0029 closed exactly this gap for captured
-- fields.
--
-- `PATCH /agents/{id}` still accepts it, the way it still accepts `voiceId`. What changed is
-- that publishing now carries it, and the console publishes.

alter table agent_prompt_versions
  add column if not exists speaking_rate real;

comment on column agent_prompt_versions.speaking_rate is
  'The rate as published at this version. Null means the voice''s own pace — see 0035.';

CREATE OR REPLACE FUNCTION app.publish_agent_config(organization uuid, p_name text, p_voice_id text, p_speaking_rate real, p_greeting text, p_persona text, p_instructions text, p_keyterms text[], p_open_hour integer, p_close_hour integer, p_business_days integer[], p_tool_config jsonb, p_event_config jsonb, p_escalation_to text, p_escalation_from text, p_escalation_ring integer, p_note text)
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
      'publish_agent_config needs the organization scope set: select set_config(''app.organization_id'', ...)';
  end if;

  select a.id into target_agent
    from agents a
   where a.organization_id = organization and a.deleted_at is null
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
  -- `app.*_config_*` functions read. `captured_fields` is deliberately not an argument:
  -- the form is edited on its own endpoint, and passing it here would let a publish that
  -- knows nothing about it silently clear one.
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
     keyterms, captured_fields, speaking_rate,
     tool_config, event_config,
     escalation_to_number, escalation_from_number, escalation_ring_seconds, note)
  select a.organization_id, a.id, a.config_version, a.name, a.voice_id, a.greeting, a.persona,
         a.instructions, a.keyterms, a.captured_fields, a.speaking_rate,
         p_tool_config, p_event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         p_note
    from agents a where a.id = target_agent;

  return next_version;
end
$function$;

CREATE OR REPLACE FUNCTION app.publish_captured_fields(agent uuid, p_fields jsonb, p_note text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  owner uuid;
  next_version integer;
begin
  select a.organization_id into owner
    from agents a
   where a.id = agent and a.deleted_at is null;

  -- Null covers three cases that must not be told apart to the caller: no such agent, an
  -- archived one, and one belonging to another organisation that RLS has already hidden.
  -- The API turns this into a 404, which is the honest answer to all three.
  if owner is null then
    return null;
  end if;

  if app.current_organization() is distinct from owner then
    raise exception
      'publish_captured_fields needs the organization scope set: select set_config(''app.organization_id'', ...)';
  end if;

  update agents
     set captured_fields = p_fields,
         config_version  = config_version + 1
   where id = agent
   returning config_version into next_version;

  insert into agent_prompt_versions
    (organization_id, agent_id, version, name, voice_id, greeting, persona, instructions,
     keyterms, captured_fields, speaking_rate,
     tool_config, event_config,
     escalation_to_number, escalation_from_number, escalation_ring_seconds, note)
  select a.organization_id, a.id, a.config_version, a.name, a.voice_id, a.greeting, a.persona,
         a.instructions, a.keyterms, a.captured_fields, a.speaking_rate,
         -- From the organisation, not from an argument: this endpoint does not edit the
         -- tool registry, and a snapshot that recorded null would claim it had been cleared.
         o.tool_config, o.event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         p_note
    from agents a join organizations o on o.id = a.organization_id
   where a.id = agent;

  return next_version;
end
$function$;
