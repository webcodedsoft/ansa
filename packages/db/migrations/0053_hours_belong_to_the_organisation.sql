-- Publishing an agent rewrites the organisation's opening hours. It should not.
--
-- `business_open_hour`, `business_close_hour` and `business_days` are columns on
-- `organizations`. They are read by `agent_config_for_number` on every call, they are the same
-- for every agent an organisation runs, and they are not part of an agent's script. Yet the
-- only way to change them is to publish an agent, and a publish rewrites all three from
-- whatever the agent workspace last rendered.
--
-- With one agent that is invisible. With two it is a live bug in the same family as the ones
-- 0047 and 0052 closed: publish agent B and agent A's callers get B's opening hours, with no
-- version recording it and nothing on screen suggesting it happened.
--
-- The objection to moving them was that it would stop hours being versioned. That objection
-- was wrong, and checking it is what settled the design. `CONFIG_COLUMNS` in
-- `organization-config.ts` — the list `agent_prompt_versions` snapshots — has never included
-- them, and the table has no `business_*` columns at all. So hours have never been in a
-- version, never appeared in a diff, and have never been restorable by a rollback. They ride
-- through the publish body and nowhere else. Removing them from it loses nothing that exists.
--
-- So the publish functions stop taking hours and stop writing them. Nothing replaces the write
-- inside the database, because nothing needs to: `organizations` is writable by `ansa_app`
-- under RLS, so the organisation endpoint sets the three columns directly, the way
-- `renameOrganization` already sets the name. A `set_organization_hours` wrapper would be
-- SECURITY DEFINER around something RLS already answers correctly, which is how the holes 0050
-- closed came to exist.
--
-- Both signatures change rather than keeping the arguments and ignoring them. A parameter a
-- function accepts and discards is worse than one it does not have: every caller keeps passing
-- it, and the next person to read the call site believes it does something. All three callers
-- move in this commit — the TypeScript binding, the dev seed and `tools/organization/config.mjs`.

drop function if exists app.publish_agent_config(
  uuid, text, text, real, text, text, text, text[], integer, integer, integer[], jsonb, jsonb,
  text, text, integer, text, jsonb);

drop function if exists app.publish_agent_config_for_agent(
  uuid, text, text, real, text, text, text, text[], integer, integer, integer[], jsonb, jsonb,
  text, text, integer, text, jsonb);

create or replace function app.publish_agent_config_for_agent(
  p_agent uuid, p_name text, p_voice_id text, p_speaking_rate real, p_greeting text,
  p_persona text, p_instructions text, p_keyterms text[], p_tool_config jsonb,
  p_event_config jsonb, p_escalation_to text, p_escalation_from text, p_escalation_ring integer,
  p_note text, p_policy_blocks jsonb DEFAULT NULL
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

  select a.organization_id into organization
    from agents a
   where a.id = p_agent and a.deleted_at is null;

  -- Not ours reads as no such agent, matching `GET /agents/:agentId`. A distinct error would
  -- confirm the id belongs to somebody.
  if organization is null or organization is distinct from app.current_organization() then
    raise exception 'no such agent: %', p_agent
      using errcode = 'no_data_found';
  end if;

  -- The tool and event registries are still the organisation's and still travel with a
  -- publish, because they are genuinely part of what an agent does on a call and the endpoints
  -- that edit them publish a version to record the change. Hours are not: nothing about them
  -- is an agent's, and no version has ever recorded one.
  update organizations
     set tool_config  = p_tool_config,
         event_config = p_event_config
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
         /* Null leaves them alone; an empty array clears them. See 0046. */
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
  uuid, text, text, real, text, text, text, text[], jsonb, jsonb, text, text, integer, text,
  jsonb) from public;
grant execute on function app.publish_agent_config_for_agent(
  uuid, text, text, real, text, text, text, text[], jsonb, jsonb, text, text, integer, text,
  jsonb) to ansa_app;

-- The organisation-scoped resolver, unchanged in purpose: it picks the single live agent and
-- delegates. `live_agent_for_organization` raises on two rather than guessing (0047).
create or replace function app.publish_agent_config(
  organization uuid, p_name text, p_voice_id text, p_speaking_rate real, p_greeting text,
  p_persona text, p_instructions text, p_keyterms text[], p_tool_config jsonb,
  p_event_config jsonb, p_escalation_to text, p_escalation_from text, p_escalation_ring integer,
  p_note text, p_policy_blocks jsonb DEFAULT NULL
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

  target_agent := app.live_agent_for_organization(organization);

  if target_agent is null then
    raise exception 'organization % has no live agent to publish to', organization;
  end if;

  return app.publish_agent_config_for_agent(
    target_agent, p_name, p_voice_id, p_speaking_rate, p_greeting, p_persona, p_instructions,
    p_keyterms, p_tool_config, p_event_config, p_escalation_to, p_escalation_from,
    p_escalation_ring, p_note, p_policy_blocks);
end;
$fn$;

comment on column organizations.business_open_hour is
  'When this organisation counts as open, shared by every agent it runs. Set through the '
  'organisation endpoint, not through a publish — an agent''s configuration version has never '
  'recorded hours and cannot restore them, so writing them from a publish only ever meant one '
  'agent''s form silently moving every other agent''s opening times.';
