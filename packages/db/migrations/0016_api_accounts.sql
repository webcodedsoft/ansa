-- Sign-in for the tenant dashboard: people, the organisations they belong to, the
-- sessions that prove it, and the invitations that create them.
--
-- Everything here is subject to the same rule as the call path (CLAUDE.md rule 3): the
-- database enforces isolation, application code does not. Three of the four tables carry
-- `tenant_id` and get the standard policy. `users` is the exception and the interesting
-- one, so it is explained where it is defined.
--
-- There is no `organisations` table. An organisation IS a row in `tenants` — the same row
-- the carrier resolves a dialled number to. A parallel table would be a second source of
-- truth for "who is this customer", and the first time the two disagreed it would be in
-- production. `memberships` is what makes a tenant an organisation people can sign in to.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- A person, not a membership. The same human works for two organisations with one
-- password, so this row is global and `memberships` is what scopes them.
--
-- That means `users` cannot isolate on `tenant_id`, because it does not have one. It
-- isolates on reachability instead: inside a tenant's scope you can see exactly the
-- people who belong to that tenant, which is the same guarantee stated over a join. See
-- the policy at the bottom of this file.
create table if not exists users (
  id             uuid primary key default gen_random_uuid(),
  -- Lowercased on the way in so "A@b.com" and "a@b.com" cannot become two accounts. The
  -- constraint is here as well as in the application because there is no citext on this
  -- database and a second writer would otherwise be free to disagree.
  email          text not null constraint users_email_is_lower check (email = lower(email)),
  -- scrypt, encoded as `scrypt$N$r$p$<salt b64>$<key b64>`. The parameters travel with
  -- the hash so raising them later does not invalidate every existing password.
  password_hash  text not null,
  display_name   text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists users_email_key on users (email);

-- Which organisations a person belongs to, and what they may do there.
--
-- Three roles, deliberately. Two would need replacing the first time an organisation
-- wants someone who can configure the agent but not remove colleagues, which is the
-- ordinary shape of a support team. Capabilities are a code-level map over these
-- (apps/api/src/api/auth/capability.ts), so a fourth role is one table entry and a check
-- constraint rather than a search for `role === "owner"`.
create table if not exists memberships (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  role        text not null check (role in ('owner', 'admin', 'member')),
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index if not exists memberships_user_idx on memberships (user_id);

-- One session belongs to one organisation, not to a person.
--
-- That is what removes the "which tenant is this request for" question from the API
-- surface entirely: the tenant is a property of the credential, so no header, query
-- parameter or path segment can name a different one. Signing in to a second
-- organisation mints a second session.
--
-- `token_hash` is SHA-256 of a 256-bit random secret, not a KDF. A KDF defends a
-- low-entropy secret against offline guessing; there is nothing to guess here, and a
-- per-request scrypt on the hot path would be a self-inflicted denial of service.
create table if not exists sessions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  token_hash    bytea not null,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  -- Set rather than deleted, so "who was signed in when this happened" survives a
  -- sign-out. Revocation is checked on every request; a revoked row is inert.
  revoked_at    timestamptz
);

create unique index if not exists sessions_token_hash_key on sessions (token_hash);
create index if not exists sessions_owner_idx on sessions (tenant_id, user_id, created_at desc);
create index if not exists sessions_expiry_idx on sessions (expires_at);

-- Single-use and expiring, both enforced below rather than asked for politely.
create table if not exists invitations (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  email             text not null constraint invitations_email_is_lower check (email = lower(email)),
  role              text not null check (role in ('owner', 'admin', 'member')),
  token_hash        bytea not null,
  invited_by        uuid references users(id) on delete set null,
  expires_at        timestamptz not null,
  accepted_at       timestamptz,
  accepted_user_id  uuid references users(id) on delete set null,
  revoked_at        timestamptz,
  created_at        timestamptz not null default now()
);

create unique index if not exists invitations_token_hash_key on invitations (token_hash);
create index if not exists invitations_listing_idx on invitations (tenant_id, created_at desc);

-- One live invitation per address per organisation. Re-inviting revokes and reissues
-- rather than leaving two valid tokens where only one was ever intended to work.
create unique index if not exists invitations_pending_key
  on invitations (tenant_id, email)
  where accepted_at is null and revoked_at is null;

-- ---------------------------------------------------------------------------
-- An organisation cannot lose its last owner
-- ---------------------------------------------------------------------------

-- Enforced here and not in the handler for the same reason risk tiers are enforced in the
-- dispatch path: a check in one of two write paths is a check that will be missing from
-- the third. Deferred, so demoting yourself while promoting a colleague in one
-- transaction is allowed and the intermediate state is not.
create or replace function app.memberships_keep_an_owner() returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
declare
  affected uuid;
begin
  affected := case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end;

  -- Deleting the organisation cascades to its memberships, and an organisation that no
  -- longer exists cannot be short of an owner. Checked at commit time, because the
  -- trigger is deferred, so by here the tenant row is already gone.
  if not exists (select 1 from tenants t where t.id = affected) then
    return null;
  end if;

  if not exists (
    select 1 from memberships m where m.tenant_id = affected and m.role = 'owner'
  ) then
    raise exception 'an organisation must keep at least one owner';
  end if;
  return null;
end
$$;

drop trigger if exists memberships_keep_an_owner on memberships;
create constraint trigger memberships_keep_an_owner
  after update or delete on memberships
  deferrable initially deferred
  for each row execute function app.memberships_keep_an_owner();

-- ---------------------------------------------------------------------------
-- The sign-in door
-- ---------------------------------------------------------------------------
--
-- Authentication is the one thing that cannot happen inside a tenant scope, because
-- which tenant is the answer rather than the question. Rather than leave the API with a
-- general-purpose unscoped connection — which every later endpoint would then be one
-- careless line away from using — the whole of the pre-authentication surface is these
-- two functions. They take an email and a user id, they return exactly what sign-in
-- needs, and there is no way to ask them anything else.
--
-- Same trust boundary as app.tenant_config_for_number (0004): security definer, granted
-- to ansa_app only, revoked from public.

create or replace function app.credentials_for_email(p_email text)
  returns table (user_id uuid, password_hash text)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select u.id, u.password_hash from users u where u.email = lower(p_email) limit 1
$$;

revoke all on function app.credentials_for_email(text) from public;
grant execute on function app.credentials_for_email(text) to ansa_app;

-- Called only after the password verified, so it is not an enumeration oracle.
create or replace function app.organisations_for_user(p_user uuid)
  returns table (tenant_id uuid, name text, role text)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select t.id, t.name, m.role
    from memberships m
    join tenants t on t.id = m.tenant_id
   where m.user_id = p_user
   order by t.name
$$;

revoke all on function app.organisations_for_user(uuid) from public;
grant execute on function app.organisations_for_user(uuid) to ansa_app;

-- ---------------------------------------------------------------------------
-- Accepting an invitation
-- ---------------------------------------------------------------------------
--
-- One statement, so single-use is a fact rather than a race. The `accepted_at is null`
-- in the UPDATE is what makes two simultaneous redemptions produce one membership: the
-- second finds no row.
--
-- The tenant is read off the invitation and returned, never taken as an argument. A
-- caller who guesses a token cannot also choose which organisation it joins them to.
--
-- An address that already has an account joins with the password it already has; the one
-- supplied here is ignored. Being able to reset a stranger's password by inviting them
-- would be a takeover, and the invited person has an account precisely because they
-- already chose one.
-- Dropped first: `create or replace` cannot change a function's OUT parameter names, and
-- re-running this migration after they changed would fail with "cannot change return type
-- of existing function" rather than replacing it.
drop function if exists app.accept_invitation(bytea, text, text, timestamptz);

create or replace function app.accept_invitation(
  p_token_hash    bytea,
  p_password_hash text,
  p_display_name  text,
  p_now           timestamptz
)
  -- Prefixed, because an OUT parameter named `tenant_id` is in scope for every statement
  -- in the body and makes `insert into memberships (tenant_id, …)` ambiguous. Postgres
  -- says so at call time, not at definition time.
  returns table (out_tenant_id uuid, out_user_id uuid, out_role text, out_created_user boolean)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
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
  returning i.id, i.tenant_id, i.email, i.role into invite;

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

  insert into memberships (tenant_id, user_id, role)
    values (invite.tenant_id, joined, invite.role)
    on conflict (tenant_id, user_id) do update set role = excluded.role;

  update invitations set accepted_user_id = joined where id = invite.id;

  return query select invite.tenant_id, joined, invite.role, is_new;
end
$$;

revoke all on function app.accept_invitation(bytea, text, text, timestamptz) from public;
grant execute on function app.accept_invitation(bytea, text, text, timestamptz) to ansa_app;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- No INSERT on `users`: the only way a person comes into existence is by redeeming an
-- invitation, which happens inside app.accept_invitation. The policy below would refuse
-- the insert anyway — this is the same rule said twice, on purpose.
grant select, update on users to ansa_app;
grant select, insert, update, delete on memberships, sessions, invitations to ansa_app;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

-- The membership join is the whole of the `users` policy, and it is worth being precise
-- about what it does and does not promise.
--
-- It promises: inside tenant A's scope, a query against `users` — any query, including
-- one a future endpoint writes carelessly — returns only people who belong to tenant A.
-- A person who belongs to A and B is visible in both, which is correct: they are the
-- same person and both organisations know them.
--
-- It does not promise that A learns nothing about B from that row. If a shared user
-- changes their display name, both organisations see it. That is inherent in one account
-- across two organisations and is the cost of not making people keep two passwords.
alter table users enable row level security;
alter table users force  row level security;
drop policy if exists tenant_isolation on users;
create policy tenant_isolation on users
  using (exists (
    select 1 from memberships m
     where m.user_id = users.id and m.tenant_id = app.current_tenant()
  ))
  with check (exists (
    select 1 from memberships m
     where m.user_id = users.id and m.tenant_id = app.current_tenant()
  ));

do $$
declare
  t text;
begin
  foreach t in array array['memberships', 'sessions', 'invitations']
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
