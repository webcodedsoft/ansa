-- Restoring what 0056 gave away.
--
-- Postgres grants EXECUTE to PUBLIC on every newly created function. 0056 dropped and
-- recreated four of these to widen their return type, and so handed PUBLIC execute on all
-- four — including `agent_config_for_id`, which migration 0050 had revoked from ansa_app on
-- purpose: it takes an agent id straight from a request path, and an organisation that
-- could execute it could read another organisation's configuration by guessing a uuid.
--
-- The ACLs before 0056, read from pg_proc:
--
--   agent_config_for_id            postgres=X/postgres                     (no PUBLIC, no ansa_app)
--   agent_config_for_agent         postgres=X/postgres | ansa_app=X/postgres
--   agent_config_for_number        (default)
--   agent_config_for_organization  (default)
--
-- The two SECURITY DEFINER functions that take an id are locked back down. The other two
-- are left at the default they had, because they were never restricted: one is keyed on a
-- dialled number the carrier supplies and the other resolves the organisation from the
-- caller's own scope.
--
-- The lesson worth keeping: `drop function` plus `create function` is not `create or
-- replace`. It resets privileges, and a migration that widens a signature has to say so.
revoke execute on function app.agent_config_for_id(uuid) from public;
revoke execute on function app.agent_config_for_agent(uuid) from public;

-- Unchanged from before 0056: the agent-scoped one checks the organisation itself.
grant execute on function app.agent_config_for_agent(uuid) to ansa_app;
