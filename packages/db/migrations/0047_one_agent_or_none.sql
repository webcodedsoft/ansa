-- `config.*` guesses which agent it means, and the guess is silent.
--
-- That surface has no agent in its route. It resolves one in the database — the oldest live
-- agent — and `publish_agent_config` repeats the same `order by created_at, id limit 1`
-- independently. With one agent per organisation, which is every organisation today, that is
-- correct and nobody notices. With two it is a coin toss that never says it flipped: an
-- operator edits the agent they have open, publishes, and the configuration lands on the
-- other one. Nothing errors, the version bumps, and the call that goes wrong afterwards is
-- on an agent nobody was editing.
--
-- `POST /agents` exists, so a second agent is one request away. TASKS.md has called this the
-- blocker on creating one through the console for several slices.
--
-- Making the surface agent-scoped is the real fix and it is a large one: the routes, these
-- functions, and the console screens that call them. This is the smaller half, and the half
-- worth having first — refuse rather than guess. An organisation with two live agents now
-- gets an error naming the problem instead of a publish that quietly went elsewhere. What
-- the agent-scoped routes will eventually do is still to be done; what changes here is that
-- the gap fails loudly while it waits.
--
-- Breaks nothing that currently works: no organisation in this database has more than one
-- live agent, so the raise is unreachable until somebody deliberately creates a second — at
-- which point being stopped is the point.

create or replace function app.live_agent_for_organization(organization uuid)
returns uuid
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  live integer;
begin
  select count(*) into live
    from agents a
   where a.organization_id = organization and a.deleted_at is null;

  if live > 1 then
    raise exception
      'organization % has % live agents, so there is no single agent this route can mean — use the agent-scoped configuration routes',
      organization, live
      using errcode = 'cardinality_violation';
  end if;

  return (
    select a.id
      from agents a
     where a.organization_id = organization and a.deleted_at is null
     order by a.created_at, a.id
     limit 1
  );
end;
$fn$;

-- The publish path resolved the agent itself rather than calling the function above, so the
-- guard would otherwise hold on the draft routes and not on publish. It calls it now rather
-- than repeating the count: two copies of "which agent does this mean" is the shape of the
-- bug, not the fix.
create or replace function app.publish_agent_config(
  organization uuid, p_name text, p_voice_id text, p_speaking_rate real, p_greeting text,
  p_persona text, p_instructions text, p_keyterms text[], p_open_hour integer,
  p_close_hour integer, p_business_days integer[], p_tool_config jsonb, p_event_config jsonb,
  p_escalation_to text, p_escalation_from text, p_escalation_ring integer, p_note text,
  p_policy_blocks jsonb DEFAULT NULL
)
returns integer
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  target_agent uuid;
  next_version integer;
begin
  if app.current_organization() is distinct from organization then
    raise exception
      'publish_agent_config needs the organization scope set: select set_config(''app.organization_id'', ...)';
  end if;

  -- Raises when there is more than one, which is the whole of this migration.
  target_agent := app.live_agent_for_organization(organization);

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
         /* Null leaves them alone; an empty array clears them. See migration 0046 — the
            console publishes the whole document and has no policy editor. */
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

  -- A draft cannot survive its own publication and leave the console reporting unpublished
  -- changes that are already live.
  delete from agent_config_drafts where agent_id = target_agent;

  return next_version;
end
$function$;
