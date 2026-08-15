-- An organisation stops pretending to be an agent.
--
-- Migration 0018 copied the agent-shaped columns to `agents` and left the originals on
-- `organizations`, deliberately: "dropping them in the same migration that starts writing
-- to `agents` leaves no way back if the copy turns out to be wrong". The copy was right,
-- and eight migrations have gone by. What is left is thirteen columns that nothing reads,
-- nothing writes, and that still hold whatever they held in August — a greeting no caller
-- has heard since, sitting in a column called `greeting`.
--
-- That is not merely untidy. It is the shape of the next bug: somebody writes
-- `select greeting from organizations`, gets a plausible string, and ships it.
--
-- What an organisation keeps is what actually belongs to it, and it is deliberately short:
--
--   name                  what it is called
--   audio_retention_days  how long a caller's voice is kept — operator-set
--   consent_*             the legal basis and the calling window — operator-set, NDPR/NCC
--   tool_config           the shared tool registry its agents draw from
--   event_config          where a record of a call is pushed
--   created_at
--
-- Everything a caller experiences belongs to an agent. The two are separate documents
-- rather than one with defaults and overrides, because they answer different questions —
-- and an organisation will grow features (billing, roles, retention policy) that no agent
-- should inherit a field from.

alter table organizations drop column if exists greeting;
alter table organizations drop column if exists persona;
alter table organizations drop column if exists instructions;
alter table organizations drop column if exists voice_id;
alter table organizations drop column if exists keyterms;

alter table organizations drop column if exists business_open_hour;
alter table organizations drop column if exists business_close_hour;
alter table organizations drop column if exists business_days;

alter table organizations drop column if exists escalation_to_number;
alter table organizations drop column if exists escalation_from_number;
alter table organizations drop column if exists escalation_ring_seconds;

-- Routing moved to `agents.dialled_number` in 0018, and ownership to
-- `organization_numbers` in 0019. This column has routed nothing since.
alter table organizations drop column if exists dialled_number;

-- Versions are per agent (0018). An organisation-wide version number could only ever
-- match one of its agents' by coincidence.
alter table organizations drop column if exists config_version;
