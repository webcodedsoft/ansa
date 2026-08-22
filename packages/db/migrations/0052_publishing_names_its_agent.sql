-- Two things that have to be true before a route may carry an `:agentId`.
--
-- Making `config.*` agent-scoped means taking an agent id out of a request path and handing it
-- to functions that currently receive one only from code that resolved it safely. Every such
-- function has to be re-read as though the id were hostile, because after the cutover it is.
-- 0050 did that for `agent_config_for_id`. Two remain.
--
-- 1. `agent_config_at_version` is SECURITY DEFINER and checks nothing.
--
-- Given an agent id and a version number it returns that agent's published name, greeting,
-- persona, instructions, keyterms and escalation numbers, for any organisation. It is safe
-- today only because the id reaching it was resolved from the caller's own organisation; the
-- version number is already user-supplied. Point a route's `:agentId` at it and it reads
-- across the tenant boundary.
--
-- Fixed by dropping SECURITY DEFINER rather than by adding a check, which is the better repair
-- when it is available. It reads exactly one table, `agent_prompt_versions`, which has
-- row-level security enabled and FORCED, and `ansa_app` holds SELECT on it under an
-- `organization_isolation` policy. As an invoker function it is protected by the mechanism the
-- whole design already leans on, and there is no second copy of the rule to keep in step. It
-- has no in-database caller, so nothing depended on the bypass.
--
-- 2. `publish_agent_config` takes an organisation and works out the agent.
--
-- The last function that does. Everything else the configuration surface uses —
-- `save_agent_draft`, `stage_agent_draft_selection`, `discard_agent_draft`,
-- `apply_agent_behaviour`, `agent_config_at_version` — already takes an agent id, so the
-- controller is the only thing still throwing one away and asking the database to guess.
--
-- The agent-scoped form is added beside the organisation-scoped one rather than replacing it,
-- because the console still publishes through the old route and will until the routes and the
-- screens cut over together. The old form keeps its behaviour exactly: it resolves through
-- `app.live_agent_for_organization`, which since 0047 raises rather than guessing when an
-- organisation has more than one live agent. It delegates instead of repeating the body, so
-- there is one publish and not two that drift.
--
-- Deleting the organisation-scoped form belongs to the commit that removes its last caller.
-- Leaving it is not caution: an unused publish path is exactly the kind of thing that gets
-- called again by accident.

create or replace function app.agent_config_at_version(agent uuid, v integer)
returns table (
  name text, voice_id text, greeting text, persona text, instructions text, keyterms text[],
  escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer,
  version integer
)
language sql
stable
set search_path to 'public', 'pg_temp'
as $fn$
  select p.name, p.voice_id, p.greeting, p.persona, p.instructions, p.keyterms,
         p.escalation_to_number, p.escalation_from_number,
         p.escalation_ring_seconds, p.version
    from agent_prompt_versions p
   where p.agent_id = agent and p.version = v
$fn$;

revoke all on function app.agent_config_at_version(uuid, integer) from public;
grant execute on function app.agent_config_at_version(uuid, integer) to ansa_app;

comment on function app.agent_config_at_version(uuid, integer) is
  'One published version of one agent. SECURITY INVOKER on purpose — it reads only '
  'agent_prompt_versions, whose RLS policy is the organisation check, so an agent id from a '
  'request path cannot reach another organisation''s history. Do not make it DEFINER.';

create or replace function app.publish_agent_config_for_agent(
  p_agent uuid, p_name text, p_voice_id text, p_speaking_rate real, p_greeting text,
  p_persona text, p_instructions text, p_keyterms text[], p_open_hour integer,
  p_close_hour integer, p_business_days integer[], p_tool_config jsonb, p_event_config jsonb,
  p_escalation_to text, p_escalation_from text, p_escalation_ring integer, p_note text,
  p_policy_blocks jsonb DEFAULT NULL
)
returns integer
language plpgsql
set search_path to 'public', 'pg_temp'
as $fn$
declare
  organization  uuid;
  next_version  integer;
begin
  if app.current_organization() is null then
    raise exception
      'publish_agent_config_for_agent needs the organization scope set: select set_config(''app.organization_id'', ...)';
  end if;

  -- Resolved from the row rather than taken as an argument, then checked against the scope. An
  -- organisation parameter alongside an agent parameter is two facts that can disagree, and
  -- the disagreement would be the caller's to get right on every call site.
  select a.organization_id into organization
    from agents a
   where a.id = p_agent and a.deleted_at is null;

  -- Not ours reads as no such agent, matching `GET /agents/:agentId` and
  -- `app.agent_config_for_agent`. A distinct error would confirm the id belongs to somebody,
  -- and the id is the only thing an attacker needs to be handed.
  if organization is null or organization is distinct from app.current_organization() then
    raise exception 'no such agent: %', p_agent
      using errcode = 'no_data_found';
  end if;

  -- Business hours, calling policy and the tool and event registries are the organisation's,
  -- not the agent's. Publishing from one agent's workspace moves them for every agent it runs
  -- — true before this change and unchanged by it, and the console now says so on the Routing
  -- & hours card. Whether they should become per-agent is a product decision.
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
         /* Null leaves them alone; an empty array clears them. See 0046 — the console
            publishes the whole document and has no policy editor. */
         policy_blocks           = coalesce(p_policy_blocks, policy_blocks),
         config_version          = config_version + 1
   where id = p_agent
   returning config_version into next_version;

  if next_version is null then
    raise exception 'no such agent: %', p_agent;
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
    from agents a where a.id = p_agent;

  -- A draft cannot survive its own publication and leave the console reporting unpublished
  -- changes that are already live.
  delete from agent_config_drafts where agent_id = p_agent;

  return next_version;
end;
$fn$;

revoke all on function app.publish_agent_config_for_agent(
  uuid, text, text, real, text, text, text, text[], integer, integer, integer[], jsonb, jsonb,
  text, text, integer, text, jsonb) from public;
grant execute on function app.publish_agent_config_for_agent(
  uuid, text, text, real, text, text, text, text[], integer, integer, integer[], jsonb, jsonb,
  text, text, integer, text, jsonb) to ansa_app;

-- The organisation-scoped form becomes a resolver in front of the agent-scoped one. Same
-- behaviour as before for its existing caller, including the 0047 raise on two live agents,
-- and no second copy of the publish body.
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
as $fn$
declare
  target_agent uuid;
begin
  if app.current_organization() is distinct from organization then
    raise exception
      'publish_agent_config needs the organization scope set: select set_config(''app.organization_id'', ...)';
  end if;

  -- Raises when there is more than one. See 0047.
  target_agent := app.live_agent_for_organization(organization);

  if target_agent is null then
    raise exception 'organization % has no live agent to publish to', organization;
  end if;

  return app.publish_agent_config_for_agent(
    target_agent, p_name, p_voice_id, p_speaking_rate, p_greeting, p_persona, p_instructions,
    p_keyterms, p_open_hour, p_close_hour, p_business_days, p_tool_config, p_event_config,
    p_escalation_to, p_escalation_from, p_escalation_ring, p_note, p_policy_blocks);
end;
$fn$;
