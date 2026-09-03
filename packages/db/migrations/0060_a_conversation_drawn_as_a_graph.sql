-- A conversation drawn as a graph.
--
-- An agent has always been authored one way: `captured_fields`, an ordered list of questions
-- asked from the top. That is the right shape for a form and the wrong shape for a call that
-- branches — "if they are an existing customer, skip to the policy number; if the amount is
-- over five hundred thousand, transfer" is not an ordering, it is a graph, and expressing it
-- as prose in `instructions` puts a branch somewhere code cannot enforce it.
--
-- So an agent can now be authored as a graph instead. The shape of that graph is
-- `packages/shared/src/flow.ts` and belongs to neither half of the product; this migration
-- gives it somewhere to live and carries it down the same three roads every other piece of
-- configuration travels: staged in a draft, copied onto the agent by a publish, snapshotted
-- into the version history, and read back by the call.
--
-- **Two columns, not one.** `flow` is the graph. `authoring_mode` is which of the two
-- editors — and therefore which director — this agent runs on. They are separate because a
-- flow that is *stored* is not the same statement as a flow that is *live*: an operator who
-- draws a graph, publishes it, then switches back to the form has not asked us to delete
-- their canvas, and inferring the mode from `flow is not null` would mean exactly that. The
-- mode decides; the graph is kept.
--
-- **A version records one column, and the rule is the other way round there.** A published
-- version is a fact about a call that already happened, and there is no editor to return to,
-- so `agent_prompt_versions.flow` is non-null if and only if that version answered the phone
-- as a graph. One column that cannot disagree with itself beats two that can.
--
-- **Rule 4 is unchanged and this migration is careful with it.** Nothing new reads
-- `agent_config_drafts`. The staged flow is written through `app.stage_agent_draft_selection`,
-- which is already one of the four functions allowed to know that table exists, because a
-- canvas is a section of the draft in exactly the way a tool selection is: saved on its own
-- screen at its own moment, and it must not blank the greeting somebody staged an hour ago.
-- `packages/db/src/drafts.test.ts` holds that line and this migration keeps it.

-- ---------------------------------------------------------------------------
-- Where a graph lives
-- ---------------------------------------------------------------------------

alter table agents
  add column if not exists flow jsonb;

alter table agents
  add column if not exists authoring_mode text not null default 'form';

-- Named and re-created rather than added blind, so this file can be read as the definition
-- of the constraint rather than as one of two places it might be.
alter table agents drop constraint if exists agents_authoring_mode_check;
alter table agents add constraint agents_authoring_mode_check
  check (authoring_mode in ('form', 'flow'));

comment on column agents.flow is
  'The conversation graph, in the shape of packages/shared/src/flow.ts. Null means nobody has drawn one. Present while authoring_mode is ''form'' means a canvas was drawn and set aside, not a graph that is live — read authoring_mode for that. See migration 0060.';

comment on column agents.authoring_mode is
  'Which editor authored this agent and which director runs it: ''form'' reads captured_fields, ''flow'' reads flow. Defaults to ''form'', which every agent predating migration 0060 is.';

-- The staged copy. Both nullable, and null means "not staged" rather than "empty" — the same
-- distinction `captured_fields`, `enabled_tools` and the two behaviour flags carry since 0041,
-- and for the same reason: four editors saved at four different moments, and a draft holding
-- only a graph is an ordinary state.
alter table agent_config_drafts
  add column if not exists flow jsonb;

alter table agent_config_drafts
  add column if not exists authoring_mode text;

alter table agent_config_drafts drop constraint if exists agent_config_drafts_authoring_mode_check;
alter table agent_config_drafts add constraint agent_config_drafts_authoring_mode_check
  check (authoring_mode is null or authoring_mode in ('form', 'flow'));

comment on column agent_config_drafts.flow is
  'The staged conversation graph. Null is not staged, which is not the same as an empty graph — an empty graph is two nodes and an edge. See migration 0060.';

