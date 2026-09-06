-- When a campaign begins, rather than the moment somebody presses a button.
--
-- `scheduled` already existed as a status and did not mean what its name says: it meant
-- "queued, waiting for a person to press Start". A campaign for Tuesday morning had to be
-- started on Tuesday morning, by somebody who remembered. This is the missing column.
--
-- Null keeps today's behaviour exactly — start it by hand — and that is the default, so no
-- existing campaign changes. A time means the sweeper starts it.
--
-- Why promotion rather than a wider due-call query. `readDueScheduledCalls` and
-- `organizations_with_due_calls` both key off `cp.status = 'running'`, as does the console,
-- the status control and every test. Teaching each of them about a second way to be dialable
-- is four places to get it wrong; flipping the status once is one, and it leaves `running`
-- meaning what it has always meant. The campaign visibly becomes running, which is also the
-- honest thing to show an operator.
--
-- No check that `starts_at` is in the future. A time that has passed means "start now", which
-- is the sane reading and avoids refusing a request over a few seconds of clock skew between
-- the console and the database.

alter table campaigns
  add column if not exists starts_at timestamptz;

comment on column campaigns.starts_at is
  'When a scheduled campaign should begin dialling. Null means it is started by hand, which is the default. app.start_due_campaigns() promotes scheduled to running once this has passed.';

/* Only the rows the sweeper looks at, and only while they are waiting. A campaign that has
   already run keeps its `starts_at` as a record and is not in this index. */
create index if not exists campaigns_due_to_start_idx
  on campaigns (starts_at)
  where status = 'scheduled' and starts_at is not null;

/**
 * Start every campaign whose time has come.
 *
 * `security definer` and unscoped, exactly like `organizations_with_due_calls` beside it and
 * for the same reason: the sweeper runs on a timer with no organisation in hand, and asking
 * it to loop every organisation to find the few with work would be the same query run a
 * hundred times. RLS is not the protection here — `ansa_app` cannot reach this except through
 * the grant at the bottom, and the function takes no arguments, so there is nothing a caller
 * can point it at.
 *
 * Returns what it started so the sweeper can log it. A campaign starting is the kind of thing
 * somebody will later want to find the moment of.
 */
drop function if exists app.start_due_campaigns();
create or replace function app.start_due_campaigns()
  returns table(campaign_id uuid, organization_id uuid)
  language sql
  volatile
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
  update campaigns
     set status = 'running', updated_at = now()
   where status = 'scheduled'
     and starts_at is not null
     and starts_at <= now()
  returning id, organization_id
$function$;

revoke all on function app.start_due_campaigns() from public;
grant execute on function app.start_due_campaigns() to ansa_app;
