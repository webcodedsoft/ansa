-- What an agent is allowed to know, and where it came from.
--
-- The shape is `agent_tools` again, deliberately and almost line for line: one registry per
-- organisation, and a join table saying which of it a given agent may reach. The alternative
-- — knowledge hanging off the agent — was rejected for the same reason 0018 rejected a
-- per-agent tool registry. An organisation's refund policy is one fact. Copied per agent it
-- becomes three facts that disagree, and the one that answers the phone is whichever agent
-- the caller happened to reach.
--
-- Four tables, and only the first two hold content:
--
--   knowledge_sources     what a person uploaded or typed: an FAQ, a price table, a document.
--   knowledge_units       the retrievable unit. One question-and-answer, one row of a table,
--                         one section of a document. Retrieval returns these, never a whole
--                         source — a voice turn is two sentences and cannot carry a document.
--   agent_knowledge_sources  which sources this agent may retrieve from. No rows means none,
--                         not all of them, for the reason `agent_tools` says it.
--   knowledge_retrievals  append-only: which source answered, on which call. This is the
--                         "Used, 7d" column, and it is the only evidence available that a
--                         source someone maintains is doing anything at all.
--
-- Keyword search, not embeddings. Postgres' own full text index is already here, already
-- backed up, already inside RLS, and costs no second system to keep in step with this one.
-- A vector store would be a copy of this data living outside every policy in migration 0002,
-- and getting isolation right twice is how you get it wrong once. Revisit only when keyword
-- retrieval is measured to fail on real Nigerian phrasing — not on the suspicion that it might.

-- ---------------------------------------------------------------------------
-- The sources
-- ---------------------------------------------------------------------------

create table if not exists knowledge_sources (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name            text not null,

  -- What the thing is, which decides how it was split into units and how it reads back.
  -- A check constraint rather than an enum type: adding a kind should be a migration that
  -- edits one line, not one that rewrites a type every dependent column has to be cast to.
  kind            text not null check (kind in ('faq', 'table', 'document')),

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Soft delete, on the 0032 terms: the column is not the feature, the rule that every read
  -- honours it is. `knowledge_retrievals` still points here after a source is deleted, and a
  -- hard delete would cascade away the record of what had been answering callers.
  deleted_at      timestamptz
);

