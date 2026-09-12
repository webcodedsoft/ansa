-- A person closing their own account.
--
-- Nothing could do this. `users.deleted_at` has existed since 0032 and honoured everywhere a
-- deleted person could otherwise still act — sign-in, the session join, the users policy —
-- but the only writer was an operator at a psql prompt. This is the writer, and it is a
-- definer function for the reason `end_other_sessions` (0084) is: a person's memberships and
-- sessions span organisations, and a scoped transaction sees one.
--
-- What closing does, in order:
--
-- 1. Refuses if they are the only owner anywhere. An organisation whose one owner walks out
--    has nobody left who can administer it. The names come back so the person can be told
--    which, and nothing is written. (The deferred trigger would refuse too, at commit, with
--    a message naming no organisation — this says which.)
-- 2. Ends every membership. Soft, as removal is (0032): the row keeps their name on what
--    they did.
-- 3. Ends every session, including the one making the request. There is no account to be
--    signed in to.
-- 4. Marks the user deleted and frees the address. `users_email_key` is a plain unique
--    index, and every sign-up path looks an address up without regard to `deleted_at`, so a
--    closed account would otherwise hold its address forever — the person could neither sign
--    in (deleted) nor sign up again (taken). Moving the address to a reserved form releases
--    it, and is also what a person closing an account expects to happen to their address.
--    The display name stays, because the audit trail and the members list of the past point
--    at it.
--
-- The guard is the session being kept alive to make the request: it must belong to the user,
-- so an id alone cannot close somebody else's account.

create function app.close_account(p_user uuid, p_keep uuid)
returns text[]
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  sole_owner_of text[];
begin
  if not exists (
    select 1 from sessions k
     where k.id = p_keep and k.user_id = p_user and k.revoked_at is null and k.expires_at > now()
  ) then
    raise exception 'close_account needs the caller''s own live session';
  end if;

  select coalesce(array_agg(o.name order by o.name), '{}') into sole_owner_of
    from memberships m
    join organizations o on o.id = m.organization_id
   where m.user_id = p_user
     and m.role = 'owner'
     and m.deleted_at is null
     and m.suspended_at is null
     and o.deleted_at is null
     and not exists (
       select 1 from memberships other
        where other.organization_id = m.organization_id
          and other.user_id <> p_user
          and other.role = 'owner'
          and other.deleted_at is null
          and other.suspended_at is null
     );

  if cardinality(sole_owner_of) > 0 then
    return sole_owner_of;
  end if;

  update memberships set deleted_at = now()
   where user_id = p_user and deleted_at is null;

  update sessions set revoked_at = now()
   where user_id = p_user and revoked_at is null;

  update users
     set deleted_at = now(),
         email = 'closed+' || p_user::text || '@account.invalid'
   where id = p_user and deleted_at is null;

  return '{}';
end
$fn$;

revoke execute on function app.close_account(uuid, uuid) from public;
grant execute on function app.close_account(uuid, uuid) to ansa_app;
