-- The other end of the run.
--
-- 0069 gave a campaign a start. This gives it a stop, and the two together are the range an
-- operator actually thinks in: "ring these people between Tuesday morning and Friday
-- evening". Null is unchanged behaviour — run until the list is exhausted or somebody pauses
-- it — and is what every existing campaign has.
--
-- Not a nicety. A reminder about Friday's viewing is worthless on Saturday and worse than
-- worthless to the person receiving it, and nothing today bounds the tail: three attempts
-- four hours apart is the default, but a number that keeps ringing out trails for days. An
-- end date is the same kind of rule as the consent gate — a campaign nobody is watching
-- stops itself, in code, rather than relying on somebody remembering.
--
-- Finishing is a promotion, mirroring `start_due_campaigns` exactly. The due-call query and
-- `organizations_with_due_calls` both require `cp.status = 'running'`, so moving an expired
-- campaign to `done` takes it out of every sweep without either of them learning a second
-- rule. `done` is already terminal in the status control and already rendered.
--
-- What it does not do is reach into calls already placed. A call in flight when the clock
-- passes finishes normally; this stops new ones. Cutting a live conversation off mid-sentence
-- to honour an end time would be the wrong trade by a wide margin.

alter table campaigns
  add column if not exists ends_at timestamptz;

comment on column campaigns.ends_at is
  'When a campaign stops dialling, whatever is left on the list. Null runs until the list is exhausted. app.finish_expired_campaigns() moves running to done once this has passed; calls already placed are not interrupted.';

/* Both ends or either, but never back to front. A range that ends before it begins would
   start and finish on the same sweep, which reads as a campaign that silently did nothing. */
alter table campaigns
  drop constraint if exists campaigns_run_window_check;
alter table campaigns
  add constraint campaigns_run_window_check
  check (starts_at is null or ends_at is null or ends_at > starts_at);

create index if not exists campaigns_due_to_finish_idx
  on campaigns (ends_at)
  where status = 'running' and ends_at is not null;

/**
 * Stop every campaign whose end has passed.
 *
 * `security definer` and unscoped for the reason its sibling gives: the sweeper runs on a
 * timer holding no organisation, and looping all of them to find the few with work would be
 * the same query a hundred times. It takes no arguments, so there is nothing a caller can
 * point it at, and `ansa_app` reaches it only through the grant below.
 *
 * Returns what it stopped so the sweeper can log it, which is the moment somebody will later
 * want to find: "why did this stop dialling on Friday".
 */
drop function if exists app.finish_expired_campaigns();
create or replace function app.finish_expired_campaigns()
  returns table(campaign_id uuid, organization_id uuid)
  language sql
  volatile
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
  update campaigns
     set status = 'done', updated_at = now()
   where status = 'running'
     and ends_at is not null
     and ends_at <= now()
  returning id, organization_id
$function$;

revoke all on function app.finish_expired_campaigns() from public;
grant execute on function app.finish_expired_campaigns() to ansa_app;
