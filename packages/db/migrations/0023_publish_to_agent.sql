-- Publishing writes where calls read.
--
-- Migration 0018 moved the agent-shaped columns from `tenants` to `agents` and re-pointed
-- every read at the new home. It did not move the write. `app.publish_tenant_config` kept
-- updating `tenants`, so from 0018 onwards publishing a greeting changed a row nothing on
-- the answer path reads: the console would report a new version and the caller would hear
-- the old script.
--
-- It never got that far, because 0018 also made `tenant_prompt_versions.agent_id` NOT NULL
-- and the version insert never set it. Every publish since has failed on a not-null
-- violation. That is the only reason this was found, and it is worth writing down: the
-- broken half was loud, the dangerous half was silent, and the silent half is the one that
-- would have survived if the insert had happened to succeed.
--
-- The lesson for the next migration that moves a column: grep for the writers, not only
-- the readers. A read path left behind is an error somewhere; a write path left behind is
-- a screen that lies.
--
-- Which agent? The tenant's oldest live one, matching `app.tenant_config_for_id` exactly.
-- Right while an organisation has one agent and a coin toss the moment it has two, which
-- is precisely why the console still has no create form — see TASKS.md. Making `config.*`
-- agent-scoped is the next change; this restores what 0018 broke without widening the API
-- surface in the same step.

drop function if exists app.publish_tenant_config(uuid, text, text, text, text, text, text[], integer, integer, integer[], jsonb, jsonb, text, text, integer, text);

create function app.publish_tenant_config(
  tenant            uuid,
  p_name            text,
  p_voice_id        text,
  p_greeting        text,
  p_persona         text,
  p_instructions    text,
  p_keyterms        text[],
  p_open_hour       integer,
  p_close_hour      integer,
  p_business_days   integer[],
  p_tool_config     jsonb,
  p_event_config    jsonb,
  p_escalation_to   text,
  p_escalation_from text,
  p_escalation_ring integer,
  p_note            text
) returns integer
  language plpgsql
  security invoker
  set search_path = public, pg_temp
as $$
declare
  target_agent uuid;
  next_version integer;
begin
  -- Unchanged, and load-bearing: this is SECURITY INVOKER, so RLS is what stops one
  -- organisation publishing into another's configuration. The check turns a silently
  -- zero-row update into a loud failure when the scope was never set.
  if app.current_tenant() is distinct from tenant then
    raise exception
      'publish_tenant_config needs the tenant scope set: select set_config(''app.tenant_id'', ...)';
  end if;

  select a.id into target_agent
    from agents a
   where a.tenant_id = tenant and a.archived_at is null
   order by a.created_at, a.id
   limit 1;

  if target_agent is null then
    -- An organisation with no live agent has nothing to publish to. Before 0018 this could
    -- not happen, because the tenant was the agent.
    raise exception 'tenant % has no live agent to publish to', tenant;
  end if;

  -- The organisation's own columns stay on `tenants`: the tool registry and the webhook
  -- subscriptions are shared across its agents, and 0018 left them there deliberately.
  update tenants
     set tool_config  = p_tool_config,
         event_config = p_event_config
   where id = tenant;

  -- Everything a caller experiences lives on the agent, which is what the three
  -- `app.*_config_*` functions read.
  update agents
     set name                    = coalesce(p_name, name),
         voice_id                = p_voice_id,
         greeting                = p_greeting,
         persona                 = p_persona,
         instructions            = p_instructions,
         keyterms                = coalesce(p_keyterms, '{}'),
         business_open_hour      = p_open_hour,
         business_close_hour     = p_close_hour,
         business_days           = p_business_days,
         escalation_to_number    = p_escalation_to,
         escalation_from_number  = p_escalation_from,
         escalation_ring_seconds = p_escalation_ring,
         config_version          = config_version + 1
   where id = target_agent
   returning config_version into next_version;

  if next_version is null then
    raise exception 'no such agent: %', target_agent;
  end if;

  -- The history row, now keyed by the agent as well as the tenant. `tenant_id` stays
  -- because every policy on the table filters on it, and a policy that has to join to find
  -- its tenant is a policy that gets dropped in a hurry.
  insert into tenant_prompt_versions
    (tenant_id, agent_id, version, name, voice_id, greeting, persona, instructions,
     keyterms, business_open_hour, business_close_hour, business_days,
     tool_config, event_config,
     escalation_to_number, escalation_from_number, escalation_ring_seconds, note)
  select a.tenant_id, a.id, a.config_version, a.name, a.voice_id, a.greeting, a.persona,
         a.instructions, a.keyterms, a.business_open_hour, a.business_close_hour,
         a.business_days,
         p_tool_config, p_event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         p_note
    from agents a where a.id = target_agent;

  return next_version;
end
$$;

revoke all on function app.publish_tenant_config(uuid, text, text, text, text, text, text[], integer, integer, integer[], jsonb, jsonb, text, text, integer, text) from public;
grant execute on function app.publish_tenant_config(uuid, text, text, text, text, text, text[], integer, integer, integer[], jsonb, jsonb, text, text, integer, text) to ansa_app;
