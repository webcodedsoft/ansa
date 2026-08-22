-- `ansa_app` can read any agent's published configuration, in any organisation, given its id.
--
-- `app.agent_config_for_id(agent uuid)` is SECURITY DEFINER — so RLS does not apply to it —
-- filters on `where a.id = agent` and nothing else, and is granted to `ansa_app`. Its return
-- includes the agent's greeting, persona, instructions, tool configuration and the
-- organisation's `organization_credentials` as a `credentials` column. An id is a uuid, so
-- guessing one is not a realistic attack; being handed one is. Any route that ever accepts an
-- agent id from a request and passes it here reads across the tenant boundary, and RLS —
-- which is the thing the whole design leans on — is not consulted.
--
-- Nothing calls it from TypeScript today, which is why this has never fired. It is reachable
-- only through `agent_config_for_organization` and `agent_config_for_number`, both of which
-- resolve the agent themselves from something the caller is already entitled to. So this is a
-- latent hole rather than a live one: a grant with no caller, waiting for the first route that
-- takes an `:agentId` from a path.
--
-- That route was about to be written. Making `config.*` agent-scoped means passing a
-- request's agent id to a configuration reader, and this is the reader — so the hole would
-- have opened as a side effect of a change nobody would have described as touching isolation.
-- Closing it first is the only order that makes sense.
--
-- Two functions instead of one, rather than adding a check inside the existing one, because
-- the two callers genuinely differ. `agent_config_for_number` runs at ingress, before any
-- organisation is known — resolving the organisation is what it is *for* — so it cannot ask
-- whether the agent belongs to the current one. A single function with an
-- `if current_organization() is not null` branch would be permissive exactly when nothing is
-- set, which is the state an unscoped connection is in.
--
-- The revoke is safe for both existing callers: they are SECURITY DEFINER and owned by
-- `postgres`, so their inner call to `agent_config_for_id` executes as the owner and does not
-- consult `ansa_app`'s grants at all.

create or replace function app.agent_config_for_agent(agent uuid)
returns table (
  id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text,
  persona text, instructions text, business_open_hour integer, business_close_hour integer,
  business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb,
  escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer,
  credentials jsonb, config_version integer, barge_in boolean, speaking_rate real,
  amd_enabled boolean, captured_fields jsonb, policy_blocks jsonb
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $fn$
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
$fn$;

revoke all on function app.agent_config_for_agent(uuid) from public;
grant execute on function app.agent_config_for_agent(uuid) to ansa_app;

-- The unscoped primitive stops being callable by the application. It stays in the schema
-- because the two resolvers above are built on it and are the legitimate way in.
revoke all on function app.agent_config_for_id(uuid) from public;
revoke all on function app.agent_config_for_id(uuid) from ansa_app;

comment on function app.agent_config_for_id(uuid) is
  'Internal. Takes any agent id and performs no organisation check, so it must never be '
  'granted to ansa_app — see 0050. Callers: app.agent_config_for_number (no organisation '
  'exists yet at ingress) and app.agent_config_for_organization. Application code wants '
  'app.agent_config_for_agent, which refuses an agent outside the current scope.';
