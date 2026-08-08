-- Outbound exists now, so a call record has to say which way it went.
--
-- The column was deliberately absent until 2026-08-08: CLAUDE.md said inbound only and
-- warned against a `direction` column added in anticipation. It is added here because
-- two lifecycles genuinely differ, which is the bar that rule set.

alter table calls add column if not exists direction text not null default 'inbound'
  check (direction in ('inbound', 'outbound'));

-- The consent basis that was in force when an outbound call was placed.
--
-- Snapshotted rather than joined. R7.5 wants a call explainable weeks later, and a tenant
-- that changes its policy afterwards would otherwise rewrite the history of every call it
-- ever made — which is precisely the record a regulator would ask for.
alter table calls add column if not exists consent_policy text;
alter table calls add column if not exists consent_basis  text;

-- The carrier's own terminal status: completed, busy, no-answer, failed, canceled. An
-- outbound call that reached nobody produces no turns at all, so without this it is
-- indistinguishable in the log from one that was never placed.
alter table calls add column if not exists carrier_status text;
alter table calls add column if not exists duration_seconds integer;

create index if not exists calls_tenant_created_idx on calls (tenant_id, created_at desc);
create index if not exists call_events_call_idx on call_events (call_id, at);