comment on column agent_config_drafts.authoring_mode is
  'The staged authoring mode, or null when the operator has not changed which editor this agent uses. Reaches the agent only through a publish.';

-- The record. Null here says this version answered the phone as a form.
alter table agent_prompt_versions
  add column if not exists flow jsonb;

comment on column agent_prompt_versions.flow is
  'The graph this version ran on, or null when it ran as a form. Non-null is the record that the version was flow-authored — agent_prompt_versions has no authoring_mode column on purpose, because one column cannot contradict itself. See migration 0060.';

-- ---------------------------------------------------------------------------
-- Staging one
-- ---------------------------------------------------------------------------

/*
 * The canvas is a section of the draft, so it is staged by the function that stages sections.
 *
 * Not a `save_agent_flow` of its own, and the reason is Rule 4 rather than tidiness: every
 * function that mentions `agent_config_drafts` is on an allow-list asserted in
 * `drafts.test.ts`, and a fifth name on that list is a fifth thing somebody has to be sure
 * about. This one is already there and already coalesces, which is exactly the semantics a
 * graph needs — saving a graph must not blank a staged tool selection, and saving a tool
 * selection must not blank the graph.
 *
 * The seven-argument form is dropped rather than left beside this. Two functions differing
 * only in what they forget is how a caller silently gets the forgetful one; the existing
 * seven-argument call sites resolve to this through the defaults.
 */
drop function if exists app.stage_agent_draft_selection(uuid, uuid, jsonb, text[], uuid[], boolean, boolean);

create or replace function app.stage_agent_draft_selection(
  agent uuid,
  p_author uuid,
  p_fields jsonb,
  p_tools text[],
  p_knowledge uuid[],
  p_barge_in boolean,
  p_amd boolean,
  p_flow jsonb default null,
  p_authoring_mode text default null)
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
     barge_in, answering_machine_detection, flow, authoring_mode, updated_by)
  values (agent, owner, p_fields, p_tools, p_knowledge, p_barge_in, p_amd,
          p_flow, p_authoring_mode, p_author)
  on conflict (agent_id) do update
     set captured_fields   = coalesce(excluded.captured_fields, agent_config_drafts.captured_fields),
         enabled_tools     = coalesce(excluded.enabled_tools, agent_config_drafts.enabled_tools),
         knowledge_sources = coalesce(excluded.knowledge_sources, agent_config_drafts.knowledge_sources),
         barge_in          = coalesce(excluded.barge_in, agent_config_drafts.barge_in),
         answering_machine_detection =
           coalesce(excluded.answering_machine_detection,
                    agent_config_drafts.answering_machine_detection),
         flow              = coalesce(excluded.flow, agent_config_drafts.flow),
         authoring_mode    = coalesce(excluded.authoring_mode, agent_config_drafts.authoring_mode),
         updated_by        = excluded.updated_by
  returning updated_at into saved;

  return saved;
end
$function$;

comment on function app.stage_agent_draft_selection(uuid, uuid, jsonb, text[], uuid[], boolean, boolean, jsonb, text) is
  'Stages one section of an agent''s draft, leaving the others as they were. Null when the agent does not exist, is deleted, or belongs to another organisation. Gained the graph and the authoring mode in migration 0060.';

-- `app.save_agent_draft` and `app.discard_agent_draft` are deliberately untouched. The first
-- writes the configuration *document* — the greeting, the persona, the escalation — and a
-- graph is not part of that document any more than a tool selection is. The second deletes
-- the row, and the graph goes with it because it is a column on that row.

-- ---------------------------------------------------------------------------
-- Publishing one
-- ---------------------------------------------------------------------------

