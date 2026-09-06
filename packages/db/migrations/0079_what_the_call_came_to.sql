-- A summary of the call, grounded in the lines it came from.
--
-- The first thing in this codebase to write down what a model said off the realtime path.
-- Everything else a model produces here is spoken and gone; this is stored, read later by
-- somebody deciding what to do about a customer, and therefore has to be answerable for.
--
-- **Written once, when the call ends, and never regenerated on view.** Two people opening the
-- same call must read the same account of it — a summary that reruns is one that can change
-- its mind between two colleagues discussing it. It also puts the model's cost on traffic
-- rather than on curiosity.
--
-- **`cites` is what makes it checkable.** Each sentence carries the transcript ids behind it,
-- so the page can highlight the words a claim came from and a reader can disagree with the
-- evidence rather than with the prose. A claim with nothing behind it does not get written.
--
-- `model` and `prompt_version` are here so a bad batch can be found and re-run. Without them a
-- change of model is invisible in the data and the only way to find what it produced is the
-- date.
--
-- Retention is the transcript's, not its own. A summary is derived personal data, and
-- describing deleted words is still describing them, so it goes in the same sweep on the same
-- clock.

create table if not exists call_summaries (
  call_id         uuid primary key references calls(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  -- The prose a person reads. Sentences, in order.
  summary         text not null,
  -- Which transcript lines each sentence rests on: `[[12, 13], [15]]`, one entry per sentence.
  -- Ids rather than offsets, so correcting a line does not move its citation.
  cites           jsonb not null default '[]'::jsonb,
  -- Null when the model was unavailable and the deterministic reducer wrote this instead.
  model           text,
  prompt_version  integer not null default 1,
  created_at      timestamptz not null default now()
);

comment on table call_summaries is
  'What a call came to, written once when it ended. Cites the transcript lines behind each sentence. Expires with the transcript, because a summary of deleted words is still those words.';

create index if not exists call_summaries_organization_idx
  on call_summaries (organization_id, created_at desc);

alter table call_summaries enable row level security;
alter table call_summaries force row level security;

drop policy if exists call_summaries_organization on call_summaries;
create policy call_summaries_organization on call_summaries
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

grant select, insert on call_summaries to ansa_app;

-- The sweep learns one more table. Same list of doomed calls, same clock: a summary outliving
-- the words it describes would be the retention policy quietly not applying to the one piece
-- of derived text a person actually reads.
--
-- Dropped rather than replaced, because `create or replace` refuses to change a return type
-- and this gains a fourth count. That resets the function's privileges — the lesson 0057
-- wrote down — so the revoke and grant at the foot of this file are not decoration.
drop function if exists app.purge_expired_call_content();
create function app.purge_expired_call_content()
  returns table(transcripts integer, events integer, invocations integer, summaries integer)
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $function$
declare
  doomed uuid[];
  n_transcripts integer;
  n_events integer;
  n_invocations integer;
  n_summaries integer;
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
    return query select 0, 0, 0, 0;
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

  -- Derived from all of the above, and no less personal for being derived.
  delete from call_summaries where call_id = any(doomed);
  get diagnostics n_summaries = row_count;

  return query select n_transcripts, n_events, n_invocations, n_summaries;
end;
$function$;

revoke all on function app.purge_expired_call_content() from public;
grant execute on function app.purge_expired_call_content() to ansa_app;
