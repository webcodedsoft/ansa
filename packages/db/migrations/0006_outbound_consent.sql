-- Who a tenant is allowed to call, and when.
--
-- CLAUDE.md puts consent in the dispatch path for the same reason risk tiers are there:
-- a tenant configuring "call these numbers" must not be able to configure the check away.
-- Storing it as data a tenant edits would do exactly that, so the tables record evidence
-- and the policy that reads them lives in code.
--
-- Fails closed. A number with no consent row is not callable, because the absence of a
-- record is exactly what an unlawful call looks like from the outside.

create table if not exists outbound_consent (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  -- E.164. Not unique on its own: the same person may consent to two tenants separately,
  -- and one tenant's consent is not another's.
  phone_number text not null,
  -- How consent was obtained, in words a regulator would accept. Free text on purpose:
  -- an enum here would be a guess about evidence we have not collected yet.
  basis        text not null,
  granted_at   timestamptz not null default now(),
  -- Set when consent is withdrawn. Withdrawal is a new fact, not a deletion: proving a
  -- call was lawful when it was placed requires the history.
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  unique (tenant_id, phone_number, granted_at)
);

create index if not exists outbound_consent_lookup_idx
  on outbound_consent (tenant_id, phone_number);

create table if not exists do_not_call (
  id           uuid primary key default gen_random_uuid(),
  -- Null means every tenant. A person who asks not to be called should not have to ask
  -- each tenant separately.
  tenant_id    uuid references tenants(id) on delete cascade,
  phone_number text not null,
  reason       text,
  created_at   timestamptz not null default now()
);

create unique index if not exists do_not_call_number_idx
  on do_not_call (coalesce(tenant_id::text, 'global'), phone_number);

alter table outbound_consent enable row level security;
alter table outbound_consent force row level security;
alter table do_not_call      enable row level security;
alter table do_not_call      force row level security;

create policy outbound_consent_tenant on outbound_consent
  using (tenant_id = app.current_tenant())
  with check (tenant_id = app.current_tenant());

-- Readable across tenants only where tenant_id is null: a global suppression is meant to
-- be seen by everyone. Writing one is not possible through this policy.
create policy do_not_call_tenant on do_not_call
  using (tenant_id = app.current_tenant() or tenant_id is null)
  with check (tenant_id = app.current_tenant());

grant select, insert, update on outbound_consent to ansa_app;
grant select, insert on do_not_call to ansa_app;
