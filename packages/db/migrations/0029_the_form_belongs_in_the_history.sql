-- The form an agent conducts was missing from config history entirely.
--
-- 0021 put `captured_fields` on `agents` and 0022 put it on the three call-path readers, so
-- a call runs the form correctly. Nothing put it in `agent_prompt_versions`, and
-- `setCapturedFields` wrote the column directly — no version bump, no snapshot. Two
-- consequences, and the second is the one that matters:
--
--   1. Editing the form left `config_version` unchanged, so two calls could record the same
--      version and have collected different things.
--   2. Nothing anywhere recorded what an agent was collecting on a given call. For a
--      feature whose entire job is taking names, policy numbers and dates of birth off
--      callers, "which identifiers was this agent asking for in March" is exactly the
--      question an audit asks, and the answer was gone the moment the form was edited.
--
-- The seed already carries the warning this repeats: bumping a number without snapshotting
-- behind it stores nothing, and makes `calls.config_version` a number that cannot be looked
-- up (R7.5).

alter table agent_prompt_versions
  add column if not exists captured_fields jsonb not null default '[]'::jsonb;

-- Existing rows keep the default. Backfilling them from the agent's current form would be a
-- lie: it would claim every past version collected whatever the agent collects today, which
-- is precisely the confusion this column exists to end. An empty array on a historical row
-- reads as "not recorded", and that is true.

comment on column agent_prompt_versions.captured_fields is
  'The form as published at this version. Empty on rows written before 0029, which means not recorded rather than collected nothing.';

-- The snapshot already selects from the agent row, so this is one more column on each side.
create or replace function app.publish_agent_config(
  organization uuid, p_name text, p_voice_id text, p_greeting text, p_persona text,
  p_instructions text, p_keyterms text[], p_open_hour integer, p_close_hour integer,
  p_business_days integer[], p_tool_config jsonb, p_event_config jsonb,
  p_escalation_to text, p_escalation_from text, p_escalation_ring integer, p_note text
) returns integer
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
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
  -- `app.*_config_*` functions read. `captured_fields` is deliberately not an argument:
  -- the form is edited on its own endpoint, and passing it here would let a publish that
  -- knows nothing about it silently clear one.
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
     keyterms, captured_fields,
     tool_config, event_config,
     escalation_to_number, escalation_from_number, escalation_ring_seconds, note)
  select a.organization_id, a.id, a.config_version, a.name, a.voice_id, a.greeting, a.persona,
         a.instructions, a.keyterms, a.captured_fields,
         p_tool_config, p_event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         p_note
    from agents a where a.id = target_agent;

  return next_version;
end
$function$;

/*
 * Editing the form is a publish, and now goes through one.
 *
 * Its own function rather than an argument on `publish_agent_config`, because the two are
 * reached from different screens and a publish from the Conversation tab must not be able
 * to clear a form it never showed the operator. Same shape as the one above deliberately:
 * scope check, update, bump, snapshot, in one transaction.
 *
 * Takes the agent rather than the organisation. `publish_agent_config` resolves the oldest
 * live agent — wrong, and known — and there was no reason to inherit that here.
 */
create or replace function app.publish_captured_fields(
  agent uuid, p_fields jsonb, p_note text
) returns integer
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  owner uuid;
  next_version integer;
begin
  select a.organization_id into owner
    from agents a
   where a.id = agent and a.archived_at is null;

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
     keyterms, captured_fields,
     tool_config, event_config,
     escalation_to_number, escalation_from_number, escalation_ring_seconds, note)
  select a.organization_id, a.id, a.config_version, a.name, a.voice_id, a.greeting, a.persona,
         a.instructions, a.keyterms, a.captured_fields,
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

grant execute on function app.publish_captured_fields(uuid, jsonb, text) to ansa_app;
