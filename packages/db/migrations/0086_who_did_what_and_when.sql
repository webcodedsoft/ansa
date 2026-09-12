-- The audit log: who did what to this organisation, and when.
--
-- The console has had an Audit log page since the sidebar was drawn, and it has said "not
-- available through the API yet" the whole time. The record it promised existed only as
-- side effects — a session row, an audio access row, an invitation's `invited_by` — spread
-- over tables that answer different questions and cannot be listed as one. This is the one
-- table that answers "what happened here", written by the API at the moment of each act.
--
-- Shape, and the reasons:
--
-- - `actor_name` is stored, not joined. The `users` policy shows a person only through a
--   live membership, so the name of somebody who was removed last month would vanish from
--   the log the moment they left — which is exactly when a log is read. The name is what
--   they were called when they did the thing.
-- - `subject_label` likewise: an agent that was retired, a credential that was removed.
-- - `action` is a slug the API owns; `detail` is whatever that action wants to say (a
--   version number, a role, a phone number). The console turns both into a sentence.
-- - Insert and select only for the application role. An audit row that the application
--   can update or delete is a diary, not an audit.
--
-- Backfilled from what already existed, with the actor where a table recorded one and null
-- where it did not — a removal before today has no author, and the log says so rather than
-- guessing.

create table if not exists audit_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  occurred_at     timestamptz not null default now(),
  actor_user_id   uuid references users(id) on delete set null,
  actor_name      text,
  action          text not null,
  subject_kind    text,
  subject_id      text,
  subject_label   text,
  detail          jsonb not null default '{}'::jsonb
);

comment on table audit_events is
  'One row per act of a person on this organisation, written by the API as it happens. Insert-only for the application role.';

create index if not exists audit_events_organization_time_idx
  on audit_events (organization_id, occurred_at desc, id desc);
create index if not exists audit_events_organization_action_idx
  on audit_events (organization_id, action, occurred_at desc);

alter table audit_events enable row level security;
alter table audit_events force row level security;

drop policy if exists organization_isolation on audit_events;
create policy organization_isolation on audit_events
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

grant select, insert on audit_events to ansa_app;

-- ---------------------------------------------------------------------------------------
-- What the other tables already knew.
-- ---------------------------------------------------------------------------------------

insert into audit_events (organization_id, occurred_at, actor_user_id, actor_name, action, subject_kind, subject_id, subject_label, detail)
select s.organization_id, s.created_at, s.user_id, u.display_name, 'signed_in', 'account', s.user_id::text, u.display_name,
       jsonb_build_object('userAgent', s.user_agent)
  from sessions s
  left join users u on u.id = s.user_id;

insert into audit_events (organization_id, occurred_at, actor_user_id, actor_name, action, subject_kind, subject_id, subject_label, detail)
select l.organization_id, l.at, l.user_id, u.display_name, 'recording_listened', 'call', l.call_id::text, l.caller, '{}'::jsonb
  from audio_access_log l
  left join users u on u.id = l.user_id
 where l.call_id is not null;

insert into audit_events (organization_id, occurred_at, actor_user_id, actor_name, action, subject_kind, subject_id, subject_label, detail)
select i.organization_id, i.created_at, i.invited_by, u.display_name, 'member_invited', 'invitation', i.id::text, i.email,
       jsonb_build_object('role', i.role)
  from invitations i
  left join users u on u.id = i.invited_by;

insert into audit_events (organization_id, occurred_at, actor_user_id, actor_name, action, subject_kind, subject_id, subject_label, detail)
select i.organization_id, i.accepted_at, i.accepted_user_id, u.display_name, 'invitation_accepted', 'invitation', i.id::text, i.email,
       jsonb_build_object('role', i.role)
  from invitations i
  left join users u on u.id = i.accepted_user_id
 where i.accepted_at is not null;

insert into audit_events (organization_id, occurred_at, actor_user_id, actor_name, action, subject_kind, subject_id, subject_label, detail)
select i.organization_id, i.revoked_at, null, null, 'invitation_revoked', 'invitation', i.id::text, i.email, '{}'::jsonb
  from invitations i
 where i.revoked_at is not null;

insert into audit_events (organization_id, occurred_at, actor_user_id, actor_name, action, subject_kind, subject_id, subject_label, detail)
select m.organization_id, m.deleted_at, null, null, 'member_removed', 'member', m.user_id::text, u.display_name, '{}'::jsonb
  from memberships m
  left join users u on u.id = m.user_id
 where m.deleted_at is not null;

insert into audit_events (organization_id, occurred_at, actor_user_id, actor_name, action, subject_kind, subject_id, subject_label, detail)
select m.organization_id, m.suspended_at, null, null, 'access_revoked', 'member', m.user_id::text, u.display_name, '{}'::jsonb
  from memberships m
  left join users u on u.id = m.user_id
 where m.suspended_at is not null;

-- `published_by` on the versions table is the database role name, not a person, so the
-- author is unknown for every version published before today.
insert into audit_events (organization_id, occurred_at, actor_user_id, actor_name, action, subject_kind, subject_id, subject_label, detail)
select v.organization_id, v.published_at, null, null, 'agent_published', 'agent', v.agent_id::text, coalesce(a.name, v.name),
       jsonb_build_object('version', v.version, 'note', v.note)
  from agent_prompt_versions v
  left join agents a on a.id = v.agent_id
 where v.agent_id is not null;
