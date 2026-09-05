-- Which organisations have a call waiting to be placed.
--
-- The dialler sweeps every organisation with work, and "which organisations" is a question no
-- organisation-scoped query can answer: RLS is doing its job, and the answer spans tenants by
-- definition. The codebase already has one shape for this — `app.claim_due_event_deliveries`
-- (0025) — and this follows it exactly rather than inventing a second: `security definer`, a
-- pinned `search_path`, and execute granted only to `ansa_app`.
--
-- It returns ids and nothing else. A function that returned the rows themselves would be a
-- cross-tenant read of contact phone numbers living outside RLS, and the dialler does not need
-- that: it takes the ids, opens a proper scope per organisation, and reads the queue through
-- the policies like everything else. The blast radius of this function is therefore "knows
-- which tenants are busy", which is the least it can know and still be useful.
--
-- The predicate is deliberately the same one `readDueScheduledCalls` uses, minus the batch:
-- pending, due, under a running campaign, and not past its attempt ceiling. An organisation
-- whose only rows are spent is not busy, and sweeping it every ten seconds to discover that
-- would be the cost of getting this wrong.

drop function if exists app.organizations_with_due_calls();
create or replace function app.organizations_with_due_calls()
  returns table(organization_id uuid)
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
  select distinct s.organization_id
    from scheduled_calls s
    join campaigns cp on cp.id = s.campaign_id
   where s.status = 'pending'
     and s.next_attempt_at is not null
     and s.next_attempt_at <= now()
     and cp.status = 'running'
     and s.attempts < cp.max_attempts
$function$;

revoke all on function app.organizations_with_due_calls() from public;
grant execute on function app.organizations_with_due_calls() to ansa_app;

comment on function app.organizations_with_due_calls() is
  'Ids only, for the dialler to then scope into properly. Spans tenants because the question does; returns nothing a caller could read a phone number from.';
