-- The last per-agent setting that still wrote straight to a live call.
--
-- 0040 staged the captured-field form, the tool selection and the knowledge selection and
-- left `barge_in` and `answering_machine_detection` behind, written by `PATCH /agents/{id}`
-- the moment a switch was flipped. They are the agent's rather than the organisation's, so by
-- the line agreed with the operator they stage: flipping barge-in is unpublished work until
-- somebody publishes it, exactly as a greeting is. The rule is the same one 0040 states —
-- **sections stage independently and null means "not staged"** — and nothing about a live
-- call changes here, because the call path reads the agent's own columns and cannot see a
-- draft at all.
--
-- **One section or two, and why this is two.** The flags are drawn on one row of one panel,
-- which is the argument for a single `jsonb` section holding both. They are not *saved*
-- together, though: each toggle fires its own request carrying only the switch that moved.
-- With one section that would mean every save has to carry the other flag's current effective
-- value, and the value the browser holds is whatever it read when the page rendered — so a
-- flip made after a publish, or from a second tab, silently reverts the other flag to a stale
-- copy. That is the same stale-copy failure 0040's comment rules out for `config`. Two
-- nullable booleans make the unit of staging the flag rather than the panel, which is what
-- the console actually does, and they reuse the `coalesce` that is already in
-- `stage_agent_draft_selection` instead of adding a jsonb key-merge beside it with different
-- semantics from every other section.
--
-- Null is not staged. False is a real staged value and is not null — the same distinction the
-- empty array carries for the two selections.

alter table agent_config_drafts add column if not exists barge_in                    boolean;
alter table agent_config_drafts add column if not exists answering_machine_detection boolean;

comment on column agent_config_drafts.barge_in is
  'Staged barge-in. Null is not staged; false is a staged "the caller cannot interrupt".';
comment on column agent_config_drafts.answering_machine_detection is
  'Staged answering-machine detection. Null is not staged; false is a staged "off".';

/*
 * 0040's function with the two flags added, replaced rather than overloaded.
 *
 * The five-argument form is dropped for the reason 0039 gives for dropping the three-argument
 * `save_agent_draft`: two functions differing only in what the shorter one forgets is how a
 * caller ends up silently resolving to the one that drops a section on the floor.
 *
 * Every section still coalesces, so a caller passing null for a section it does not own
 * cannot wipe it — which is what makes five editors saved at five different moments safe.
 */
drop function if exists app.stage_agent_draft_selection(uuid, uuid, jsonb, text[], uuid[]);

create or replace function app.stage_agent_draft_selection(
  agent uuid,
  p_author uuid,
  p_fields jsonb,
  p_tools text[],
  p_knowledge uuid[],
  p_barge_in boolean,
  p_amd boolean
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
    (agent_id, organization_id, captured_fields, enabled_tools, knowledge_sources,
     barge_in, answering_machine_detection, updated_by)
  values (agent, owner, p_fields, p_tools, p_knowledge, p_barge_in, p_amd, p_author)
  on conflict (agent_id) do update
     set captured_fields   = coalesce(excluded.captured_fields, agent_config_drafts.captured_fields),
         enabled_tools     = coalesce(excluded.enabled_tools, agent_config_drafts.enabled_tools),
         knowledge_sources = coalesce(excluded.knowledge_sources, agent_config_drafts.knowledge_sources),
         barge_in          = coalesce(excluded.barge_in, agent_config_drafts.barge_in),
         answering_machine_detection =
           coalesce(excluded.answering_machine_detection,
                    agent_config_drafts.answering_machine_detection),
         updated_by        = excluded.updated_by
  returning updated_at into saved;

  return saved;
end
$function$;

comment on function app.stage_agent_draft_selection(uuid, uuid, jsonb, text[], uuid[], boolean, boolean) is
  'Stages the captured-field form, the tool selection, the knowledge selection or either behaviour flag. Null leaves a section as it was; an empty array or a false flag stages that value. See migrations 0040 and 0041.';

/*
 * Put the staged flags on the agent, for the publish path and nothing else.
 *
 * Sibling of `apply_captured_fields`, and simpler for one reason worth stating: the flags are
 * not in `agent_prompt_versions` — the table has no column for either, and the snapshot
 * `publish_agent_config` writes does not mention them — so there is no ordering constraint
 * against the snapshot and nothing for a version to record. The publish path applies these
 * after `publish_agent_config`, alongside the two selections, whose join tables the snapshot
 * does not cover either.
 *
 * `coalesce` on each, so applying a draft that staged only one flag leaves the other's live
 * value where it was rather than nulling a not-null column.
 */
create or replace function app.apply_agent_behaviour(agent uuid, p_barge_in boolean, p_amd boolean)
  returns boolean
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $function$
declare
  changed integer;
begin
  update agents
     set barge_in                    = coalesce(p_barge_in, barge_in),
         answering_machine_detection = coalesce(p_amd, answering_machine_detection)
   where id = agent and deleted_at is null;
  get diagnostics changed = row_count;
  return changed > 0;
end
$function$;

comment on function app.apply_agent_behaviour(uuid, boolean, boolean) is
  'Sets an agent''s behaviour flags without bumping the version — they are not snapshotted. For the publish path only. Null leaves a flag alone. RLS scopes it.';
