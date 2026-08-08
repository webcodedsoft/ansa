-- Per-tenant configuration, versioned, and the resolution path into it.
--
-- R7.5 requires config to be versioned and the version recorded on every call, so a call
-- from three weeks ago can still be explained. `calls.config_version` already exists for
-- that and is finally populated by this.

alter table tenants add column if not exists dialled_number  text;
alter table tenants add column if not exists voice_id        text;
alter table tenants add column if not exists greeting        text;
alter table tenants add column if not exists persona         text;
-- Vocabulary the transcriber should expect: this tenant's products, staff names, local
-- place names (R4.1.3). Proven on live calls to be what makes "policy" heard correctly.
alter table tenants add column if not exists keyterms        text[] not null default '{}';
alter table tenants add column if not exists config_version  integer not null default 1;

create unique index if not exists tenants_dialled_number_idx
  on tenants (dialled_number) where dialled_number is not null;

-- ---------------------------------------------------------------------------
-- Resolving a call to a tenant, before a tenant is known
-- ---------------------------------------------------------------------------

/*
 * The chicken-and-egg of R7.3.
 *
 * Every table is under RLS keyed on `app.current_tenant()`, and a policy that fails
 * closed is the whole point (see 0002). But at call ingress we have only the number that
 * was dialled — the tenant is precisely what we are trying to find out, so there is no
 * tenant context to set and the policy correctly returns nothing.
 *
 * SECURITY DEFINER resolves it in the narrowest way available: the function runs as its
 * owner, so it can see the row, but it returns ONLY the id. No name, no config, no
 * credentials — nothing a caller could learn from probing it with numbers beyond whether
 * a number is served, which the act of answering the phone already reveals.
 *
 * search_path is pinned because a SECURITY DEFINER function with a mutable search_path is
 * a privilege-escalation hole.
 */
create or replace function app.tenant_for_number(dialled text) returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select id from tenants where dialled_number = dialled limit 1
$$;

revoke all on function app.tenant_for_number(text) from public;
grant execute on function app.tenant_for_number(text) to ansa_app;
