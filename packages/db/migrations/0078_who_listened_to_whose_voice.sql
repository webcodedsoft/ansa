-- Who listened to whose voice, and when.
--
-- `calls.controller.ts` named this as one of the two things standing between the recordings
-- and a route that serves them: "expiring single-use URLs that are not a guessable path, and a
-- record of who listened to whose voice and when". The token is the first. This is the second.
--
-- It is not the same thing as the call's own event log. `call_events` records what happened
-- *on* the call; this records what a member of staff did *with* it afterwards, which is a
-- different subject with a different audience — the person whose voice it is. Under NDPR the
-- question "who has heard my call" has to have an answer, and an answer that lives in the same
-- table as the barge-in events is one nobody will find.
--
-- Written when the link is minted rather than when the bytes are fetched. The mint is the
-- authenticated act with a known member of staff behind it; the fetch carries only the token,
-- because an `<audio>` element cannot send an authorization header — which is the whole reason
-- the token exists. "Was given the ability to listen" is the honest thing to record and the
-- only thing that can be attributed.
--
-- No retention rule of its own, deliberately. The audio expires on
-- `organizations.audio_retention_days` and the words on `transcript_retention_days`; the record
-- of who listened outlives both, because deleting the evidence of access alongside the thing
-- accessed is how an access log stops being one.

create table if not exists audio_access_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- The call, kept by id rather than by carrier id so it follows the row it belongs to.
  -- Null once the call itself is deleted: the access still happened.
  call_id         uuid references calls(id) on delete set null,
  -- Who asked. Null if the account is later removed; the access is still on the record.
  user_id         uuid references users(id) on delete set null,
  -- Denormalised on purpose: it survives the call row being deleted, and it is the answer to
  -- "whose voice", which is the question this table exists for.
  caller          text,
  at              timestamptz not null default now()
);

comment on table audio_access_log is
  'Who was given a link to a call recording, and when. Written at mint time, because that is the authenticated act; the fetch carries only a single-use token.';

create index if not exists audio_access_log_call_idx on audio_access_log (organization_id, call_id, at desc);

alter table audio_access_log enable row level security;
alter table audio_access_log force row level security;

drop policy if exists audio_access_log_organization on audio_access_log;
create policy audio_access_log_organization on audio_access_log
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

-- Insert and select only. An access log a organization can edit is not one.
grant select, insert on audio_access_log to ansa_app;
