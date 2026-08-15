-- Every organisation has at least one agent, from the moment it exists.
--
-- Migration 0018 backfilled one agent per tenant and then left the invariant undefended.
-- It held for every organisation that existed when 0018 ran, and for none created after:
-- `app.create_organisation` inserts a tenant and a membership and stops there, so a
-- self-serve sign-up produced an organisation with no agent. That organisation could not
-- publish — 0023 raises "no live agent to publish to" — and its agent list was empty on a
-- screen whose entire job is to list agents.
--
-- A trigger rather than another line in `app.create_organisation`, for the reason the risk
-- tiers give: there is more than one door. Sign-up goes through the function, the database
-- tests insert into `tenants` directly, and an operator onboarding somebody by hand does
-- too. Three call sites that must each remember is three chances to forget, and the way it
-- fails is quiet — a working-looking organisation that cannot be configured.
--
-- Named after the organisation, exactly as 0018's backfill did, so an organisation created
-- before and one created after are indistinguishable afterwards.

create or replace function app.create_default_agent() returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  -- No number: numbers are assigned by an operator into `tenant_numbers` (0019), and this
  -- trigger has no business claiming one. The agent is created written and unrouted.
  insert into agents (tenant_id, name)
  values (new.id, new.name);
  return new;
end
$$;

revoke all on function app.create_default_agent() from public;

drop trigger if exists tenants_get_an_agent on tenants;
create trigger tenants_get_an_agent
  after insert on tenants
  for each row
  execute function app.create_default_agent();

-- ---------------------------------------------------------------------------
-- And close the gap for anything created between 0018 and this migration
-- ---------------------------------------------------------------------------

-- Before RLS could filter it: this runs as the migration role and must see every tenant,
-- for the reason 0011 and 0018 both spell out.
insert into agents (tenant_id, name)
select t.id, t.name
  from tenants t
 where not exists (select 1 from agents a where a.tenant_id = t.id);
