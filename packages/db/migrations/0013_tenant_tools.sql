-- The route to a tenant's own systems (Slice 6, R5.2).
--
-- Two things land here, and they are separate on purpose.
--
--   tenants.tool_config   what the organisation may be asked, and where we ask it. Not a
--                         secret: a URL, a JSON schema, a risk tier, a sentence with holes
--                         in it. Read on every call that uses a tool, and it changes what
--                         the agent can DO, so it is versioned alongside the prompt.
--
--   tenant_credentials    the secret behind the auth reference. Sealed before it gets
--                         here — AES-256-GCM with the tenant id and the ref bound into the
--                         tag, see packages/tools/src/connector/vault.ts — so this table
--                         holds ciphertext and the key lives only in the API process. A
--                         database dump is therefore not a credential leak.
--
-- Credentials are deliberately NOT versioned. Configuration history answers "why did the
-- agent say that three weeks ago?"; a history of every credential a tenant has ever held
-- answers nothing anybody needs and is a liability that grows on its own.
--
-- Nothing changes for any tenant until somebody publishes a tool_config. Null means the
-- agent has the three platform tools and no way to reach anyone's records, which is
-- exactly where Slice 5 left it.

alter table tenants add column if not exists tool_config jsonb;

-- Shape is validated in TypeScript (packages/tools/src/connector/config.ts) rather than
-- here, for the same reason persona and instructions are filtered on the way into the
-- prompt rather than on the way into the table: a row written by the onboarding script, by
-- a future admin UI, or by hand in psql then all get the same treatment. What the column
-- does refuse is a shape that could not possibly be a config.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_tool_config_is_object') then
    alter table tenants add constraint tenants_tool_config_is_object check (
      tool_config is null or jsonb_typeof(tool_config) = 'object'
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The credential store
-- ---------------------------------------------------------------------------

create table if not exists tenant_credentials (
  tenant_id  uuid        not null references tenants(id) on delete cascade,
  -- The name the tool config points at. Lower snake case, the same shape as a tool name.
  ref        text        not null,
  -- Ciphertext. `v1.<iv>.<tag>.<payload>`, all base64. Never a plaintext secret.
  sealed     text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, ref),
  constraint tenant_credentials_ref_shape check (ref ~ '^[a-z][a-z0-9_]{1,63}$'),
  -- A plaintext value written here by mistake would not match the sealed format, and the
  -- vault would refuse it later with a confusing error. Refuse it now instead.
  constraint tenant_credentials_is_sealed check (sealed like 'v1.%.%.%')
);

grant select, insert, update, delete on tenant_credentials to ansa_app;

alter table tenant_credentials enable row level security;
alter table tenant_credentials force  row level security;
drop policy if exists tenant_isolation on tenant_credentials;
create policy tenant_isolation on tenant_credentials
  using (tenant_id = app.current_tenant())
  with check (tenant_id = app.current_tenant());

-- ---------------------------------------------------------------------------
-- Versioned, because it changes what the agent can do
-- ---------------------------------------------------------------------------

alter table tenant_prompt_versions add column if not exists tool_config jsonb;

update tenant_prompt_versions p
   set tool_config = t.tool_config
  from tenants t
 where p.tenant_id = t.id
   and p.version = t.config_version
   and p.tool_config is null;

drop function if exists app.publish_tenant_config(uuid, text, text, text, text, text, text[], integer, integer, integer[], text);
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

  -- Whole config, never a patch. p_tool_config is applied as given, null included: a
  -- publish that omitted it and silently kept the last one would make the history a lie
  -- about which tools were reachable on a given call.
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
         config_version      = config_version + 1
   where id = tenant
   returning config_version into next_version;

  if next_version is null then
    raise exception 'no such tenant: %', tenant;
  end if;

  insert into tenant_prompt_versions
    (tenant_id, version, name, voice_id, greeting, persona, instructions, keyterms,
     business_open_hour, business_close_hour, business_days, tool_config, note)
  select id, config_version, name, voice_id, greeting, persona, instructions, keyterms,
         business_open_hour, business_close_hour, business_days, tool_config, p_note
    from tenants where id = tenant;

  return next_version;
end
$$;

revoke all on function app.publish_tenant_config(uuid, text, text, text, text, text, text[], integer, integer, integer[], jsonb, text) from public;
grant execute on function app.publish_tenant_config(uuid, text, text, text, text, text, text[], integer, integer, integer[], jsonb, text) to ansa_app;

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
    config_version      integer
  )
  language sql
  stable
as $$
  select p.tenant_id, p.name, p.keyterms, p.voice_id, p.greeting, p.persona,
         p.instructions, p.business_open_hour, p.business_close_hour, p.business_days,
         p.tool_config, p.version
    from tenant_prompt_versions p
   where p.tenant_id = tenant and p.version = v
$$;

revoke all on function app.tenant_config_at_version(uuid, integer) from public;
grant execute on function app.tenant_config_at_version(uuid, integer) to ansa_app;

-- ---------------------------------------------------------------------------
-- The one-round-trip readers learn about both
-- ---------------------------------------------------------------------------

-- DROP then CREATE, not CREATE OR REPLACE: the return type changes. See 0003, 0004, 0005,
-- 0011 and 0012, all of which say the same thing for the same reason.
--
-- The sealed credentials come back on the same row, aggregated. That is one round trip
-- instead of two on the answer path (0004 measured the two-step version at two seconds),
-- and it is safe because what travels is ciphertext the database cannot open: the key is
-- in the API process. SECURITY DEFINER is unchanged — resolution has to answer "which
-- tenant?" before there is a tenant scope to set, which is the whole reason these
-- functions exist.

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
         (select jsonb_object_agg(c.ref, c.sealed)
            from tenant_credentials c where c.tenant_id = t.id),
         t.config_version
    from tenants t
   where t.id = tenant
   limit 1
$$;

revoke all on function app.tenant_config_for_id(uuid) from public;
grant execute on function app.tenant_config_for_id(uuid) to ansa_app;
