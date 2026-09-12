-- Revoking somebody's access without removing them.
--
-- Removal (0032) soft-deletes the membership: they are gone from the list and their name stays
-- on what they did. That is the right shape for somebody who has left. It is the wrong shape
-- for somebody whose access has to stop today and may come back — a contractor between
-- engagements, a phone that was lost, a person under review. Removing and re-inviting them
-- loses the role they held and the date they joined, and asks them to accept a link.
--
-- `suspended_at` is the middle state. A suspended membership still stands — it is listed,
-- it keeps its role and its joined date — but it authenticates nothing: the session join in
-- `findSessionByToken` requires it null, so an open session dies on its next request, and
-- `organisations_for_user` skips it, so signing in again does not offer this organisation.
-- Clearing the column restores everything as it was.
--
-- The last-owner rule counts suspended owners as absent. An organisation whose only owner
-- cannot sign in has nobody who can administer it, which is exactly the state the rule
-- exists to refuse.

alter table memberships add column if not exists suspended_at timestamptz;

comment on column memberships.suspended_at is
  'Set while the person''s access is revoked. The membership stands — role and joined date kept — but no session authenticates through it and sign-in does not offer the organisation. Null restores it.';

create or replace function app.organisations_for_user(p_user uuid)
returns table(organization_id uuid, name text, role text)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $fn$
  select t.id, t.name, m.role
    from memberships m
    join organizations t on t.id = m.organization_id
   where m.user_id = p_user
     and m.deleted_at is null
     and m.suspended_at is null
     and t.deleted_at is null
   order by t.name
$fn$;

create or replace function app.memberships_keep_an_owner() returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $fn$
declare
  affected uuid;
begin
  affected := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;

  if not exists (
    select 1 from organizations t where t.id = affected and t.deleted_at is null
  ) then
    return null;
  end if;

  if not exists (
    select 1 from memberships m
     where m.organization_id = affected
       and m.role = 'owner'
       and m.deleted_at is null
       and m.suspended_at is null
  ) then
    raise exception 'an organisation must keep at least one owner';
  end if;
  return null;
end
$fn$;