-- Partial, like `agents_tenant_idx` after 0032: the listing only ever asks for live sources,
-- and the deleted ones should not be paged through to find them.
create index if not exists knowledge_sources_organization_idx
  on knowledge_sources (organization_id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- The units, and the index that makes them findable
-- ---------------------------------------------------------------------------

create table if not exists knowledge_units (
  id              uuid primary key default gen_random_uuid(),

  -- Denormalised from the source on purpose, and the same argument 0018 makes about
  -- `agent_tools`: a policy that has to join to find its organisation is a policy that gets
  -- dropped in a hurry. The cascade below keeps the two from ever disagreeing.
  organization_id uuid not null references organizations(id) on delete cascade,
  source_id       uuid not null references knowledge_sources(id) on delete cascade,

  -- Where this unit sits in its source. Order is part of the meaning — question three of an
  -- FAQ reads as a follow-up to question two — so it is stored rather than left to whatever
  -- order the rows come back in.
  position        int not null,

  -- Null for a document section or a table row, which answer a question nobody wrote down.
  question        text,
  body            text not null,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  /*
   * Generated rather than maintained, for the reason 0031 gives about `updated_at`: a search
   * column kept in step by the writer is correct until somebody adds a second writer, and
   * from then on it indexes text that is no longer there. Nothing in a review catches it.
   *
   * The question carries weight A and the body weight B, so a unit whose *question* matches
   * outranks one that merely mentions the words somewhere in a long answer. On an FAQ that is
   * almost always the right ordering, and `ts_rank` reads the weights for free.
   *
   * 'english' rather than 'simple' because stemming is what makes "refunded" find "refund",
   * and Nigerian English stems as English does. It is the config `websearch_to_tsquery` must
   * be called with too — a query parsed under a different config silently matches nothing.
   */
  search          tsvector generated always as (
                    setweight(to_tsvector('english', coalesce(question, '')), 'A') ||
                    setweight(to_tsvector('english', body), 'B')
                  ) stored
);

create index if not exists knowledge_units_organization_idx on knowledge_units (organization_id);

-- Reading a source back in order, which is how it is edited and how it is displayed.
create index if not exists knowledge_units_source_idx on knowledge_units (source_id, position);

-- The one that makes retrieval a lookup rather than a scan of every unit the organisation owns.
create index if not exists knowledge_units_search_idx on knowledge_units using gin (search);

-- ---------------------------------------------------------------------------
-- Which sources an agent may reach
-- ---------------------------------------------------------------------------

-- `agent_tools` with a foreign key where the tool name was. The registry is rows here rather
-- than a jsonb document, so this one can be a real reference and the cascade can do the
-- tidying: dropping a source takes its selections with it and no agent is left holding a
-- pointer to nothing.
create table if not exists agent_knowledge_sources (
  organization_id uuid not null references organizations(id) on delete cascade,
  agent_id        uuid not null references agents(id) on delete cascade,
  source_id       uuid not null references knowledge_sources(id) on delete cascade,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (agent_id, source_id)
);

create index if not exists agent_knowledge_sources_organization_idx
  on agent_knowledge_sources (organization_id);

-- ---------------------------------------------------------------------------
-- What actually got used
-- ---------------------------------------------------------------------------

-- Append-only. A source that has answered nothing in a week is either badly written or about
-- something nobody rings up to ask, and neither is visible from the source itself.
create table if not exists knowledge_retrievals (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  source_id       uuid not null references knowledge_sources(id) on delete cascade,

  -- Deliberately not a foreign key to `calls`. This is written from the answer path while the
  -- caller is waiting, and a constraint violation there would turn a bookkeeping row into a
  -- failed turn. Null when a retrieval happened outside a call, as in a console search.
  call_id         uuid,

  at              timestamptz not null default now(),
  -- No `created_at` beside it, for the reason 0031 declines to add one to `call_events`: `at`
  -- is the only creation a retrieval has, and a second column meaning the same thing is a
  -- second column to keep in step.
  updated_at      timestamptz not null default now()
);

-- The "Used, 7d" count, which is always asked as a window ending now.
create index if not exists knowledge_retrievals_source_idx
  on knowledge_retrievals (organization_id, source_id, at desc);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

-- 0031 attached the trigger to every table that existed then and could not attach it to
-- these. A table created afterwards has the column, the default and no trigger, so its
-- `updated_at` sits at the insert time forever while reading as though it were maintained —
-- the confidently-wrong date 0031 was written to prevent.
do $migration$
declare
  target text;
begin
  foreach target in array array[
    'knowledge_sources', 'knowledge_units', 'agent_knowledge_sources', 'knowledge_retrievals'
  ] loop
    execute format('drop trigger if exists %I on %I', target || '_touch_updated_at', target);
    execute format(
      'create trigger %I before update on %I for each row execute function app.touch_updated_at()',
      target || '_touch_updated_at',
      target
    );
  end loop;
end
$migration$;

-- ---------------------------------------------------------------------------
-- Isolation
-- ---------------------------------------------------------------------------

-- Both halves on every table, and FORCE on all four. Knowledge is the one thing here a
-- competitor would actually want to read: pricing, policies, the script for handling a
-- complaint. USING keeps it out of another organisation's reads; WITH CHECK stops one
-- planting a unit under somebody else's id, which would then be retrieved and spoken by
-- their agent to their caller.
do $migration$
declare
  target text;
begin
  foreach target in array array[
    'knowledge_sources', 'knowledge_units', 'agent_knowledge_sources', 'knowledge_retrievals'
  ] loop
    execute format('alter table %I enable row level security', target);
    execute format('alter table %I force  row level security', target);
    execute format('drop policy if exists organization_isolation on %I', target);
    execute format(
      'create policy organization_isolation on %I
         using (organization_id = app.current_organization())
         with check (organization_id = app.current_organization())',
      target
    );
  end loop;
end
$migration$;

-- Update, because renaming a source and deleting one are both updates. No delete: `deleted_at`
-- is how a source goes away, so `knowledge_retrievals` keeps its referent.
grant select, insert, update on knowledge_sources to ansa_app;

-- Delete, because a source's units are replaced wholesale when it is re-uploaded. Deleting a
-- unit destroys no history — the retrieval log records the source, not the sentence.
grant select, insert, update, delete on knowledge_units to ansa_app;

-- Exactly `agent_tools`: the selection is a set replaced wholesale, and a row removed here
-- revokes an agent's sight of a source rather than destroying the source.
grant select, insert, delete on agent_knowledge_sources to ansa_app;

-- Append-only means append-only. No update, no delete, so the usage figures cannot be tidied
-- up by the code that produces them.
grant select, insert on knowledge_retrievals to ansa_app;

comment on table knowledge_sources is
  'What an organisation has told its agents. One registry per organisation; agents select from it.';
comment on table knowledge_units is
  'The retrievable unit. Full-text searched; never returned whole-source.';
comment on table agent_knowledge_sources is
  'Which sources an agent may retrieve from. No rows means none, not all.';
comment on table knowledge_retrievals is
  'Append-only record of which source answered. Backs the "Used, 7d" column.';
