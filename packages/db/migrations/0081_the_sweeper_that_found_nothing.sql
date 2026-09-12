-- The summary sweeper has never written a row, and this is why.
--
-- `readCallsNeedingSummary` (0079) ran a plain `select … from calls` on the data source as
-- `ansa_app` with no organisation set. Under RLS that is not an error and not an empty
-- database — it is zero rows, every time, for every organisation at once. The sweeper woke
-- every sixty seconds, found nothing to do, and went back to sleep. No log line, because there
-- was nothing to log. Twenty-four ended calls with transcripts sat unsummarised for the whole
-- of a working session, and the screen that shows summaries said "not written yet" over each.
--
-- `start_due_campaigns` (0069) faces the same problem — a timer with no organisation in hand —
-- and solves it the only safe way: a `security definer` function that takes what the sweeper
-- needs and nothing a caller could point elsewhere. This does the same for summaries.
--
-- The two arguments are the sweeper's own settling delay and batch size. They bound *how much*
-- it reads, never *whose*: there is no organisation parameter, so the function cannot be
-- narrowed to somebody else's rows. It returns the organisation with each call so the write
-- still happens inside that organisation's own scope, as 0079 intended.

drop function if exists app.calls_needing_summary(integer, integer);
create or replace function app.calls_needing_summary(settled_seconds integer, batch integer)
  returns table(call_id uuid, organization_id uuid)
  language sql
  stable
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
  select c.id, c.organization_id
    from calls c
   where c.ended_at is not null
     and c.ended_at < now() - make_interval(secs => settled_seconds)
     and not exists (select 1 from call_summaries s where s.call_id = c.id)
     and exists (select 1 from transcripts t where t.call_id = c.id)
   order by c.ended_at
   limit greatest(batch, 0)
$function$;

revoke all on function app.calls_needing_summary(integer, integer) from public;
grant execute on function app.calls_needing_summary(integer, integer) to ansa_app;
