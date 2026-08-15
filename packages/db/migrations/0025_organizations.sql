-- "Tenant" becomes "organization", everywhere.
--
-- `tenants` was the first table in the schema and the word leaked into every layer above
-- it: nineteen tables carry `tenant_id`, fifteen functions embed it, eighteen row-level
-- security policies compare against it, and the product's own vocabulary is
-- "organisation". One concept with two names is a concept people get wrong, and the person
-- it confused most recently was the person who owns the product.
--
-- Three things make this safe to do in one migration rather than in pieces:
--
--   * `alter table ... rename` preserves data, indexes, constraints and foreign keys, and
--     policies track a renamed column automatically. Nothing is copied and nothing is
--     dropped, so there is no window where a row exists in one place and not the other.
--   * The function bodies below are the LIVE definitions, read out of `pg_get_functiondef`
--     and transformed mechanically. None was retyped, so none can quietly lose a clause.
--   * The isolation suite is the gate. A rename that broke RLS would show up as one
--     organisation reading another's calls, which is exactly what those tests try to do.
--
-- The setting changes with the schema: `app.tenant_id` becomes `app.organization_id`, so a
-- session opened by the old code against the new schema is scoped to nothing and reads no
-- rows. That is the correct failure — loud and empty, never another organisation's data.
--
-- Two functions are renamed for accuracy rather than vocabulary, because they stopped
-- being about the organisation in migration 0018 and have been misleading since:
--   app.tenant_config_for_number -> app.agent_config_for_number
--   app.tenant_config_for_id     -> app.agent_config_for_organization
-- Both return the agent's configuration. The second one still resolves the organisation's
-- oldest live agent, which is a guess it should not have to make; making `config.*`
-- agent-scoped removes it.

-- ---------------------------------------------------------------------------
-- The view goes first, and comes back last
-- ---------------------------------------------------------------------------

drop view if exists tenant_number_routing;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

alter table if exists tenants                rename to organizations;
alter table if exists tenant_credentials     rename to organization_credentials;
alter table if exists tenant_numbers         rename to organization_numbers;

-- Renamed for what it is rather than for the vocabulary: migration 0018 re-keyed this on
-- the agent, so "tenant prompt versions" has been describing the wrong owner since.
alter table if exists tenant_prompt_versions rename to agent_prompt_versions;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

