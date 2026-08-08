-- Versioned tenant configuration that can actually be read back (R7.5).
--
-- `calls.config_version` has been written on every call since Slice 2 and has pointed at
-- nothing the whole time. `tenants` holds one row per tenant with the CURRENT values, so
-- "this call ran on config version 3" was unanswerable the moment anyone published
-- version 4 — which is precisely the situation the requirement exists for. A call from
-- three weeks ago can only be explained if the configuration from three weeks ago still
-- exists.
--
-- So: `tenants` stays as the current values, because the call path reads it in one round
-- trip and that latency was hard-won (see 0004 and 0005). This adds the history beside
-- it, written in the same transaction as the bump.
--
-- Append-only, and enforced by grants rather than by intention: `ansa_app` gets SELECT
-- and INSERT and is never granted UPDATE or DELETE. An audit trail the application can
-- rewrite is not one.

-- ---------------------------------------------------------------------------
-- The tenant's own rules, alongside the persona they already have
-- ---------------------------------------------------------------------------

-- Bounded free text, layered ON the base prompt and never replacing it. "Bounded" is
-- enforced in apps/api/src/prompts/tenant-layer.ts, on the way into the prompt rather
-- than on the way into this column, so a row written by hand here is filtered exactly
-- like one written through onboarding.
alter table tenants add column if not exists instructions text;

-- ---------------------------------------------------------------------------
-- The history
-- ---------------------------------------------------------------------------

create table if not exists tenant_prompt_versions (
  tenant_id     uuid not null references tenants(id) on delete cascade,
  version       integer not null,
  name          text not null,
  voice_id      text,
  greeting      text,
  persona       text,
  instructions  text,
  keyterms      text[] not null default '{}',
  -- Why this version exists. An audit trail of values with no reasons answers "what" and
  -- never "why", and "why" is the question asked when a call goes wrong.
  note          text,
  published_by  text not null default session_user,
  published_at  timestamptz not null default now(),
  primary key (tenant_id, version)
);

-- ---------------------------------------------------------------------------
-- Backfill: version 1 is whatever is in `tenants` right now
-- ---------------------------------------------------------------------------

-- Without this, the first publish creates version N+1 and every call before it points at
-- a version with no row — the exact gap this migration exists to close, left open at the
-- boundary.
--
-- Before RLS is enabled on the table, not after, and that ordering is the whole point.
-- After, this statement would depend on the migration role holding BYPASSRLS: with it the
-- backfill works, without it the policy filters every row and the insert quietly does
-- nothing. A backfill that silently inserts zero rows and reports success is the worst
-- available outcome, and 0002 exists because exactly that class of assumption about role
-- attributes turned out to be wrong.
insert into tenant_prompt_versions
  (tenant_id, version, name, voice_id, greeting, persona, instructions, keyterms, note)
select id, config_version, name, voice_id, greeting, persona, instructions, keyterms,
       'backfilled from tenants by migration 0011'
  from tenants
on conflict (tenant_id, version) do nothing;

alter table tenant_prompt_versions enable row level security;
alter table tenant_prompt_versions force  row level security;
drop policy if exists tenant_isolation on tenant_prompt_versions;
create policy tenant_isolation on tenant_prompt_versions
  using (tenant_id = app.current_tenant())
  with check (tenant_id = app.current_tenant());

-- SELECT and INSERT only. No UPDATE, no DELETE: see the header.
grant select, insert on tenant_prompt_versions to ansa_app;

-- ---------------------------------------------------------------------------
-- Publishing a version
-- ---------------------------------------------------------------------------

/*
 * Bumps the current config and snapshots it, atomically, and returns the new version.
 *
 * SECURITY INVOKER on purpose. Everything it touches is the caller's own tenant under
 * RLS, so there is nothing here that needs the owner's privileges — and the two functions
 * in 0004 and 0005 that DO run as owner are narrow reads keyed on an identifier the
 * caller already holds. Widening that pattern to a write would be a much larger promise.
 *
 * The tenant scope must already be set. That is not ceremony: without it the RLS policy
 * would reject the write anyway, and failing with a sentence beats failing with
 * "new row violates row-level security policy".
 */
create or replace function app.publish_tenant_config(
  tenant          uuid,
  p_name          text,
  p_voice_id      text,
  p_greeting      text,
  p_persona       text,
  p_instructions  text,
  p_keyterms      text[],
  p_note          text
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
     set name           = coalesce(p_name, name),
         voice_id       = p_voice_id,
         greeting       = p_greeting,
         persona        = p_persona,
         instructions   = p_instructions,
         keyterms       = coalesce(p_keyterms, '{}'),
         config_version = config_version + 1
   where id = tenant
   returning config_version into next_version;

  if next_version is null then
    raise exception 'no such tenant: %', tenant;
  end if;

  insert into tenant_prompt_versions
    (tenant_id, version, name, voice_id, greeting, persona, instructions, keyterms, note)
  select id, config_version, name, voice_id, greeting, persona, instructions, keyterms, p_note
    from tenants where id = tenant;

  return next_version;
end
$$;

revoke all on function app.publish_tenant_config(uuid, text, text, text, text, text, text[], text) from public;
grant execute on function app.publish_tenant_config(uuid, text, text, text, text, text, text[], text) to ansa_app;

-- ---------------------------------------------------------------------------
-- Reading a version back
-- ---------------------------------------------------------------------------

-- SECURITY INVOKER, so RLS applies: an old config is still that tenant's config, and
-- nobody else's.
create or replace function app.tenant_config_at_version(tenant uuid, v integer)
  returns table (
    id             uuid,
    name           text,
    keyterms       text[],
    voice_id       text,
    greeting       text,
    persona        text,
    instructions   text,
    config_version integer
  )
  language sql
  stable
as $$
  select p.tenant_id, p.name, p.keyterms, p.voice_id, p.greeting, p.persona,
         p.instructions, p.version
    from tenant_prompt_versions p
   where p.tenant_id = tenant and p.version = v
$$;

revoke all on function app.tenant_config_at_version(uuid, integer) from public;
grant execute on function app.tenant_config_at_version(uuid, integer) to ansa_app;

-- ---------------------------------------------------------------------------
-- The two hot-path readers, now carrying `instructions`
-- ---------------------------------------------------------------------------

-- DROP then CREATE, not CREATE OR REPLACE: the return type changes, and Postgres will
-- not replace a function whose OUT columns differ. Unchanged in every other respect —
-- same trust boundary, same one round trip, same grants. See 0003, 0004 and 0005 for why
-- these run as owner and why that is the narrowest thing that works.

drop function if exists app.tenant_config_for_number(text);
create function app.tenant_config_for_number(dialled text)
  returns table (
    id             uuid,
    name           text,
    keyterms       text[],
    voice_id       text,
    greeting       text,
    persona        text,
    instructions   text,
    config_version integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select t.id, t.name, t.keyterms, t.voice_id, t.greeting, t.persona, t.instructions,
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
    id             uuid,
    name           text,
    keyterms       text[],
    voice_id       text,
    greeting       text,
    persona        text,
    instructions   text,
    config_version integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select t.id, t.name, t.keyterms, t.voice_id, t.greeting, t.persona, t.instructions,
         t.config_version
    from tenants t
   where t.id = tenant
   limit 1
$$;

revoke all on function app.tenant_config_for_id(uuid) from public;
grant execute on function app.tenant_config_for_id(uuid) to ansa_app;
