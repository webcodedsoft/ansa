-- Publishing consumes the draft, and one place decides which agent a config endpoint means.
--
-- 0038 added somewhere to save unpublished work. This closes the loop: once that work is live
-- it is no longer unpublished, and the row has to go in the *same transaction* as the publish.
-- Deleting it from the API afterwards would leave a window where the configuration is live and
-- the console still says there are unpublished changes — and if that delete failed, it would
-- say so forever, about a draft identical to what is already answering the phone.
--
-- `publish_agent_config` already resolves the agent it is publishing to, so the delete costs
-- one statement and cannot pick a different agent than the publish did. The body below is
-- 0037's, unchanged except for that statement and this comment.

-- The sixteen-argument form, left behind when 0037 added `p_speaking_rate` and created a new
-- signature beside the old one rather than replacing it. Nothing calls it — the one caller
-- passes seventeen — but it is still resolvable, and what it would do if resolved is publish a
-- version that silently drops the speaking rate, skips it in the snapshot, and now also leaves
-- the draft in place. An overload that differs from the real one only in what it forgets is
-- worth deleting rather than documenting.
drop function if exists app.publish_agent_config(uuid, text, text, text, text, text, text[], integer, integer, integer[], jsonb, jsonb, text, text, integer, text);

CREATE OR REPLACE FUNCTION app.publish_agent_config(organization uuid, p_name text, p_voice_id text, p_speaking_rate real, p_greeting text, p_persona text, p_instructions text, p_keyterms text[], p_open_hour integer, p_close_hour integer, p_business_days integer[], p_tool_config jsonb, p_event_config jsonb, p_escalation_to text, p_escalation_from text, p_escalation_ring integer, p_note text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  target_agent uuid;
  next_version integer;
begin
  if app.current_organization() is distinct from organization then
    raise exception
      'publish_agent_config needs the organization scope set: select set_config(''app.organization_id'', ...)';
  end if;

  select a.id into target_agent
    from agents a
   where a.organization_id = organization and a.deleted_at is null
   order by a.created_at, a.id
   limit 1;

  if target_agent is null then
    raise exception 'organization % has no live agent to publish to', organization;
  end if;

  update organizations
     set tool_config         = p_tool_config,
         event_config        = p_event_config,
         business_open_hour  = p_open_hour,
         business_close_hour = p_close_hour,
         business_days       = p_business_days
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
         config_version          = config_version + 1
   where id = target_agent
   returning config_version into next_version;

  if next_version is null then
    raise exception 'no such agent: %', target_agent;
  end if;

  insert into agent_prompt_versions
    (organization_id, agent_id, version, name, voice_id, greeting, persona, instructions,
     keyterms, captured_fields, speaking_rate,
     tool_config, event_config,
     escalation_to_number, escalation_from_number, escalation_ring_seconds, note)
  select a.organization_id, a.id, a.config_version, a.name, a.voice_id, a.greeting, a.persona,
         a.instructions, a.keyterms, a.captured_fields, a.speaking_rate,
         p_tool_config, p_event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         p_note
    from agents a where a.id = target_agent;

  -- The new statement. Unconditional, because there is usually no draft: a publish can come
  -- from a script or from `tools/organization/config.mjs`, neither of which saves one, and
  -- deleting nothing is not a failure. What matters is that a draft cannot survive its own
  -- publication and leave the console reporting unpublished changes that are already live.
  delete from agent_config_drafts where agent_id = target_agent;

  return next_version;
end
$function$;

/*
 * The agent an organisation-scoped configuration endpoint is talking about.
 *
 * Extracted rather than repeated because `publish_agent_config` has always picked the oldest
 * live agent, and the draft endpoints have to pick the same one — otherwise a publish would
 * consume a draft belonging to a different agent than the one it published to. One
 * definition, so the two cannot drift.
 *
 * This is a placeholder for a real answer and worth saying so plainly: with more than one
 * agent per organisation the configuration API needs the agent in its route, and "the oldest
 * one" is a guess that is right only while every organisation has exactly one. It is the same
 * limitation `TASKS.md` already records against `config.*`.
 */
create or replace function app.live_agent_for_organization(organization uuid)
  returns uuid
  language sql
  stable
  set search_path to 'public', 'pg_temp'
as $function$
  select a.id
    from agents a
   where a.organization_id = organization and a.deleted_at is null
   order by a.created_at, a.id
   limit 1;
$function$;

comment on function app.live_agent_for_organization(uuid) is
  'The agent an organisation-scoped config endpoint acts on: the oldest live one, exactly as publish_agent_config picks it. See migration 0039.';

-- ---------------------------------------------------------------------------
-- Where a draft came from
-- ---------------------------------------------------------------------------

-- Restoring an old version now fills the draft instead of publishing, which is the right
-- shape but drops something the old rollback had: it wrote "restored from version 4" into the
-- note by itself, so the history could answer why version 9 looks like version 4. A draft has
-- no note — a note explains a version, and a draft is not one — so the provenance is carried
-- here instead and the publish dialog offers it as the note.
--
-- Null is the ordinary case: a draft somebody typed came from nowhere but their keyboard.
alter table agent_config_drafts add column if not exists restored_from integer;

comment on column agent_config_drafts.restored_from is
  'The published version this draft was loaded from, or null when it was typed. Offered as the note when it is published.';

create or replace function app.save_agent_draft(agent uuid, p_config jsonb, p_author uuid, p_restored_from integer)
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

  if owner is null then
    return null;
  end if;

  if app.current_organization() is distinct from owner then
    raise exception
      'save_agent_draft needs the organization scope set: select set_config(''app.organization_id'', ...)';
  end if;

  insert into agent_config_drafts (agent_id, organization_id, config, updated_by, restored_from)
  values (agent, owner, p_config, p_author, p_restored_from)
  on conflict (agent_id) do update
     set config        = excluded.config,
         updated_by    = excluded.updated_by,
         -- Overwritten rather than kept: once somebody edits a restored draft it is their
         -- work, and offering "restored from version 4" as the note for it would be wrong.
         restored_from = excluded.restored_from
  returning updated_at into saved;

  return saved;
end
$function$;

-- The three-argument form from 0038 is replaced, not overloaded. Two functions differing only
-- in arity is how a caller ends up silently getting the one that forgets a field.
drop function if exists app.save_agent_draft(uuid, jsonb, uuid);

comment on function app.save_agent_draft(uuid, jsonb, uuid, integer) is
  'Upserts the unpublished configuration for one agent. Null when the agent does not exist, is deleted, or belongs to another organisation.';
