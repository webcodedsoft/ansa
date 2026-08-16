-- A place to save work that is not live yet.
--
-- Until now the console had one copy of an agent's configuration: the live columns a call
-- reads. Every write went straight to them, so "save" and "make this answer the phone" were
-- the same act whether the button said so or not — which is how three buttons labelled Save
-- came to publish every tab at once.
--
-- The model the operator asked for is the ordinary one: a tab's Save writes to the database
-- and changes nothing about a live call, Publish makes the saved state take effect, and a
-- discard throws the unpublished work away. That needs a second copy, and this is it.
--
-- **The live read path is deliberately untouched.** `app.agent_config_for_number` and its two
-- siblings still read the agent's own columns and know nothing about this table. A draft
-- therefore cannot reach a phone line by construction rather than by everybody remembering a
-- filter — the same argument RLS makes about `organization_id`, and the reason this is a
-- table rather than a `published boolean` on `agents`. A flag would put unpublished text one
-- forgotten `where` clause away from a caller.
--
-- One row per agent, holding the document rather than mirrored columns. Twelve fields copied
-- into a second table is two shapes kept in step by hand, which 0031's own comment calls out
-- as worse than not having the column: correct until somebody adds a field and forgets, and
-- confidently wrong from then on. The draft is the same document `agent_prompt_versions`
-- snapshots and `diffConfigurations` already compares, so it stays one shape.

create table if not exists agent_config_drafts (
  -- The agent, and the primary key. There is exactly one unpublished state per agent: a
  -- second draft is not a feature, it is two people overwriting each other with extra steps.
  agent_id        uuid primary key references agents(id) on delete cascade,

  -- Denormalised for the policy below, on the same terms as `knowledge_units`: a policy that
  -- has to join to find its organisation is a policy that gets dropped in a hurry.
  organization_id uuid not null references organizations(id) on delete cascade,

  -- The whole configuration as it would be published. Not a patch of changed fields — a
  -- publish rewrites the document, so a draft holding only differences would have to be
  -- merged against a live copy that may have moved underneath it, and the merge is where the
  -- wrong greeting goes out.
  config          jsonb not null,

  -- Who is holding unpublished work, for the console to name. Nullable because a draft can
  -- outlive the membership of whoever left it.
  updated_by      uuid references users(id) on delete set null,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists agent_config_drafts_organization_idx
  on agent_config_drafts (organization_id);

drop trigger if exists agent_config_drafts_touch_updated_at on agent_config_drafts;
create trigger agent_config_drafts_touch_updated_at
  before update on agent_config_drafts
  for each row execute function app.touch_updated_at();

-- Same policy as every other tenant table. A draft is the most sensitive copy of a
-- configuration there is — it is what somebody is still deciding — and it holds the same
-- greeting, persona and instructions the published one does.
alter table agent_config_drafts enable row level security;
alter table agent_config_drafts force  row level security;
drop policy if exists organization_isolation on agent_config_drafts;
create policy organization_isolation on agent_config_drafts
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

-- Delete, because discarding is the second of the two reverts the console offers and there is
-- no history here to preserve: a draft that was thrown away is not a version, and recording
-- it would make the version list mean two different things.
grant select, insert, update, delete on agent_config_drafts to ansa_app;

comment on table agent_config_drafts is
  'Unpublished configuration, one row per agent. No live read path consults this table: a draft reaches a call only by being published, which copies it onto the agent and deletes the row. See migration 0038.';

comment on column agent_config_drafts.config is
  'The whole document as it would be published, the shape agent_prompt_versions snapshots.';

-- ---------------------------------------------------------------------------
-- Saving, discarding
-- ---------------------------------------------------------------------------

/*
 * Write the draft for one agent, replacing whatever was there.
 *
 * SECURITY INVOKER, like `publish_agent_config`, so RLS is what stops one organisation
 * writing into another's draft. The explicit scope check turns a silently zero-row write into
 * a loud failure when the scope was never set — a save that quietly did nothing would look
 * exactly like a save that worked.
 */
create or replace function app.save_agent_draft(agent uuid, p_config jsonb, p_author uuid)
  returns timestamptz
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $function$
declare
  owner uuid;
  saved timestamptz;
begin
  select a.organization_id into owner
    from agents a
   where a.id = agent and a.deleted_at is null;

  -- Null covers three cases the caller must not be able to tell apart: no such agent, a
  -- deleted one, and one belonging to another organisation that RLS has already hidden. The
  -- API turns this into a 404, which is the honest answer to all three.
  if owner is null then
    return null;
  end if;

  if app.current_organization() is distinct from owner then
    raise exception
      'save_agent_draft needs the organization scope set: select set_config(''app.organization_id'', ...)';
  end if;

  insert into agent_config_drafts (agent_id, organization_id, config, updated_by)
  values (agent, owner, p_config, p_author)
  on conflict (agent_id) do update
     set config     = excluded.config,
         updated_by = excluded.updated_by
  returning updated_at into saved;

  return saved;
end
$function$;

/*
 * Throwing away unpublished work.
 *
 * Returns whether there was any, so the console can tell "discarded" from "there was nothing
 * to discard" rather than reporting success either way.
 */
create or replace function app.discard_agent_draft(agent uuid)
  returns boolean
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $function$
declare
  removed integer;
begin
  -- No scope check and no owner lookup: this deletes by primary key through RLS, so another
  -- organisation's draft is not visible to delete in the first place. A zero-row delete is
  -- the honest answer to both "already gone" and "not yours".
  delete from agent_config_drafts where agent_id = agent;
  get diagnostics removed = row_count;
  return removed > 0;
end
$function$;

comment on function app.save_agent_draft(uuid, jsonb, uuid) is
  'Upserts the unpublished configuration for one agent. Null when the agent does not exist, is deleted, or belongs to another organisation.';

comment on function app.discard_agent_draft(uuid) is
  'Deletes an agent''s unpublished configuration. False when there was none. RLS scopes it.';