/*
 * Put a staged graph onto the agent without bumping the version.
 *
 * `app.apply_captured_fields`' sibling, and for the identical reason: publishing bumps the
 * version once for the whole act, and the snapshot the publish writes reads the graph off the
 * agent row — so this runs inside the publish transaction and before it. Adding a `p_flow` to
 * `publish_agent_config_for_agent` instead would have widened a fifteen-argument positional
 * signature that four call sites already pass by position, which is how an argument silently
 * lands in the wrong slot.
 *
 * Null leaves a column alone, so a caller that only switched the mode does not blank the
 * canvas, and one that only redrew the canvas does not turn the form back on.
 *
 * SECURITY INVOKER, like both siblings: RLS on `agents` is what stops this writing into
 * another organisation's agent, and a zero-row update comes back as false.
 */
create or replace function app.apply_agent_flow(agent uuid, p_flow jsonb, p_authoring_mode text)
  returns boolean
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $function$
declare
  changed integer;
begin
  update agents
     set flow           = coalesce(p_flow, flow),
         authoring_mode = coalesce(p_authoring_mode, authoring_mode)
   where id = agent and deleted_at is null;
  get diagnostics changed = row_count;
  return changed > 0;
end
$function$;

comment on function app.apply_agent_flow(uuid, jsonb, text) is
  'Puts a staged conversation graph and authoring mode on the agent without bumping the version, for the publish transaction to snapshot. Null leaves a column alone. See migration 0060.';

/*
 * The publish, snapshotting the graph.
 *
 * `create or replace` and not a new signature: the argument list is unchanged, so the four
 * positional call sites are unchanged and — the reason 0057 exists — the grants are not
 * reset. The body differs from 0052's by one column in the insert and this comment.
 *
 * The snapshot reads `a.flow` through the mode rather than copying it raw. A version is a
 * record of what answered the phone, and an agent that was published as a form while a
 * disused canvas sat in its column was, on that call, a form.
 */
