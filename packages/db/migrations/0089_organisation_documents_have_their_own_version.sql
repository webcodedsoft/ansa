-- The tool registry and the webhook subscriptions get a version of their own.
--
-- Both are the organisation's: `organizations.tool_config` and `organizations.event_config`,
-- shared by every agent. But the only way to write them was to publish an *agent*
-- configuration version, because that was the only versioned write there was when they
-- arrived (0013, 0014), and the version number the console compared against was the agent's
-- `config_version`. Migration 0047 made `app.live_agent_for_organization` refuse to guess
-- between two live agents — correctly — and from that day an organisation with a second agent
-- could not save a tool or a webhook at all. Every attempt answered "has N live agents, so
-- there is no single agent this route can mean". The console showed "Something went wrong".
--
-- This is the version those two documents compare against and bump. A plain column rather
-- than a function: `organizations` is writable by `ansa_app` under its RLS policy, and the
-- optimistic check is one `where documents_version = $expected`. Agent publishes go on
-- snapshotting `tool_config` and `event_config` into their own versions exactly as before,
-- so a call from three weeks ago is still explained by the version it ran on.

alter table organizations
  add column if not exists documents_version integer not null default 1;

comment on column organizations.documents_version is
  'Bumped by every save of the tool registry or the webhook subscriptions; what the console compares against. Independent of any agent''s config_version.';
