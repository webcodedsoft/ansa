-- The other three things an agent owns, staged like its configuration.
--
-- 0038 gave the publish form somewhere to be saved without going live. The captured-field
-- form, the agent's tool selection and its knowledge selection kept writing straight to the
-- live tables, so the console was "some of this waits for Publish and some of it does not",
-- which is harder to explain than the behaviour it replaced. The line agreed with the
-- operator is that anything belonging to one agent is staged and anything shared across the
-- organisation is immediate — these three are the agent's, so they come here.
--
-- **Sections are staged independently, and null means "not staged".** The four editors are
-- four screens saved at four different moments: somebody who reorders the form and never
-- touches the voice must not have the voice republished from a stale copy, and somebody who
-- saves only tools must not blank a greeting they were half way through writing. An empty
-- array is a real value — "this agent reaches no tools" — and is not the same as null.
--
-- Which is also why `config` becomes nullable. A draft holding only a tool selection is an
-- ordinary state now, and requiring a configuration document beside it would mean inventing
-- one from the live row, which is the stale copy the paragraph above rules out.

alter table agent_config_drafts alter column config drop not null;

alter table agent_config_drafts add column if not exists captured_fields   jsonb;
alter table agent_config_drafts add column if not exists enabled_tools     text[];
alter table agent_config_drafts add column if not exists knowledge_sources uuid[];

comment on column agent_config_drafts.config is
  'The publish form as it would be published, or null when nothing on it has been staged.';
comment on column agent_config_drafts.captured_fields is
  'The staged form the agent conducts. Null is not staged; [] is a form with no fields.';
comment on column agent_config_drafts.enabled_tools is
  'Staged tool selection. Null is not staged; {} is an agent that reaches none of them.';
comment on column agent_config_drafts.knowledge_sources is
  'Staged knowledge selection. Null is not staged; {} is an agent with no knowledge base.';

/*
 * Stage one or more of the three selections, leaving the others and the configuration alone.
 *
 * `coalesce` on each, so a caller passing null for a section it does not own cannot wipe it.
 * That is the whole reason this is separate from `save_agent_draft`: the config setter
 * deliberately *overwrites* `restored_from`, because editing a restored draft makes it your
 * own work, and coalesce semantics there would keep claiming it came from version 4.
 */
create or replace function app.stage_agent_draft_selection(
  agent uuid,
  p_author uuid,
  p_fields jsonb,
  p_tools text[],
  p_knowledge uuid[]
)
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

  -- The same three cases the caller must not be able to tell apart: no such agent, a deleted
  -- one, and one belonging to another organisation that RLS has already hidden.
  if owner is null then
    return null;
  end if;

  if app.current_organization() is distinct from owner then
    raise exception
      'stage_agent_draft_selection needs the organization scope set: select set_config(''app.organization_id'', ...)';
  end if;

  insert into agent_config_drafts
    (agent_id, organization_id, captured_fields, enabled_tools, knowledge_sources, updated_by)
  values (agent, owner, p_fields, p_tools, p_knowledge, p_author)
  on conflict (agent_id) do update
     set captured_fields   = coalesce(excluded.captured_fields, agent_config_drafts.captured_fields),
         enabled_tools     = coalesce(excluded.enabled_tools, agent_config_drafts.enabled_tools),
         knowledge_sources = coalesce(excluded.knowledge_sources, agent_config_drafts.knowledge_sources),
         updated_by        = excluded.updated_by
  returning updated_at into saved;

  return saved;
end
$function$;

comment on function app.stage_agent_draft_selection(uuid, uuid, jsonb, text[], uuid[]) is
  'Stages the captured-field form, the tool selection or the knowledge selection. Null leaves a section as it was; an empty array stages an empty selection. See migration 0040.';

/*
 * Write the staged form onto the agent without publishing anything.
 *
 * `publish_captured_fields` exists and bumps the version, which is right for the endpoint it
 * serves and wrong here: the publish about to happen bumps it once, and a form applied
 * through that function would take a version number of its own and leave two rows in the
 * history for one act. This applies the value so the snapshot taken moments later contains
 * it, and does nothing else.
 *
 * For the publish path only, which calls it inside the same transaction as
 * `publish_agent_config` and immediately before it — the order matters, because the snapshot
 * reads `captured_fields` off the agent row.
 */
create or replace function app.apply_captured_fields(agent uuid, p_fields jsonb)
  returns boolean
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $function$
declare
  changed integer;
begin
  update agents set captured_fields = p_fields
   where id = agent and deleted_at is null;
  get diagnostics changed = row_count;
  return changed > 0;
end
$function$;

comment on function app.apply_captured_fields(uuid, jsonb) is
  'Sets an agent''s form without bumping the version. For the publish path only, which bumps once for the whole act. RLS scopes it.';
