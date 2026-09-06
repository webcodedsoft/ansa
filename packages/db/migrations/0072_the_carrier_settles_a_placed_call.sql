-- What the carrier said became of a placed call, onto the row that placed it.
--
-- The dialler wrote `answered` the moment the carrier accepted a call. That is the moment it
-- is queued — nothing has rung — so every call was answered, `no_answer` and `busy` could
-- never occur, and the retry policy on every campaign was unreachable. Worse underneath: it
-- tried to store the carrier's id in `call_id`, which is a uuid referencing `calls`, and a
-- `calls` row does not exist until the media socket opens — which it never does for a call
-- that rang out. The cast threw, the catch called it a failure, and every placed call was
-- queued for retry.
--
-- So a placed row now remembers the carrier's own id for the call. The dialler writes it on
-- placement and leaves the row at `placing`; the carrier's status callback fires once with
-- a terminal state and this turns it into the row's verdict. `call_id` is filled from
-- `calls` at the same moment when a row exists, which is exactly when the call was answered.
--
-- `security definer` and unscoped, like `close_call_by_carrier_id` beside it and for the
-- same reason: the callback is the carrier calling us, with no organisation in hand. RLS
-- would silently update nothing, which is exactly the "looks like it worked" this exists to
-- end. An id that matches no placed row (an inbound call, a test call) touches nothing, and
-- the `placing` guard makes it safe to run twice.
--
-- Retry arithmetic is read from the campaign row here, so the webhook and the dialler cannot
-- disagree about whether a number has another go. At the ceiling the row keeps its terminal
-- status; below it, back to pending, due after the campaign's own interval.

alter table scheduled_calls add column if not exists carrier_call_id text;

create index if not exists scheduled_calls_carrier_call_id_idx
  on scheduled_calls (carrier_call_id)
  where carrier_call_id is not null;

drop function if exists app.settle_placed_call(text, text, text, timestamptz);
create or replace function app.settle_placed_call(
  carrier_id text,
  verdict text,
  why text,
  at timestamptz
)
  returns table(scheduled_call_id uuid)
  language sql
  volatile
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
  update scheduled_calls s
     set status = case
                    when verdict = 'answered' then 'answered'
                    when s.attempts >= cp.max_attempts then verdict
                    else 'pending'
                  end,
         outcome = case when verdict = 'answered' then s.outcome else why end,
         next_attempt_at = case
                             when verdict = 'answered' or s.attempts >= cp.max_attempts then null
                             else at + make_interval(mins => cp.retry_after_minutes)
                           end,
         call_id = coalesce(
           s.call_id,
           (select c.id from calls c where c.carrier_call_id = carrier_id limit 1)
         ),
         updated_at = now()
    from campaigns cp
   where s.carrier_call_id = carrier_id
     and cp.id = s.campaign_id
     and s.status = 'placing'
  returning s.id
$function$;

revoke all on function app.settle_placed_call(text, text, text, timestamptz) from public;
grant execute on function app.settle_placed_call(text, text, text, timestamptz) to ansa_app;