CREATE OR REPLACE FUNCTION app.publish_agent_config_for_agent(p_agent uuid, p_name text, p_voice_id text, p_speaking_rate real, p_greeting text, p_persona text, p_instructions text, p_keyterms text[], p_tool_config jsonb, p_event_config jsonb, p_escalation_to text, p_escalation_from text, p_escalation_ring integer, p_note text, p_policy_blocks jsonb DEFAULT NULL::jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  organization  uuid;
  next_version  integer;
begin
  if app.current_organization() is null then
    raise exception
      'publish_agent_config_for_agent needs the organization scope set: select set_config(''app.organization_id'', ...)';
  end if;

  select a.organization_id into organization
    from agents a
   where a.id = p_agent and a.deleted_at is null;

  -- Not ours reads as no such agent, matching `GET /agents/:agentId`. A distinct error would
  -- confirm the id belongs to somebody.
  if organization is null or organization is distinct from app.current_organization() then
    raise exception 'no such agent: %', p_agent
      using errcode = 'no_data_found';
  end if;

  -- The tool and event registries are still the organisation's and still travel with a
  -- publish, because they are genuinely part of what an agent does on a call and the endpoints
  -- that edit them publish a version to record the change. Hours are not: nothing about them
  -- is an agent's, and no version has ever recorded one.
  update organizations
     set tool_config  = p_tool_config,
         event_config = p_event_config
   where id = organization;

  update agents
     set name                    = coalesce(p_name, name),
         voice_id                = p_voice_id,
         speaking_rate           = p_speaking_rate,
         greeting                = p_greeting,
         persona                 = p_persona,
         instructions            = p_instructions,
         keyterms                = coalesce(p_keyterms, '{}'),
         escalation_to_number    = p_escalation_to,
         escalation_from_number  = p_escalation_from,
         escalation_ring_seconds = p_escalation_ring,
         /* Null leaves them alone; an empty array clears them. See 0046. */
         policy_blocks           = coalesce(p_policy_blocks, policy_blocks),
         config_version          = config_version + 1
   where id = p_agent
   returning config_version into next_version;

  if next_version is null then
    raise exception 'no such agent: %', p_agent;
  end if;

  insert into agent_prompt_versions
    (organization_id, agent_id, version, name, voice_id, greeting, persona, instructions,
     keyterms, captured_fields, speaking_rate,
     tool_config, event_config,
     escalation_to_number, escalation_from_number, escalation_ring_seconds, note,
     policy_blocks, flow)
  select a.organization_id, a.id, a.config_version, a.name, a.voice_id, a.greeting, a.persona,
         a.instructions, a.keyterms, a.captured_fields, a.speaking_rate,
         p_tool_config, p_event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         p_note,
         a.policy_blocks,
         -- Null unless this version was published as a graph. See the header.
         case when a.authoring_mode = 'flow' then a.flow end
    from agents a where a.id = p_agent;

  -- A draft cannot survive its own publication and leave the console reporting unpublished
  -- changes that are already live.
  delete from agent_config_drafts where agent_id = p_agent;

  return next_version;
end;
$function$;

-- `app.publish_agent_config` is untouched and still carries the graph. Since 0052 it is only
-- the organisation-scoped resolver in front of the function above — it picks the oldest live
-- agent and forwards — so widening it would add an argument that has nowhere to go, and it
-- would land on the allow-list in `drafts.test.ts` that it was correctly removed from.

-- ---------------------------------------------------------------------------
-- Reading one
-- ---------------------------------------------------------------------------

/*
 * Every read path a call uses gains two columns.
 *
 * `drop` and `create`, because `create or replace` cannot change a function's return type —
 * and per 0057 that resets the ACL and hands PUBLIC execute on everything it recreates. The
 * grants at the bottom of this section put back exactly what `pg_proc` held before it:
 *
 *   agent_config_for_id            postgres only          (no PUBLIC, no ansa_app)
 *   agent_config_for_agent         postgres, ansa_app     (no PUBLIC)
 *   agent_config_at_version        postgres, ansa_app     (no PUBLIC)
 *   agent_config_for_number        (default)
 *   agent_config_for_organization  (default)
 *
 * Dropped in dependency order — the two that call `agent_config_for_id` first — and created
 * in the reverse of it.
 *
 * Both columns travel together. Returning the graph without the mode would leave the reader
 * to infer which director to run from whether the graph is null, which is precisely the
 * inference the two columns exist to avoid.
 */
drop function if exists app.agent_config_for_organization(uuid);
drop function if exists app.agent_config_for_agent(uuid);
drop function if exists app.agent_config_for_number(text);
drop function if exists app.agent_config_for_id(uuid);

create function app.agent_config_for_id(agent uuid)
 returns table(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, speaking_rate real, amd_enabled boolean, captured_fields jsonb, policy_blocks jsonb, crisis_handoff_number text, flow jsonb, authoring_mode text)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select t.id, a.id, a.name, a.keyterms, a.voice_id, a.greeting, a.persona, a.instructions,
         t.business_open_hour, t.business_close_hour, t.business_days,
         t.tool_config,
         (select coalesce(array_agg(at.tool_name), '{}')
            from agent_tools at where at.agent_id = a.id),
         t.event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         (select jsonb_object_agg(c.ref, c.sealed)
            from organization_credentials c where c.organization_id = t.id),
         a.config_version, a.barge_in, a.speaking_rate, a.answering_machine_detection,
         a.captured_fields,
         a.policy_blocks,
         t.crisis_handoff_number,
         /* The agent's own columns, like everything else here. No unpublished work is
            consulted and none can be, because the table holding it is not named anywhere in
            this function — which is Rule 4 and is asserted over `prosrc` in
            `drafts.test.ts`, so even naming it in a comment fails the build. It did. */
         a.flow,
         a.authoring_mode
    from agents a
    join organizations t on t.id = a.organization_id
   where a.id = agent
   limit 1
$function$;

create function app.agent_config_for_number(dialled text)
 returns table(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, speaking_rate real, amd_enabled boolean, captured_fields jsonb, policy_blocks jsonb, crisis_handoff_number text, flow jsonb, authoring_mode text)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select t.id, a.id, a.name, a.keyterms, a.voice_id, a.greeting, a.persona, a.instructions,
         t.business_open_hour, t.business_close_hour, t.business_days,
         t.tool_config,
         (select coalesce(array_agg(at.tool_name), '{}')
            from agent_tools at where at.agent_id = a.id),
         t.event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         (select jsonb_object_agg(c.ref, c.sealed)
            from organization_credentials c where c.organization_id = t.id),
         a.config_version, a.barge_in, a.speaking_rate, a.answering_machine_detection,
         a.captured_fields,
         a.policy_blocks,
         t.crisis_handoff_number,
         a.flow,
         a.authoring_mode
    from agents a
    join organizations t on t.id = a.organization_id
   -- An archived agent does not answer. Its number should have been released first, but
   -- a number left behind must ring nobody rather than ring a retired script.
   where a.dialled_number = dialled and a.deleted_at is null
   limit 1
$function$;

create function app.agent_config_for_agent(agent uuid)
 returns table(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, speaking_rate real, amd_enabled boolean, captured_fields jsonb, policy_blocks jsonb, crisis_handoff_number text, flow jsonb, authoring_mode text)
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  owner_organization uuid;
begin
  if app.current_organization() is null then
    raise exception
      'agent_config_for_agent needs the organization scope set: select set_config(''app.organization_id'', ...)';
  end if;

  select a.organization_id into owner_organization
    from agents a where a.id = agent;

  -- Not ours reads exactly as does not exist, which is the same answer RLS would give and the
  -- same one `GET /agents/:agentId` gives. Distinguishing them would confirm that an id
  -- belongs to somebody, and the id is the only thing an attacker needs to be told.
  if owner_organization is null or owner_organization is distinct from app.current_organization() then
    return;
  end if;

  return query select * from app.agent_config_for_id(agent);
end;
$function$;

create function app.agent_config_for_organization(organization uuid)
 returns table(id uuid, agent_id uuid, name text, keyterms text[], voice_id text, greeting text, persona text, instructions text, business_open_hour integer, business_close_hour integer, business_days integer[], tool_config jsonb, enabled_tools text[], event_config jsonb, escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, credentials jsonb, config_version integer, barge_in boolean, speaking_rate real, amd_enabled boolean, captured_fields jsonb, policy_blocks jsonb, crisis_handoff_number text, flow jsonb, authoring_mode text)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select * from app.agent_config_for_id((
    select a.id from agents a
     where a.organization_id = organization and a.deleted_at is null
     order by a.created_at, a.id
     limit 1
  ))
$function$;

-- The ACLs, restored to what they were before the drops above. See 0050 and 0057 for why
-- these two are not PUBLIC: both take an id straight from a request path.
revoke execute on function app.agent_config_for_id(uuid) from public;
revoke execute on function app.agent_config_for_agent(uuid) from public;
grant execute on function app.agent_config_for_agent(uuid) to ansa_app;

/*
 * And the history, which answers "what was this agent on version 7" — including whether it
 * was a graph at all.
 */
drop function if exists app.agent_config_at_version(uuid, integer);

create function app.agent_config_at_version(agent uuid, v integer)
 returns table(name text, voice_id text, greeting text, persona text, instructions text, keyterms text[], escalation_to_number text, escalation_from_number text, escalation_ring_seconds integer, version integer, flow jsonb)
 language sql
 stable
 set search_path to 'public', 'pg_temp'
as $function$
  select p.name, p.voice_id, p.greeting, p.persona, p.instructions, p.keyterms,
         p.escalation_to_number, p.escalation_from_number,
         p.escalation_ring_seconds, p.version, p.flow
    from agent_prompt_versions p
   where p.agent_id = agent and p.version = v
$function$;

comment on function app.agent_config_at_version(uuid, integer) is
  'One published version of an agent. `flow` is non-null exactly when that version answered the phone as a graph. See migration 0060.';

revoke execute on function app.agent_config_at_version(uuid, integer) from public;
grant execute on function app.agent_config_at_version(uuid, integer) to ansa_app;
