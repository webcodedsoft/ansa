-- A destination for the call nobody plans for.
--
-- `docs/ansa-agent-prompt.md` is explicit that this cannot be a default somebody fills in:
-- "a named human queue that answers regardless of hours, and a documented policy from each
-- tenant. Make it a required field during onboarding... Getting this wrong is the failure
-- mode with the worst consequences."
--
-- Nullable, because every organisation that already exists predates the column and a NOT
-- NULL here would refuse their next call rather than prompt anybody to fill it in. Absence
-- is surfaced instead: `GET /numbers` reports it as a readiness problem, so it is visible
-- rather than merely unset, and the ordinary handoff is used until it is set.
--
-- Separate from `escalation_to_number` on purpose. That one is an office line and the
-- prompt tells the agent to offer a ticket outside business hours; this one is dialled
-- whatever the hour, because somebody in trouble at two in the morning is the case it
-- exists for.
alter table organizations add column if not exists crisis_handoff_number text;

comment on column organizations.crisis_handoff_number is
  'E.164. Answers regardless of business hours. Dialled only for a caller in danger.';