-- Every table that carries the column, found rather than listed: a hand-written list is a
-- list that misses the table somebody adds next week.
do $$
declare t text;
begin
  for t in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables x
        on x.table_name = c.table_name and x.table_schema = c.table_schema
     where c.column_name = 'tenant_id'
       and c.table_schema = 'public'
       and x.table_type = 'BASE TABLE'
  loop
    execute format('alter table %I rename column tenant_id to organization_id', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The scope function
-- ---------------------------------------------------------------------------

create or replace function app.current_organization() returns uuid
  language sql
  stable
as $$
  select nullif(current_setting('app.organization_id', true), '')::uuid
$$;

revoke all on function app.current_organization() from public;
grant execute on function app.current_organization() to ansa_app;

-- ---------------------------------------------------------------------------
-- Policies, recreated to call it
-- ---------------------------------------------------------------------------

-- A column rename carries into a policy automatically; a function rename does not, because
-- the policy holds the old name by identity. Found rather than listed, for the same reason
-- the column loop is.
do $$
declare t text;
begin
  for t in select tablename from pg_policies where policyname = 'tenant_isolation'
  loop
    execute format('drop policy tenant_isolation on %I', t);
    execute format('drop policy if exists organization_isolation on %I', t);
    if t = 'organizations' then
      execute 'create policy organization_isolation on organizations
                 using (id = app.current_organization())
                 with check (id = app.current_organization())';
    elsif t = 'users' then
      -- Reachable through a shared membership, not by carrying a column.
      execute 'create policy organization_isolation on users
                 using (exists (select 1 from memberships m
                                 where m.user_id = users.id
                                   and m.organization_id = app.current_organization()))';
    else
      execute format('create policy organization_isolation on %I
                        using (organization_id = app.current_organization())
                        with check (organization_id = app.current_organization())', t);
    end if;
  end loop;
end $$;

-- Two more, under their own names rather than `tenant_isolation`, so the loop above did
-- not see them. Written out instead of generated because `do_not_call` is not the standard
-- shape: a row with no organisation is the platform-wide suppression list, visible to
-- everyone and writable by nobody through this policy. Losing that OR would quietly hide
-- the numbers the platform itself refuses to dial.
drop policy if exists outbound_consent_tenant on outbound_consent;
drop policy if exists outbound_consent_isolation on outbound_consent;
create policy outbound_consent_isolation on outbound_consent
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

drop policy if exists do_not_call_tenant on do_not_call;
drop policy if exists do_not_call_isolation on do_not_call;
create policy do_not_call_isolation on do_not_call
  using (organization_id = app.current_organization() or organization_id is null)
  with check (organization_id = app.current_organization());

-- ---------------------------------------------------------------------------
-- No agent is created for anyone
-- ---------------------------------------------------------------------------

-- Migration 0024 added this trigger so that a newly signed-up organisation was not left
-- unable to publish. It solved that, and it decided something that is not the database's
-- to decide: an organisation creates its own agents, choosing a template if it wants one.
--
-- What 0024 was really guarding against stays guarded, just in the right place — the
-- console shows an empty state and a way to create the first agent, and
-- `app.publish_agent_config` still refuses loudly when there is no agent to publish to.
drop trigger if exists tenants_get_an_agent on organizations;

-- ---------------------------------------------------------------------------
-- Functions, transformed from their live definitions
--
-- Dropped and recreated rather than replaced: renaming an OUT parameter changes the
-- function's return type, and CREATE OR REPLACE refuses that. The DROP names the old
-- signature, the CREATE below it the new one.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS app.accept_invitation(p_token_hash bytea, p_password_hash text, p_display_name text, p_now timestamp with time zone);
CREATE OR REPLACE FUNCTION app.accept_invitation(p_token_hash bytea, p_password_hash text, p_display_name text, p_now timestamp with time zone)
 RETURNS TABLE(out_organization_id uuid, out_user_id uuid, out_role text, out_created_user boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  invite    record;
  existing  uuid;
  joined    uuid;
  is_new    boolean := false;
begin
  update invitations i
     set accepted_at = p_now
   where i.token_hash = p_token_hash
     and i.accepted_at is null
     and i.revoked_at is null
     and i.expires_at > p_now
  returning i.id, i.organization_id, i.email, i.role into invite;

  if invite is null then
    return;
  end if;

  select u.id into existing from users u where u.email = invite.email;

  if existing is null then
    insert into users (email, password_hash, display_name)
      values (invite.email, p_password_hash, p_display_name)
      returning id into joined;
    is_new := true;
  else
    joined := existing;
  end if;

  insert into memberships (organization_id, user_id, role)
    values (invite.organization_id, joined, invite.role)
    on conflict (organization_id, user_id) do update set role = excluded.role;

  update invitations set accepted_user_id = joined where id = invite.id;

  return query select invite.organization_id, joined, invite.role, is_new;
end
$function$;

DROP FUNCTION IF EXISTS app.agent_config_at_version(agent uuid, v integer);
CREATE OR REPLACE FUNCTION app.agent_config_at_version(agent uuid, v integer)
 RETURNS TABLE(name text, voice_id text, greeting text, persona text, instructions text, keyterms text[], business_open_hour integer, business_close_hour integer, business_days integer[], escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, version integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select p.name, p.voice_id, p.greeting, p.persona, p.instructions, p.keyterms,
         p.business_open_hour, p.business_close_hour, p.business_days,
         p.escalation_to_number, p.escalation_from_number,
         p.escalation_ring_seconds, p.version
    from agent_prompt_versions p
   where p.agent_id = agent and p.version = v
$function$;

DROP FUNCTION IF EXISTS app.agent_config_for_id(agent uuid);
CREATE OR REPLACE FUNCTION app.agent_config_for_id(agent uuid)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, amd_enabled boolean, captured_fields jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select t.id, a.id, a.name, a.keyterms, a.voice_id, a.greeting, a.persona, a.instructions,
         a.business_open_hour, a.business_close_hour, a.business_days,
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
   where a.id = agent
   limit 1
$function$;

DROP FUNCTION IF EXISTS app.claim_due_event_deliveries(batch integer);
CREATE OR REPLACE FUNCTION app.claim_due_event_deliveries(batch integer)
 RETURNS TABLE(id uuid, organization_id uuid, event_type text, subscription text, carrier_call_id text, config_version integer, body text, attempts integer)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with due as (
    select d.id
      from event_deliveries d
     where d.status = 'pending'
       and d.next_attempt_at <= now()
     order by d.next_attempt_at
     limit greatest(1, least(batch, 200))
     for update skip locked
  )
  update event_deliveries d
     set attempts = d.attempts + 1,
         -- Pushed out immediately so a worker that dies mid-request does not leave the row
         -- claimable in the same second. The real backoff is written by the result.
         next_attempt_at = now() + interval '2 minutes',
         updated_at = now()
    from due
   where d.id = due.id
  returning d.id, d.organization_id, d.event_type, d.subscription,
            d.carrier_call_id, d.config_version, d.body, d.attempts;
$function$;

DROP FUNCTION IF EXISTS app.create_default_agent();

DROP FUNCTION IF EXISTS app.create_organisation(p_name text, p_email text, p_password_hash text, p_display_name text, p_now timestamp with time zone);
CREATE OR REPLACE FUNCTION app.create_organisation(p_name text, p_email text, p_password_hash text, p_display_name text, p_now timestamp with time zone)
 RETURNS TABLE(out_organization_id uuid, out_user_id uuid, out_created_user boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  existing   uuid;
  owner_id   uuid;
  new_organization uuid;
  is_new     boolean := false;
begin
  -- Addresses are stored lowercased and every lookup elsewhere assumes it. Normalising here
  -- rather than trusting the caller means one casing of an address cannot become a second
  -- account with the same name.
  select u.id into existing from users u where u.email = lower(p_email);

  if existing is null then
    if p_password_hash is null then
      raise exception 'a new account needs a password hash';
    end if;
    insert into users (email, password_hash, display_name)
      values (lower(p_email), p_password_hash, p_display_name)
      returning id into owner_id;
    is_new := true;
  else
    owner_id := existing;
  end if;

  -- Everything else on `organizations` has a default or is nullable, and is deliberately left
  -- alone: a brand-new organisation answers on the platform defaults until somebody
  -- publishes a configuration, and inventing values here would put a version in the history
  -- that no person chose.
  insert into organizations (name) values (p_name) returning id into new_organization;

  insert into memberships (organization_id, user_id, role)
    values (new_organization, owner_id, 'owner');

  return query select new_organization, owner_id, is_new;
end
$function$;

DROP FUNCTION IF EXISTS app.current_tenant();
CREATE OR REPLACE FUNCTION app.current_organization()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select nullif(current_setting('app.organization_id', true), '')::uuid
$function$;

DROP FUNCTION IF EXISTS app.expired_call_audio();
CREATE OR REPLACE FUNCTION app.expired_call_audio()
 RETURNS TABLE(carrier_call_id text, organization_id uuid, retention_days integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select c.carrier_call_id, c.organization_id, t.audio_retention_days
    from calls c
    join organizations t on t.id = c.organization_id
   -- ended_at is the honest clock, but a call whose ending was never recorded must not
   -- become immortal, so fall back through answered_at to created_at.
   where coalesce(c.ended_at, c.answered_at, c.created_at)
           < now() - make_interval(days => t.audio_retention_days);
$function$;

-- The last-owner rule is a deferred constraint trigger, so the trigger has to stand aside
-- while its function is recreated and go back exactly as it was. Deferred matters: it fires
-- at commit, which is what lets a transaction demote one owner and promote another without
-- passing through a moment where the organisation has none.
drop trigger if exists memberships_keep_an_owner on memberships;
DROP FUNCTION IF EXISTS app.memberships_keep_an_owner();
CREATE OR REPLACE FUNCTION app.memberships_keep_an_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  affected uuid;
begin
  affected := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;

  -- Deleting the organisation cascades to its memberships, and an organisation that no
  -- longer exists cannot be short of an owner. Checked at commit time, because the
  -- trigger is deferred, so by here the organization row is already gone.
  if not exists (select 1 from organizations t where t.id = affected) then
    return null;
  end if;

  if not exists (
    select 1 from memberships m where m.organization_id = affected and m.role = 'owner'
  ) then
    raise exception 'an organisation must keep at least one owner';
  end if;
  return null;
end
$function$;

DROP FUNCTION IF EXISTS app.min_audio_retention_days();
CREATE OR REPLACE FUNCTION app.min_audio_retention_days()
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(min(audio_retention_days), 30) from organizations;
$function$;

DROP FUNCTION IF EXISTS app.organisations_for_user(p_user uuid);
CREATE OR REPLACE FUNCTION app.organisations_for_user(p_user uuid)
 RETURNS TABLE(organization_id uuid, name text, role text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select t.id, t.name, m.role
    from memberships m
    join organizations t on t.id = m.organization_id
   where m.user_id = p_user
   order by t.name
$function$;

DROP FUNCTION IF EXISTS app.publish_tenant_config(tenant uuid, p_name text, p_voice_id text, p_greeting text, p_persona text, p_instructions text, p_keyterms text[], p_open_hour integer, p_close_hour integer, p_business_days integer[], p_tool_config jsonb, p_event_config jsonb, p_escalation_to text, p_escalation_from text, p_escalation_ring integer, p_note text);
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
      'publish_tenant_config needs the organization scope set: select set_config(''app.organization_id'', ...)';
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
     set tool_config  = p_tool_config,
         event_config = p_event_config
   where id = organization;

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

  -- The history row, now keyed by the agent as well as the organization. `organization_id` stays
  -- because every policy on the table filters on it, and a policy that has to join to find
  -- its organization is a policy that gets dropped in a hurry.
  insert into agent_prompt_versions
    (organization_id, agent_id, version, name, voice_id, greeting, persona, instructions,
     keyterms, business_open_hour, business_close_hour, business_days,
     tool_config, event_config,
     escalation_to_number, escalation_from_number, escalation_ring_seconds, note)
  select a.organization_id, a.id, a.config_version, a.name, a.voice_id, a.greeting, a.persona,
         a.instructions, a.keyterms, a.business_open_hour, a.business_close_hour,
         a.business_days,
         p_tool_config, p_event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         p_note
    from agents a where a.id = target_agent;

  return next_version;
end
$function$;

DROP FUNCTION IF EXISTS app.tenant_config_for_id(tenant uuid);
CREATE OR REPLACE FUNCTION app.agent_config_for_organization(organization uuid)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, amd_enabled boolean, captured_fields jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select * from app.agent_config_for_id((
    select a.id from agents a
     where a.organization_id = organization and a.archived_at is null
     order by a.created_at, a.id
     limit 1
  ))
$function$;

DROP FUNCTION IF EXISTS app.tenant_config_for_number(dialled text);
CREATE OR REPLACE FUNCTION app.agent_config_for_number(dialled text)
 RETURNS TABLE(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, amd_enabled boolean, captured_fields jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select t.id, a.id, a.name, a.keyterms, a.voice_id, a.greeting, a.persona, a.instructions,
         a.business_open_hour, a.business_close_hour, a.business_days,
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
   where a.dialled_number = dialled and a.archived_at is null
   limit 1
$function$;

DROP FUNCTION IF EXISTS app.tenant_for_number(dialled text);
CREATE OR REPLACE FUNCTION app.organization_for_number(dialled text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select a.organization_id from agents a
   where a.dialled_number = dialled and a.archived_at is null
   limit 1
$function$;

-- ---------------------------------------------------------------------------
-- And back, unchanged.
drop trigger if exists memberships_keep_an_owner on memberships;
create constraint trigger memberships_keep_an_owner
  after delete or update on memberships
  deferrable initially deferred
  for each row execute function app.memberships_keep_an_owner();

-- ---------------------------------------------------------------------------
-- The old names go
-- ---------------------------------------------------------------------------

drop function if exists app.current_tenant();
drop function if exists app.tenant_for_number(text);
drop function if exists app.tenant_config_for_number(text);
drop function if exists app.tenant_config_for_id(uuid);
drop function if exists app.publish_tenant_config(uuid, text, text, text, text, text, text[], integer, integer, integer[], jsonb, jsonb, text, text, integer, text);

-- ---------------------------------------------------------------------------
-- And the view returns
-- ---------------------------------------------------------------------------

-- `security_invoker` is not optional. A view runs as its owner unless told otherwise, and
-- the first draft of migration 0019 left it off — the base table correctly returned nothing
-- to an unscoped session while this returned every organisation's numbers.
drop view if exists organization_number_routing;
create view organization_number_routing with (security_invoker = true) as
  select n.organization_id,
         n.number,
         n.note,
         n.created_at,
         a.id   as agent_id,
         a.name as agent_name
    from organization_numbers n
    left join agents a
      on a.organization_id = n.organization_id
     and a.dialled_number = n.number
     and a.archived_at is null;

grant select on organization_number_routing to ansa_app;

-- ---------------------------------------------------------------------------
-- Grants follow the new names
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on organizations to ansa_app;
grant select, insert, update, delete on organization_credentials to ansa_app;
grant select on organization_numbers to ansa_app;
grant select, insert on agent_prompt_versions to ansa_app;
