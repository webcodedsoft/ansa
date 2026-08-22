-- The caller's voice expires after thirty days. The caller's words are kept forever.
--
-- `audio_retention_days` has been enforced since 0010, so the recording of somebody reading
-- their policy number aloud is deleted on a timer. The transcript of them reading it is not,
-- and since R5.2.4 was withdrawn there is nothing masking it either — the event log now
-- carries a NIN, a BVN and a one-time code in full, deliberately and for good reasons, and
-- keeps them indefinitely, which was nobody's decision.
--
-- That is the worse half of the pair. Audio is bulky and obviously sensitive, so it gets
-- attention; a text column looks like metadata and is the thing an NDPR review actually asks
-- about. A retention policy that covers the recording and not the transcript is not a
-- retention policy, it is a storage cost control.
--
-- Ninety days, not the thirty audio gets. The words have a job the audio does not: the review
-- loop reads transcripts, corrects them, and those corrections are what the eval corpus is
-- built from. Thirty days would delete the evidence before a quarterly accuracy review could
-- use it. Ninety is long enough for that loop and short enough that no caller's identity
-- number sits in this database for a year because nobody chose a number.
--
-- Blunt on purpose: rows are deleted, not masked. The alternative is a rule that strips
-- text-bearing keys out of `detail`, and that is the shape of the masker R5.2.4 was withdrawn
-- for — a denylist that misses the next event kind somebody adds, while reading like a policy
-- that holds. Deleting the row cannot miss a field.
--
-- What survives, and it is the point of doing it this way: `calls`, `turns` and `latencies`
-- hold timings, offsets and outcomes and no words at all. Call history, duration, barge-in
-- timing and every latency percentile still work on a call whose transcript is long gone.
--
-- What degrades, stated rather than discovered: anything reading `call_events` beyond the
-- window. The outbound do-not-call rate and human-answer rate are computed from events, so
-- they thin out past ninety days. Latency does not — the recorder writes it to `latencies`
-- as well as to the event log, which is exactly the redundancy that makes this affordable.

alter table organizations
  add column if not exists transcript_retention_days integer not null default 90
    check (transcript_retention_days > 0);

comment on column organizations.transcript_retention_days is
  'How long the caller''s words are kept: transcripts, call events and tool arguments. '
  'Separate from audio_retention_days because the words outlive the recording on purpose — '
  'the review loop and the eval corpus are built from them.';

-- A sweep has no organisation. It runs on a timer for everybody, and RLS correctly hides
-- every row from a connection with no `app.organization_id` set — the same problem 0010 had
-- and the same answer: one narrow security-definer function that returns counts and nothing
-- a caller said.
create or replace function app.purge_expired_call_content()
returns table (transcripts integer, events integer, invocations integer)
  language plpgsql
  volatile
  security definer
  set search_path to 'public', 'pg_temp'
as $fn$
declare
  doomed uuid[];
  n_transcripts integer;
  n_events integer;
  n_invocations integer;
begin
  -- `ended_at` is the honest clock, but a call whose ending was never recorded must not
  -- become immortal, so fall back through `answered_at` to `created_at`. Same ladder as
  -- `app.expired_call_audio`, and it must stay the same: two clocks would mean the audio and
  -- the transcript of one call expiring on different days.
  select coalesce(array_agg(c.id), '{}')
    into doomed
    from calls c
    join organizations o on o.id = c.organization_id
   where coalesce(c.ended_at, c.answered_at, c.created_at)
           < now() - make_interval(days => o.transcript_retention_days);

  if array_length(doomed, 1) is null then
    return query select 0, 0, 0;
    return;
  end if;

  delete from transcripts where call_id = any(doomed);
  get diagnostics n_transcripts = row_count;

  delete from call_events where call_id = any(doomed);
  get diagnostics n_events = row_count;

  -- Arguments and results, which carry a policy number, an amount, sometimes an address. A
  -- tool call is as much a record of what the caller said as the transcript is.
  delete from tool_invocations where call_id = any(doomed);
  get diagnostics n_invocations = row_count;

  return query select n_transcripts, n_events, n_invocations;
end;
$fn$;

revoke all on function app.purge_expired_call_content() from public;
grant execute on function app.purge_expired_call_content() to ansa_app;
