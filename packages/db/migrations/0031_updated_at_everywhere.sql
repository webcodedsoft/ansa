-- `updated_at` on every table, maintained by a trigger rather than by remembering.
--
-- Three tables had it and seventeen did not. The reason to add it by trigger rather than by
-- editing seventeen writers is that a hand-maintained `updated_at` is worse than none: it is
-- correct until somebody adds an UPDATE and forgets, and from then on it reports a date that
-- is confidently wrong. Nothing in a review catches a missing line in a SET clause.
--
-- On an append-only table the value equals `created_at` forever, and that is not a lie — it
-- says the row has never been changed, which is true and is the point of those tables.
--
-- `created_at` is deliberately not added anywhere. Every table already records when its row
-- came into being; two of them do it under a name that says more than `created_at` would:
--
--   agent_prompt_versions.published_at — a version is created by being published, and the
--     word carries that. It is immutable, so the two dates could never differ.
--   call_events.at — when the thing happened on the call, which is the only creation an
--     event has. `offset_ms` sits beside it for position within the call.
--
-- Adding `created_at` alongside either would be a second column meaning the same thing, kept
-- in step by hand, and eventually disagreeing.

/*
 * Stamp the row on the way past.
 *
 * `pg_temp` last in the search path for the usual reason: without it a temporary table can
 * shadow a real one and the function runs against something the caller controls.
 */
create or replace function app.touch_updated_at() returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $fn$
begin
  -- `now()` rather than `clock_timestamp()`: every row touched by one transaction should
  -- carry one time, so a multi-row update reads as the single change it was.
  new.updated_at := now();
  return new;
end
$fn$;

do $migration$
declare
  target text;
  targets text[] := array[
    'agent_prompt_versions', 'agent_tools', 'agents', 'audio_segments', 'call_events',
    'calls', 'do_not_call', 'event_deliveries', 'invitations', 'latencies', 'memberships',
    'organization_credentials', 'organization_numbers', 'organizations', 'outbound_consent',
    'sessions', 'tool_invocations', 'transcripts', 'turns', 'users'
  ];
begin
  foreach target in array targets loop
    -- Existing columns are left exactly as they are; three tables already carry one and
    -- their stored values are real history that a default would overwrite.
    execute format(
      'alter table %I add column if not exists updated_at timestamptz not null default now()',
      target
    );

    -- Backfilled to the row's own creation rather than to now(), so a table gaining the
    -- column does not claim every row in it changed the moment this migration ran.
    if target = 'agent_prompt_versions' then
      execute 'update agent_prompt_versions set updated_at = published_at where updated_at > published_at';
    elsif target = 'call_events' then
      execute 'update call_events set updated_at = at where updated_at > at';
    else
      execute format('update %I set updated_at = created_at where updated_at > created_at', target);
    end if;

    execute format('drop trigger if exists %I on %I', target || '_touch_updated_at', target);
    execute format(
      'create trigger %I before update on %I for each row execute function app.touch_updated_at()',
      target || '_touch_updated_at',
      target
    );
  end loop;
end
$migration$;

comment on function app.touch_updated_at() is
  'Sets updated_at on every UPDATE. Attached to every table in public by migration 0031.';
