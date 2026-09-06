-- Recording a caller's voice becomes a decision an organisation makes, and tells them about.
--
-- Until now it was one process-wide env var, `RECORD_AUDIO_DIR`: all calls for every
-- organisation or none, with nothing said to the caller on any of them. Under NDPR the basis
-- for holding somebody's voice has to be something you can point at, and "an environment
-- variable was set" is not it.
--
-- `record_calls` is that decision, per organisation, off by default. The env var keeps its
-- job and loses the other one: it says *where* audio is written, and this says *whether*.
-- Both must be true, so a deployment with no directory records nothing however many
-- organisations ask for it, and a directory on disk records nobody who has not asked.
--
-- The disclosure is not optional and not configurable. An organisation that turns recording
-- on gets a sentence in the agent's opening line saying so — which is why this is a column on
-- `organizations` rather than a field on the agent's published configuration: a per-agent
-- toggle would let one number record silently while another disclosed, and the caller cannot
-- tell which number they rang.
--
-- The three call-path config functions are redefined together because `agent_config_for_agent`
-- returns `select * from agent_config_for_id`, so the return shape has to move as one. They
-- are reproduced exactly with one column added; the Rule 4 comment in `agent_config_for_id`
-- is kept, since `drafts.test.ts` asserts over the function source.

alter table organizations
  add column if not exists record_calls boolean not null default false;

comment on column organizations.record_calls is
  'Whether this organisation records call audio. Off by default. The agent discloses it in its opening line when on, and RECORD_AUDIO_DIR must also be set for anything to be written.';

-- Four, not three: `agent_config_for_organization` also delegates to `agent_config_for_id`,
-- so it declares the same return shape and has to move with it. Missing it produced
-- "return type mismatch in function declared to return record" on every call path read.
drop function if exists app.agent_config_for_organization(uuid);
drop function if exists app.agent_config_for_agent(uuid);
drop function if exists app.agent_config_for_number(text);
drop function if exists app.agent_config_for_id(uuid);

create function app.agent_config_for_id(agent uuid)
  returns table(
    id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text,
    persona text, instructions text, business_open_hour integer, business_close_hour integer,
    business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb,
    escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer,
    credentials jsonb, config_version integer, barge_in boolean, speaking_rate real,
    amd_enabled boolean, captured_fields jsonb, policy_blocks jsonb, crisis_handoff_number text,
    flow jsonb, authoring_mode text, appointment_calendar_id uuid, record_calls boolean)
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
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
         t.crisis_handoff_number,
         /* The agent's own columns, like everything else here. No unpublished work is
            consulted and none can be, because the table holding it is not named anywhere in
            this function — which is Rule 4 and is asserted over `prosrc` in
            `drafts.test.ts`, so even naming it in a comment fails the build. It did. */
         a.flow,
         a.authoring_mode,
         a.appointment_calendar_id,
         /* The organisation's, not the agent's, so one number cannot record silently while
            another discloses. The caller cannot tell which number they rang. */
         t.record_calls
    from agents a
    join organizations t on t.id = a.organization_id
   where a.id = agent
   limit 1
$function$;

create function app.agent_config_for_number(dialled text)
  returns table(
    id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text,
    persona text, instructions text, business_open_hour integer, business_close_hour integer,
    business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb,
    escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer,
    credentials jsonb, config_version integer, barge_in boolean, speaking_rate real,
    amd_enabled boolean, captured_fields jsonb, policy_blocks jsonb, crisis_handoff_number text,
    flow jsonb, authoring_mode text, appointment_calendar_id uuid, record_calls boolean)
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
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
         t.crisis_handoff_number,
         a.flow,
         a.authoring_mode,
         a.appointment_calendar_id,
         t.record_calls
    from agents a
    join organizations t on t.id = a.organization_id
   -- An archived agent does not answer. Its number should have been released first, but
   -- a number left behind must ring nobody rather than ring a retired script.
   where a.dialled_number = dialled and a.deleted_at is null
   limit 1
$function$;

create function app.agent_config_for_agent(agent uuid)
  returns table(
    id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text,
    persona text, instructions text, business_open_hour integer, business_close_hour integer,
    business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb,
    escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer,
    credentials jsonb, config_version integer, barge_in boolean, speaking_rate real,
    amd_enabled boolean, captured_fields jsonb, policy_blocks jsonb, crisis_handoff_number text,
    flow jsonb, authoring_mode text, appointment_calendar_id uuid, record_calls boolean)
  language plpgsql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
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

create function app.agent_config_for_organization(organization uuid)
  returns table(
    id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text,
    persona text, instructions text, business_open_hour integer, business_close_hour integer,
    business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb,
    escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer,
    credentials jsonb, config_version integer, barge_in boolean, speaking_rate real,
    amd_enabled boolean, captured_fields jsonb, policy_blocks jsonb, crisis_handoff_number text,
    flow jsonb, authoring_mode text, appointment_calendar_id uuid, record_calls boolean)
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
  select * from app.agent_config_for_id((
    select a.id from agents a
     where a.organization_id = organization and a.deleted_at is null
     order by a.created_at, a.id
     limit 1
  ))
$function$;

-- The lesson 0057 wrote down, applied: `drop function` plus `create function` is not
-- `create or replace`, and Postgres grants EXECUTE to PUBLIC on every newly created
-- function. These three lines restore exactly the ACLs 0057 established.
--
-- `agent_config_for_id` stays unreachable from the application role. It takes an agent id
-- straight from a request path and checks nothing, so an organisation that could execute it
-- could read another organisation's configuration by guessing a uuid. 0050 revoked it, 0056
-- gave it back by accident, 0057 took it away again, and this migration would have given it
-- back a third time — `agent-config-scope.test.ts` refused to let that happen.
revoke execute on function app.agent_config_for_id(uuid) from public;
revoke execute on function app.agent_config_for_agent(uuid) from public;

-- The scoped one checks the organisation itself, so the role that handles requests may call
-- it. The number-keyed one is left at the default it has always had: it is keyed on a dialled
-- number the carrier supplies, not on an id anybody can guess.
grant execute on function app.agent_config_for_agent(uuid) to ansa_app;
