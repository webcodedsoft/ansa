-- Three facts about the company that the console drew and could not store.
--
-- The organisation page was designed with a "Closed days" field beside the opening hours,
-- and a support email and website under the name. All three were marked "proposed" in the
-- design because nothing held them. This is what holds them.
--
-- `business_closed_dates` is the one that changes a call. Opening hours are a weekly pattern
-- — Monday to Saturday, eight to seven — and a public holiday is a hole in that pattern on
-- one specific date. Without it, on the first of October the agent tells a caller the office
-- is open and offers to book them in. The dates are in WAT, like the hours, and they travel
-- with the hours: an organisation that has not set hours is always open, and a hole in
-- "always" is not a shape the call path reasons about, so the column is meaningful only when
-- the three hour columns are.
--
-- `support_email` and `website` are kept and shown; the agent does not read them out. An
-- email address spoken over eight-kilohertz audio is not something a caller can write down,
-- and a website read aloud is worse. They are on the organisation for the people who run it.
--
-- The four call-path config functions are redefined together, one column added, for the
-- reason 0077 gives: `agent_config_for_agent` and `agent_config_for_organization` both
-- return `select * from agent_config_for_id`, so the return shape moves as one. The dates
-- come back as `text[]` in ISO form rather than `date[]`, because the driver would otherwise
-- hand back JavaScript Dates at the server's local midnight, and a date that has a time zone
-- is a date that can be off by one.

alter table organizations
  add column if not exists business_closed_dates date[] not null default '{}',
  add column if not exists support_email text,
  add column if not exists website text;

comment on column organizations.business_closed_dates is
  'Specific dates (WAT) the organisation is shut regardless of its weekly hours — public holidays and the like. Empty for most organisations. Read only when the three business hour columns are set.';
comment on column organizations.support_email is
  'Where a caller can be pointed in writing. Shown in the console; the agent does not read it out.';
comment on column organizations.website is
  'The organisation''s website, for the record. Not read out on calls.';

drop function if exists app.agent_config_for_organization(uuid);
drop function if exists app.agent_config_for_agent(uuid);
drop function if exists app.agent_config_for_number(text);
drop function if exists app.agent_config_for_id(uuid);

create function app.agent_config_for_id(agent uuid)
  returns table(
    id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text,
    persona text, instructions text, business_open_hour integer, business_close_hour integer,
    business_days integer[], business_closed_dates text[], tool_config jsonb, enabled_tools text[],
    event_config jsonb,
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
         t.business_closed_dates::text[],
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
    business_days integer[], business_closed_dates text[], tool_config jsonb, enabled_tools text[],
    event_config jsonb,
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
         t.business_closed_dates::text[],
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
    business_days integer[], business_closed_dates text[], tool_config jsonb, enabled_tools text[],
    event_config jsonb,
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
    business_days integer[], business_closed_dates text[], tool_config jsonb, enabled_tools text[],
    event_config jsonb,
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

-- `drop function` plus `create function` regrants EXECUTE to PUBLIC. These lines restore the
-- ACLs 0057 established and 0077 restored; `agent-config-scope.test.ts` checks them.
revoke execute on function app.agent_config_for_id(uuid) from public;
revoke execute on function app.agent_config_for_agent(uuid) from public;
grant execute on function app.agent_config_for_agent(uuid) to ansa_app;
