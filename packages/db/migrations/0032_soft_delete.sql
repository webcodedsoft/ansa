-- Soft delete, on the four tables where it means something.
--
-- Not everywhere. `deleted_at` is not a column, it is a rule every read has to honour, and a
-- soft delete that reads still return is worse than none: a "deleted" session that still
-- authenticates, a "deleted" credential that still opens an endpoint, a "deleted"
-- `do_not_call` row that stops suppressing calls. Audio is hard-deleted on purpose, because
-- retention is a promise that a caller's voice actually goes. Calls, turns, transcripts and
-- versions are records of things that happened, and deleting one is not an ordinary act.
--
-- So: organizations, users, memberships, and agents — which already had the idea under the
-- name `archived_at`. That column is renamed rather than joined by a second one, because two
-- flags meaning "gone" is a guaranteed bug the first time code checks only one.
--
-- The security-carrying change is the `users` policy. It grants access through a membership
-- row, so a membership that has been deleted must stop granting it — otherwise removing
-- somebody from an organisation would leave them able to read it.

alter table agents rename column archived_at to deleted_at;

alter table organizations add column if not exists deleted_at timestamptz;
alter table users         add column if not exists deleted_at timestamptz;
alter table memberships   add column if not exists deleted_at timestamptz;

comment on column agents.deleted_at is
  'Soft delete. Renamed from archived_at by 0032 so every table says it the same way.';

-- The partial index followed the old name and has to be rebuilt against the new one.
drop index if exists agents_tenant_idx;
create index agents_tenant_idx on agents (organization_id) where deleted_at is null;

create index if not exists organizations_live_idx on organizations (id) where deleted_at is null;
create index if not exists users_live_idx on users (id) where deleted_at is null;
create index if not exists memberships_live_idx on memberships (organization_id, user_id) where deleted_at is null;

-- Every function that read `archived_at`, recreated verbatim against the new name. Generated
-- from `pg_get_functiondef` rather than retyped, so nothing drifts from what was deployed.
CREATE OR REPLACE FUNCTION app.agent_config_for_number(dialled text)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, amd_enabled boolean, captured_fields jsonb)
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
         a.config_version, a.barge_in, a.answering_machine_detection,
         a.captured_fields
    from agents a
    join organizations t on t.id = a.organization_id
   -- An archived agent does not answer. Its number should have been released first, but
   -- a number left behind must ring nobody rather than ring a retired script.
   where a.dialled_number = dialled and a.deleted_at is null
   limit 1
$function$;

CREATE OR REPLACE FUNCTION app.agent_config_for_organization(organization uuid)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, amd_enabled boolean, captured_fields jsonb)
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

CREATE OR REPLACE FUNCTION app.agent_for_number(dialled text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select a.id from agents a
   where a.dialled_number = dialled and a.deleted_at is null
   limit 1
$function$;

CREATE OR REPLACE FUNCTION app.organization_for_number(dialled text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select a.organization_id from agents a
   where a.dialled_number = dialled and a.deleted_at is null
   limit 1
$function$;

CREATE OR REPLACE FUNCTION app.publish_agent_config(organization uuid, p_name text, p_voice_id text, p_greeting text, p_persona text, p_instructions text, p_keyterms text[], p_open_hour integer, p_close_hour integer, p_business_days integer[], p_tool_config jsonb, p_event_config jsonb, p_escalation_to text, p_escalation_from text, p_escalation_ring integer, p_note text)
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

/*
 * A deleted membership stops granting access.
 *
 * This policy is how a user row is visible at all, and it asks only whether a membership
 * joins the two. Without the new clause, removing somebody from an organisation would leave
 * them readable — and, worse, would leave the row that says they belong. Of everything in
 * this migration, this is the line that matters.
 */
drop policy if exists organization_isolation on users;
create policy organization_isolation on users
  using (
    exists (
      select 1
        from memberships m
       where m.user_id = users.id
         and m.organization_id = app.current_organization()
         and m.deleted_at is null
    )
  );

/*
 * The organisations somebody belongs to.
 *
 * Both filters are needed and they are different questions: a deleted membership means they
 * have left, a deleted organisation means there is nothing to go back to. Either one alone
 * would still list something that should not appear on a sign-in screen.
 */
create or replace function app.organisations_for_user(p_user uuid)
returns table(organization_id uuid, name text, role text)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $fn$
  select t.id, t.name, m.role
    from memberships m
    join organizations t on t.id = m.organization_id
   where m.user_id = p_user
     and m.deleted_at is null
     and t.deleted_at is null
   order by t.name
$fn$;

/*
 * An organisation keeps an owner — counting only the memberships that still stand.
 *
 * Without the filter, soft-deleting the last owner would pass this check by being counted as
 * its own replacement, and the organisation would be left with nobody who can administer it.
 * A deleted organisation is exempt for the reason the original gives: it cannot be short of
 * an owner if it is gone.
 */
create or replace function app.memberships_keep_an_owner() returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $fn$
declare
  affected uuid;
begin
  affected := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;

  if not exists (
    select 1 from organizations t where t.id = affected and t.deleted_at is null
  ) then
    return null;
  end if;

  if not exists (
    select 1 from memberships m
     where m.organization_id = affected and m.role = 'owner' and m.deleted_at is null
  ) then
    raise exception 'an organisation must keep at least one owner';
  end if;
  return null;
end
$fn$;
