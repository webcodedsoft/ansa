-- Pushing an organisation its own data (Slice 6a, R5.2.4).
--
-- Two things land here, and the shape of both follows from one rule: **a delivery must
-- never affect a call.** The call recorder has the same rule and the same reason — the
-- caller is mid-conversation and our webhook receiver's bad afternoon is not their problem
-- — but here it can be made structural rather than careful. The call path does not make
-- the request. It writes a row. Everything after that happens on a timer with no call in
-- sight, so there is no code path from a failing receiver back to a conversation.
--
--   tenants.event_config   which receivers get which events, how they verify us, and this
--                          organisation's own redaction rules. Not a secret: a URL, a list
--                          of event names, a reference into the credential vault. Versioned
--                          alongside the prompt and the tool config, because which of their
--                          data left the building on a given day is exactly the question an
--                          audit asks.
--
--   event_deliveries       the outbox. One row per (event, receiver), the exact bytes that
--                          were sent, every attempt and how it went. This is what answers
--                          "you never sent it" with something other than an opinion.
--
-- Nothing changes for any tenant until somebody publishes an event_config. Null means no
-- delivery is ever attempted, which is where every tenant is today.

alter table tenants add column if not exists event_config jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_event_config_is_object') then
    alter table tenants add constraint tenants_event_config_is_object check (
      event_config is null or jsonb_typeof(event_config) = 'object'
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The outbox
-- ---------------------------------------------------------------------------

create table if not exists event_deliveries (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references tenants(id) on delete cascade,
  -- 'call.ended', 'call.transferred'. Text rather than an enum so adding the third does not
  -- need a migration and a deploy in the right order.
  event_type      text        not null,
  -- The tenant's own name for the receiver, so a delivery log reads as their configuration
  -- rather than as a URL.
  subscription    text        not null,
  -- The carrier's own id and not our row id, deliberately: a tenant looking a delivery up
  -- has the id their phone system shows them, and our call row may be gone to retention
  -- long before this one is.
  carrier_call_id text,
  -- Which configuration decided the payload and its redaction. The whole point of
  -- versioning event_config.
  config_version  integer,
  /*
   * The exact bytes sent, serialised and redacted once, when the event happened.
   *
   * Rebuilding the payload per attempt was the obvious design and it is wrong three times
   * over: the signature covers the body, so a rebuild that differs anywhere invalidates the
   * receiver's deduplication; a payload derived from the call record would change if a
   * transcript were corrected between attempt one and attempt four, which makes "here is
   * what we sent you" a guess; and the redaction that applied is the one from the config
   * version in force at the time, not whatever is in force at 3am when the retry lands.
   */
  body            text        not null,
  -- pending | delivered | failed. 'failed' means attempts ran out or the receiver said
  -- something that will never become a yes.
  status          text        not null default 'pending',
  attempts        integer     not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_status     integer,
  last_error      text,
  delivered_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint event_deliveries_status_known check (status in ('pending', 'delivered', 'failed'))
);

-- The sweeper's only query: the oldest pending row that is due. Partial, because delivered
-- rows are the overwhelming majority within an hour and none of them is ever due again.
create index if not exists event_deliveries_due
  on event_deliveries (next_attempt_at)
  where status = 'pending';

-- The tenant's query: what happened to my deliveries, newest first.
create index if not exists event_deliveries_by_tenant
  on event_deliveries (tenant_id, created_at desc);

grant select, insert, update, delete on event_deliveries to ansa_app;

alter table event_deliveries enable row level security;
alter table event_deliveries force  row level security;
drop policy if exists tenant_isolation on event_deliveries;
create policy tenant_isolation on event_deliveries
  using (tenant_id = app.current_tenant())
  with check (tenant_id = app.current_tenant());

-- ---------------------------------------------------------------------------
-- Claiming work, which has no tenant to be scoped to
-- ---------------------------------------------------------------------------

-- The same chicken-and-egg as tenant resolution (0003) and the carrier status callback
-- (0009): the delivery worker runs on a timer with no call and no tenant context, and RLS
-- quite correctly hides every row from it. So the claim is SECURITY DEFINER and narrow by
-- construction — it returns rows that are already due, marks each one as attempted in the
-- same statement so a second worker cannot take it, and returns no transcript that was not
-- already destined for that row's own tenant.
--
-- `for update skip locked` is what makes a second process safe to add later without
-- delivering everything twice. At-least-once is the contract; twice on every event is not.
drop function if exists app.claim_due_event_deliveries(integer);
create function app.claim_due_event_deliveries(batch integer)
  returns table (
    id              uuid,
    tenant_id       uuid,
    event_type      text,
    subscription    text,
    carrier_call_id text,
    config_version  integer,
    body            text,
    attempts        integer
  )
  language sql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
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
  returning d.id, d.tenant_id, d.event_type, d.subscription,
            d.carrier_call_id, d.config_version, d.body, d.attempts;
$$;

revoke all on function app.claim_due_event_deliveries(integer) from public;
grant execute on function app.claim_due_event_deliveries(integer) to ansa_app;

-- Recording what happened, in the same place and for the same reason as the claim.
drop function if exists app.record_event_delivery_result(uuid, text, integer, text, integer);
create function app.record_event_delivery_result(
  delivery      uuid,
  new_status    text,
  http_status   integer,
  error_detail  text,
  retry_in_ms   integer
) returns void
  language sql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
  update event_deliveries
     set status = new_status,
         last_status = http_status,
         last_error = error_detail,
         delivered_at = case when new_status = 'delivered' then now() else delivered_at end,
         next_attempt_at = case
           when new_status = 'pending' then now() + make_interval(secs => retry_in_ms / 1000.0)
           else next_attempt_at
         end,
         updated_at = now()
   where id = delivery;
$$;

revoke all on function app.record_event_delivery_result(uuid, text, integer, text, integer) from public;
grant execute on function app.record_event_delivery_result(uuid, text, integer, text, integer) to ansa_app;

-- Housekeeping, and cross-tenant for the same reason the audio sweep in 0010 is: a timer
-- firing at four in the morning acts for everybody and has no tenant scope to run under.
--
-- A settled delivery holds a copy of a transcript, which is subject to the same instinct as
-- audio retention: keep it as long as it can answer the question it exists for, and no
-- longer. A row that is still pending is never touched however old — a delivery that has
-- been retrying since yesterday is precisely the one somebody is about to ask about.
drop function if exists app.purge_settled_event_deliveries(integer);
create function app.purge_settled_event_deliveries(older_than_days integer)
  returns integer
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  removed integer;
begin
  delete from event_deliveries
   where status in ('delivered', 'failed')
     and updated_at < now() - make_interval(days => greatest(1, older_than_days));
  get diagnostics removed = row_count;
  return removed;
end
$$;

revoke all on function app.purge_settled_event_deliveries(integer) from public;
grant execute on function app.purge_settled_event_deliveries(integer) to ansa_app;

-- ---------------------------------------------------------------------------
-- Versioned, because it decides which of their data left and in what state
-- ---------------------------------------------------------------------------

alter table tenant_prompt_versions add column if not exists event_config jsonb;

update tenant_prompt_versions p
   set event_config = t.event_config
  from tenants t
 where p.tenant_id = t.id
   and p.version = t.config_version
   and p.event_config is null;

-- DROP then CREATE, not CREATE OR REPLACE: the signature changes. Same note as 0003, 0004,
-- 0005, 0011, 0012 and 0013, for the same reason.
drop function if exists app.publish_tenant_config(uuid, text, text, text, text, text, text[], integer, integer, integer[], jsonb, text);
create function app.publish_tenant_config(
  tenant              uuid,
  p_name              text,
  p_voice_id          text,
  p_greeting          text,
  p_persona           text,
  p_instructions      text,
  p_keyterms          text[],
  p_open_hour         integer,
  p_close_hour        integer,
  p_business_days     integer[],
  p_tool_config       jsonb,
  p_event_config      jsonb,
  p_note              text
) returns integer
  language plpgsql
  volatile
as $$
declare
  next_version integer;
begin
  if app.current_tenant() is distinct from tenant then
    raise exception
      'publish_tenant_config needs the tenant scope set: select set_config(''app.tenant_id'', ...)';
  end if;

  update tenants
     set name                = coalesce(p_name, name),
         voice_id            = p_voice_id,
         greeting            = p_greeting,
         persona             = p_persona,
         instructions        = p_instructions,
         keyterms            = coalesce(p_keyterms, '{}'),
         business_open_hour  = p_open_hour,
         business_close_hour = p_close_hour,
         business_days       = p_business_days,
         tool_config         = p_tool_config,
         event_config        = p_event_config,
         config_version      = config_version + 1
   where id = tenant
   returning config_version into next_version;

  if next_version is null then
    raise exception 'no such tenant: %', tenant;
  end if;

  insert into tenant_prompt_versions
    (tenant_id, version, name, voice_id, greeting, persona, instructions, keyterms,
     business_open_hour, business_close_hour, business_days, tool_config, event_config, note)
  select id, config_version, name, voice_id, greeting, persona, instructions, keyterms,
         business_open_hour, business_close_hour, business_days, tool_config, event_config, p_note
    from tenants where id = tenant;

  return next_version;
end
$$;

revoke all on function app.publish_tenant_config(uuid, text, text, text, text, text, text[], integer, integer, integer[], jsonb, jsonb, text) from public;
grant execute on function app.publish_tenant_config(uuid, text, text, text, text, text, text[], integer, integer, integer[], jsonb, jsonb, text) to ansa_app;

drop function if exists app.tenant_config_at_version(uuid, integer);
create function app.tenant_config_at_version(tenant uuid, v integer)
  returns table (
    id                  uuid,
    name                text,
    keyterms            text[],
    voice_id            text,
    greeting            text,
    persona             text,
    instructions        text,
    business_open_hour  integer,
    business_close_hour integer,
    business_days       integer[],
    tool_config         jsonb,
    event_config        jsonb,
    config_version      integer
  )
  language sql
  stable
as $$
  select p.tenant_id, p.name, p.keyterms, p.voice_id, p.greeting, p.persona,
         p.instructions, p.business_open_hour, p.business_close_hour, p.business_days,
         p.tool_config, p.event_config, p.version
    from tenant_prompt_versions p
   where p.tenant_id = tenant and p.version = v
$$;

revoke all on function app.tenant_config_at_version(uuid, integer) from public;
grant execute on function app.tenant_config_at_version(uuid, integer) to ansa_app;

drop function if exists app.tenant_config_for_number(text);
create function app.tenant_config_for_number(dialled text)
  returns table (
    id                  uuid,
    name                text,
    keyterms            text[],
    voice_id            text,
    greeting            text,
    persona             text,
    instructions        text,
    business_open_hour  integer,
    business_close_hour integer,
    business_days       integer[],
    tool_config         jsonb,
    event_config        jsonb,
    credentials         jsonb,
    config_version      integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select t.id, t.name, t.keyterms, t.voice_id, t.greeting, t.persona, t.instructions,
         t.business_open_hour, t.business_close_hour, t.business_days, t.tool_config,
         t.event_config,
         (select jsonb_object_agg(c.ref, c.sealed)
            from tenant_credentials c where c.tenant_id = t.id),
         t.config_version
    from tenants t
   where t.dialled_number = dialled
   limit 1
$$;

revoke all on function app.tenant_config_for_number(text) from public;
grant execute on function app.tenant_config_for_number(text) to ansa_app;

drop function if exists app.tenant_config_for_id(uuid);
create function app.tenant_config_for_id(tenant uuid)
  returns table (
    id                  uuid,
    name                text,
    keyterms            text[],
    voice_id            text,
    greeting            text,
    persona             text,
    instructions        text,
    business_open_hour  integer,
    business_close_hour integer,
    business_days       integer[],
    tool_config         jsonb,
    event_config        jsonb,
    credentials         jsonb,
    config_version      integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select t.id, t.name, t.keyterms, t.voice_id, t.greeting, t.persona, t.instructions,
         t.business_open_hour, t.business_close_hour, t.business_days, t.tool_config,
         t.event_config,
         (select jsonb_object_agg(c.ref, c.sealed)
            from tenant_credentials c where c.tenant_id = t.id),
         t.config_version
    from tenants t
   where t.id = tenant
   limit 1
$$;

revoke all on function app.tenant_config_for_id(uuid) from public;
grant execute on function app.tenant_config_for_id(uuid) to ansa_app;
