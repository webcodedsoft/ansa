-- The two reads where a soft delete has to bite immediately.
--
-- 0032 added the columns and fixed the policy, the member list and the session join. These
-- are the other two places a deleted row would otherwise keep working, and both are reached
-- without a session — so neither is covered by the checks that hang off one.

/*
 * Signing in.
 *
 * A deleted user must not be able to authenticate, and the lookup happens before there is a
 * session or an organisation scope, so nothing else would catch it. Returning no row makes
 * this indistinguishable from a wrong address, which is also the right answer to give: it
 * does not tell an attacker whether an account ever existed.
 */
create or replace function app.credentials_for_email(p_email text)
returns table(user_id uuid, password_hash text)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $fn$
  select u.id, u.password_hash
    from users u
   where u.email = lower(p_email)
     and u.deleted_at is null
   limit 1
$fn$;

/*
 * Answering a call.
 *
 * `agent_config_for_number` already skips a deleted agent. A deleted *organisation* is the
 * other half: its numbers are still registered and still route, so without this the carrier
 * would connect a caller to an organisation that no longer exists. Returning nothing makes
 * the number behave as an unregistered one, which is the honest outcome and a path the
 * gateway already handles.
 */
create or replace function app.organization_for_number(dialled text)
returns uuid
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $fn$
  select a.organization_id
    from agents a
    join organizations o on o.id = a.organization_id
   where a.dialled_number = dialled
     and a.deleted_at is null
     and o.deleted_at is null
   limit 1
$fn$;
