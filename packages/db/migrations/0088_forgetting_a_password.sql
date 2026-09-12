-- Resetting a password you have forgotten.
--
-- The console had no way back in: a forgotten password was a support ticket, and the only
-- writer of `users.password_hash` after sign-up was the signed-in person themselves. This is
-- the way back, and it is built the way sign-in is — unauthenticated, through definer
-- functions, and telling an outsider nothing.
--
-- `password_resets` holds one row per link sent: the SHA-256 of the secret in the link (the
-- secret itself is never stored, as with sessions and invitations), when it expires, and
-- when it was used. `ansa_app` cannot read or write the table at all — every access goes
-- through the two functions below, each of which does one narrow thing.
--
-- `begin_password_reset` answers the same way for an address with an account and one
-- without: it returns nothing, and the API answers 204 in both cases, so the form cannot be
-- used to learn who has an account. When there is an account, earlier unused links are
-- retired first — one live link per person, the latest.
--
-- `redeem_password_reset` takes the hash of a link and a new password hash. If the link is
-- live it sets the password, marks the link used and revokes every session the person
-- holds: whoever had their old password may have been signed in, and a reset is the moment
-- to be sure they are not.

create table if not exists password_resets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  bytea not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create unique index if not exists password_resets_token_hash_key on password_resets (token_hash);
create index if not exists password_resets_user_idx on password_resets (user_id, created_at desc);

-- Locked to the application role entirely: no policy, no grant. Only the definer functions
-- below can reach it.
alter table password_resets enable row level security;
alter table password_resets force row level security;

create function app.begin_password_reset(p_email text, p_token_hash bytea, p_expires_at timestamptz)
returns table(user_id uuid, display_name text)
language plpgsql
volatile security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  uid   uuid;
  dname text;
begin
  select u.id, u.display_name into uid, dname
    from users u
   where u.email = lower(p_email) and u.deleted_at is null;
  if uid is null then
    return;
  end if;

  update password_resets set used_at = now()
   where password_resets.user_id = uid and used_at is null;

  insert into password_resets (user_id, token_hash, expires_at)
  values (uid, p_token_hash, p_expires_at);

  return query select uid, dname;
end;
$fn$;

create function app.redeem_password_reset(p_token_hash bytea, p_password_hash text, p_now timestamptz)
returns uuid
language plpgsql
volatile security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  uid uuid;
begin
  select r.user_id into uid
    from password_resets r
   where r.token_hash = p_token_hash
     and r.used_at is null
     and r.expires_at > p_now;
  if uid is null then
    return null;
  end if;

  update users set password_hash = p_password_hash
   where id = uid and deleted_at is null;
  if not found then
    return null;
  end if;

  update password_resets set used_at = p_now
   where password_resets.user_id = uid and used_at is null;

  update sessions set revoked_at = p_now
   where sessions.user_id = uid and revoked_at is null;

  return uid;
end;
$fn$;

revoke all on function app.begin_password_reset(text, bytea, timestamptz) from public;
revoke all on function app.redeem_password_reset(bytea, text, timestamptz) from public;
grant execute on function app.begin_password_reset(text, bytea, timestamptz) to ansa_app;
grant execute on function app.redeem_password_reset(bytea, text, timestamptz) to ansa_app;
