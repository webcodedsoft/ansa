-- Row Level Security. This file is the isolation boundary; application code is not.
--
-- Two things have to be true for a policy to actually apply, and only the first is
-- obvious:
--
--   1. ENABLE ROW LEVEL SECURITY  — turns policies on for other roles.
--   2. FORCE ROW LEVEL SECURITY   — applies them to the table OWNER too. Without this,
--      anything connecting as the owner (Supabase's `postgres`, which owns everything
--      created here) bypasses every policy silently. The policies would exist, read
--      correctly in review, and enforce nothing.
--
-- The app connects as `ansa_app`, which owns nothing. FORCE is belt and braces.

-- ---------------------------------------------------------------------------
-- Application role
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ansa_app') then
    -- No password: this role is reached by SET ROLE / GRANT from the connecting user.
    -- A password is added by the operator if it is ever connected to directly.
    create role ansa_app nologin;
  end if;
end
$$;

grant usage on schema public, app to ansa_app;
grant execute on function app.current_tenant() to ansa_app;

grant select, insert, update, delete on
  tenants, calls, call_events, turns, transcripts, tool_invocations, latencies, audio_segments
  to ansa_app;

grant usage, select on all sequences in schema public to ansa_app;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

-- `tenants` is keyed by the tenant itself, so isolation compares the primary key.
alter table tenants enable row level security;
alter table tenants force  row level security;
drop policy if exists tenant_isolation on tenants;
create policy tenant_isolation on tenants
  using (id = app.current_tenant())
  with check (id = app.current_tenant());

-- Every other table carries tenant_id and is compared against the transaction's tenant.
--
-- WITH CHECK matters as much as USING: USING filters what a statement can see, WITH
-- CHECK constrains what it can write. Without it a tenant could insert or update a row
-- stamped with someone else's tenant_id — invisible to them afterwards, and a leak.
do $$
declare
  t text;
begin
  foreach t in array array[
    'calls', 'call_events', 'turns', 'transcripts',
    'tool_invocations', 'latencies', 'audio_segments'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app.current_tenant())
         with check (tenant_id = app.current_tenant())', t);
  end loop;
end
$$;
