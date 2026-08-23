-- The values the agent collected, kept as data rather than as a story about data.
--
-- An agent conducts a form: it asks for a name, a phone number, a policy number, reads
-- each one back, and waits for the caller to agree. All of that already worked. What was
-- missing is anywhere for the answers to live. `agents.captured_fields` says what to ask;
-- nothing said what was heard.
--
-- The values were not lost, exactly. `call_events` holds an `entity_candidate` row with
-- the value in plain text, and the handoff summary reconstructs "what did they confirm"
-- by matching a `value confirmed` character count back to a candidate of the same length.
-- That is fine for what it was built for — a human reading a live summary, where the
-- comment notes being "one readback stale is recoverable by a person". It is not fine as
-- an organisation's record of their own data: it is a heuristic, it cannot be indexed, it
-- cannot be exported, and two fields whose answers happen to be the same length are a
-- coin toss.
--
-- So the value is written at the moment it is confirmed, when the field it belongs to is
-- known exactly and nothing has to be inferred.
--
-- One row per field per call, not an append-only log. A caller who corrects their number
-- has one number, and the console is answering "what did we collect", not "how did we get
-- there". The journey is still in `call_events` and is the better place for it.
--
-- Values are stored in the clear, including a NIN, a BVN or a one-time code, which is the
-- rule this codebase already runs on and states in two places: R5.2.4, and
-- `config-surface.ts` — "No caller value is ever redacted, and there is no setting for
-- it." The organisation is the data controller. What follows is that this table is
-- identifying data and is covered by the same retention conversation as `recordings/`.

create table if not exists call_captures (
  id               bigserial primary key,
  organization_id  uuid not null references organizations(id) on delete cascade,
  call_id          uuid not null references calls(id) on delete cascade,
  -- The key from `agents.captured_fields`, so a value can always be traced to the field
  -- that asked for it. Not the prompt: operators reword prompts and the key is stable.
  field_key        text not null,
  -- Snapshotted rather than joined back to the agent. The configuration is versioned and
  -- editable; how a value should be read cannot change retroactively because somebody
  -- edited a form after the call.
  field_type       text not null,
  value            text not null,
  -- How many times it had to be asked. A field averaging three attempts is a field whose
  -- prompt needs rewriting, and that is only visible if the number is kept.
  attempts         integer not null default 1 check (attempts >= 1),
  confirmed_at     timestamptz not null default now(),
  -- Last confirmation wins. A correction is an update, not a second row.
  unique (call_id, field_key)
);

comment on table call_captures is
  'One confirmed value per capture field per call. Written at confirmation, when the field is known exactly rather than inferred from event lengths. Plain text by policy (R5.2.4).';

-- The console reads this two ways: everything for one call, and everything for one
-- organisation over a date range. Both are covered here.
create index if not exists call_captures_call_idx
  on call_captures (call_id);
create index if not exists call_captures_organization_confirmed_idx
  on call_captures (organization_id, confirmed_at desc);

alter table call_captures enable row level security;
alter table call_captures force row level security;

drop policy if exists organization_isolation on call_captures;
create policy organization_isolation on call_captures
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

grant select, insert, update, delete on call_captures to ansa_app;
grant usage, select on sequence call_captures_id_seq to ansa_app;
