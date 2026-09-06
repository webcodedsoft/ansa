-- The agent's words become a row, like the caller's.
--
-- Half of every conversation was stored where the product could not reach it. The caller's
-- words went to `transcripts`; the agent's went to `call_events` as `detail.text`, and the API
-- projects `detail` through a fixed allowlist that does not include `text`. So the console
-- rendered one word for every agent turn — "spoke" — and said so in a comment: "The agent's
-- words are not stored, only that it took a turn." Those events also carry no `offset_ms`,
-- so they could not have been interleaved with caller speech even if the text were published.
--
-- One column fixes it. Everything downstream — a readable conversation, a summary grounded in
-- what was actually said, a reviewer correcting the half the model produced — was blocked here
-- and nowhere else.
--
-- The default backfills every existing row as `caller`, which is what they all are: the only
-- writer was the caller-transcript handler. It is then dropped, so a future insert has to say
-- who spoke rather than silently inheriting the commonest answer.
--
-- Retention is untouched on purpose. `purge_expired_call_content` deletes whole `transcripts`
-- rows, so agent lines expire on the same clock as caller lines, in the same sweep, with no
-- new rule to keep in step.

alter table transcripts
  add column if not exists speaker text not null default 'caller';

alter table transcripts
  drop constraint if exists transcripts_speaker_check;
alter table transcripts
  add constraint transcripts_speaker_check check (speaker in ('caller', 'agent'));

alter table transcripts alter column speaker drop default;

comment on column transcripts.speaker is
  'Who said it. Before 0076 only the caller was stored here and the agent lived in call_events.detail, unreachable through the API.';

-- The conversation is read in order, per call, and now filtered by side as well.
create index if not exists transcripts_call_speaker_idx
  on transcripts (call_id, offset_ms, id);
