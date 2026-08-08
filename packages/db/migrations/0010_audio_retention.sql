-- Enforcing `tenants.audio_retention_days`, which has existed since schema v1 and has
-- never been honoured by anything.
--
-- RECORD_AUDIO_DIR writes the caller's raw voice to disk — a person reading their policy
-- number aloud — and until now nothing ever deleted it. A retention column that nothing
-- reads is worse than no column: it reads as a policy in review and is a lie on disk.
--
-- A sweep has no tenant. It runs on a timer, for everybody, and RLS quite correctly hides
-- every row from a connection with no `app.tenant_id` set — the same chicken-and-egg as
-- 0009, and the same answer: one narrow security-definer function per question.
--
-- Narrow by construction. `expired_call_audio` returns identifiers and a number of days.
-- It cannot return a transcript, a caller number, or anything a caller said. The worst a
-- leak of its output could do is disclose that a call happened.

create or replace function app.expired_call_audio()
returns table (carrier_call_id text, tenant_id uuid, retention_days integer)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select c.carrier_call_id, c.tenant_id, t.audio_retention_days
    from calls c
    join tenants t on t.id = c.tenant_id
   -- ended_at is the honest clock, but a call whose ending was never recorded must not
   -- become immortal, so fall back through answered_at to created_at.
   where coalesce(c.ended_at, c.answered_at, c.created_at)
           < now() - make_interval(days => t.audio_retention_days);
$$;

-- Which of these recordings belong to a call we know about at all.
--
-- The sweep needs three answers per file, not two: expired, still within its tenant's
-- window, or unattributable. Without the third it cannot tell a 40-day-old recording
-- belonging to a tenant who chose 90 days from one belonging to nobody, and would either
-- delete audio a tenant is paying to keep or keep audio with no owner forever.
create or replace function app.known_call_ids(carrier_ids text[])
returns table (carrier_call_id text)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select c.carrier_call_id from calls c where c.carrier_call_id = any(carrier_ids);
$$;

-- The strictest policy anyone has configured. Applied to audio the sweep cannot attribute
-- to a call — a recording written before the tenant was resolved, or one whose `calls`
-- row never landed. Unattributable audio is still somebody's voice, so it expires on the
-- shortest clock rather than the longest.
create or replace function app.min_audio_retention_days()
returns integer
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select coalesce(min(audio_retention_days), 30) from tenants;
$$;

-- `audio_segments.expires_at` carries the same promise for stored segments. Nothing
-- writes that table yet; the sweep honours it from the first row it ever holds rather
-- than from the day someone remembers.
create or replace function app.purge_expired_audio_segments()
returns integer
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  removed integer;
begin
  delete from audio_segments where expires_at is not null and expires_at < now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function app.expired_call_audio() from public;
revoke all on function app.known_call_ids(text[]) from public;
grant execute on function app.known_call_ids(text[]) to ansa_app;
revoke all on function app.min_audio_retention_days() from public;
revoke all on function app.purge_expired_audio_segments() from public;
grant execute on function app.expired_call_audio() to ansa_app;
grant execute on function app.min_audio_retention_days() to ansa_app;
grant execute on function app.purge_expired_audio_segments() to ansa_app;
