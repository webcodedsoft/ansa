-- Ending every other session a person holds, everywhere, when they change their password.
--
-- A changed password is a person saying "whoever else has my credentials should be out".
-- That has to reach every organisation they belong to, and a scoped transaction reaches one:
-- `sessions` is isolated by `organization_id`, so an update from inside organisation A cannot
-- see the session the same person holds in organisation B. This is the definer function that
-- can — the same reasoning as `app.organisations_for_user`, which crosses organisations for a
-- sign-in list for the same person.
--
-- The guard is the session being kept. The caller must name a live session that belongs to
-- the user in question — which is the session making the request — so holding somebody's
-- id is not enough to sign them out of everything; you have to be them. Nothing is deleted:
-- revoked rows stay for "who was signed in when", as they do for sign-out.

create function app.end_other_sessions(p_user uuid, p_keep uuid)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  ended integer;
begin
  if not exists (
    select 1 from sessions k
     where k.id = p_keep and k.user_id = p_user and k.revoked_at is null and k.expires_at > now()
  ) then
    return 0;
  end if;

  update sessions s
     set revoked_at = now()
   where s.user_id = p_user
     and s.id <> p_keep
     and s.revoked_at is null;
  get diagnostics ended = row_count;
  return ended;
end
$fn$;

revoke execute on function app.end_other_sessions(uuid, uuid) from public;
grant execute on function app.end_other_sessions(uuid, uuid) to ansa_app;
