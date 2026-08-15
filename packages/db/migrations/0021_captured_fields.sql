-- What an agent collects, as an ordered document on the agent.
--
-- The console's "Data captured" tab has been honest until now: there was no endpoint for a
-- per-field capture schema, so the tab said so rather than showing inputs that published
-- nowhere. This gives it somewhere to save.
--
-- A jsonb column rather than a `captured_fields` table, and that is a considered choice
-- rather than laziness:
--
--   * Order is part of the meaning. A voice form is conducted in sequence, and a caller
--     asked for a date of birth before a policy number is having a different conversation.
--     An array has an order; rows need a position column that every reorder has to rewrite.
--   * It is read whole, always. The orchestrator needs every field at call start, and no
--     query wants one field of one agent.
--   * It versions with the agent. Publishing a configuration should carry the form it
--     conducts, and one column travels with `tenant_prompt_versions` far more easily than
--     a child table does.
--
-- Validation lives in the API, not here — the same argument as `tool_config`: the shape
-- belongs to the code that parses it, and a CHECK duplicating a zod schema is two
-- definitions that drift. What the database does enforce is that it is an array, which is
-- the one assumption every reader makes.

alter table agents
  add column if not exists captured_fields jsonb not null default '[]'::jsonb;

alter table agents drop constraint if exists agents_captured_fields_is_array;
alter table agents add constraint agents_captured_fields_is_array
  check (jsonb_typeof(captured_fields) = 'array');

comment on column agents.captured_fields is
  'Ordered array of capture-field definitions: {key, type, prompt, capture, confirm, pattern, attempts, required, redact, options}. Parsed by apps/api/src/api/agents. Order is the order the agent asks.';
