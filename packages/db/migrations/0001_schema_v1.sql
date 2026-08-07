-- Schema v1. tenant_id on every table from the start (R7.1), isolation enforced by
-- Postgres RLS rather than by application code (R7.2).
--
-- Inbound only: there is no direction column anywhere in this file and there should
-- never be one. `audio_segments.source` distinguishes the two audio tracks of a call,
-- which is not the same concept and must not be reused as one.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenant context
-- ---------------------------------------------------------------------------

create schema if not exists app;

-- The tenant the current transaction is acting for, set by `set local app.tenant_id`.
-- Returns NULL when unset, which makes every policy below fail closed: an unscoped
-- connection sees nothing rather than everything.
create or replace function app.current_tenant() returns uuid
  language sql
  stable
as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists tenants (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  -- Per-tenant retention for stored call audio.
  audio_retention_days  integer not null default 30 check (audio_retention_days > 0),
  created_at            timestamptz not null default now()
);

create table if not exists calls (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  -- The carrier's identifier for this call. Named for the concept, not the vendor:
  -- swapping telephony providers must not require a migration.
  carrier_call_id  text not null,
  dialled          text not null,
  caller           text,
  answered_at      timestamptz,
  ended_at         timestamptz,
  end_reason       text,
  -- Which tenant config version served this call (R7.5), so a call from three weeks
  -- ago can still be explained.
  config_version   integer,
  created_at       timestamptz not null default now(),
  unique (tenant_id, carrier_call_id)
);

create table if not exists call_events (
  id         bigserial primary key,
  tenant_id  uuid not null references tenants(id) on delete cascade,
  call_id    uuid not null references calls(id) on delete cascade,
  -- Milliseconds since the media stream opened. Wall-clock is unreliable for ordering
  -- across providers; this is what the orchestrator correlates on (R4.1.7).
  offset_ms  integer,
  kind       text not null,
  detail     jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);

create table if not exists turns (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  call_id            uuid not null references calls(id) on delete cascade,
  seq                integer not null,
  speaker            text not null check (speaker in ('caller', 'agent')),
  started_offset_ms  integer not null,
  ended_offset_ms    integer,
  -- Set when the caller interrupts. The unplayed remainder never happened and must not
  -- re-enter the agent's context (R6.1).
  barged_in_at_ms    integer,
  created_at         timestamptz not null default now(),
  unique (tenant_id, call_id, seq)
);

create table if not exists transcripts (
  id              bigserial primary key,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  call_id         uuid not null references calls(id) on delete cascade,
  turn_id         uuid references turns(id) on delete cascade,
  kind            text not null check (kind in ('interim', 'final')),
  text            text not null,
  confidence      real,
  -- Word-level confidence, so a low-confidence turn can trigger a clarifying question
  -- rather than a wrong answer (R4.1.5).
  words           jsonb,
  offset_ms       integer not null,
  -- Which transcriber produced this. Two providers may run on the same audio (R4.1.9).
  provider        text not null,
  -- Written by the post-call review loop in Slice 4a. Production audio has no ground
  -- truth until a human supplies it (R9.2.3).
  corrected_text  text,
  corrected_at    timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists tool_invocations (
  id          bigserial primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  call_id     uuid not null references calls(id) on delete cascade,
  turn_id     uuid references turns(id) on delete cascade,
  name        text not null,
  -- Required at registration, so it is required here too (R5.3).
  risk_tier   text not null check (risk_tier in ('read', 'write', 'irreversible')),
  -- Redacted per the tenant's PII rules before insert. Credentials never reach here
  -- (R5.2.1, R5.2.4).
  args        jsonb,
  result      jsonb,
  latency_ms  integer,
  outcome     text not null check (outcome in ('ok', 'timeout', 'error', 'refused')),
  created_at  timestamptz not null default now()
);

create table if not exists latencies (
  id          bigserial primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  call_id     uuid not null references calls(id) on delete cascade,
  turn_id     uuid references turns(id) on delete cascade,
  -- e.g. tts_first_byte, stt_final, llm_first_token, tool_dispatch, end_to_end.
  stage       text not null,
  ms          integer not null,
  provider    text,
  created_at  timestamptz not null default now()
);

create table if not exists audio_segments (
  id               bigserial primary key,
  tenant_id        uuid not null references tenants(id) on delete cascade,
  call_id          uuid not null references calls(id) on delete cascade,
  turn_id          uuid references turns(id) on delete cascade,
  -- Which side of the conversation this audio is. NOT a call direction: Ansa answers
  -- calls and never places them.
  source           text not null check (source in ('caller', 'agent')),
  storage_key      text not null,
  encoding         text not null,
  sample_rate      integer not null,
  bytes            integer not null,
  start_offset_ms  integer not null,
  duration_ms      integer,
  -- Enforces the tenant's retention policy. A sweep deletes rows past this.
  expires_at       timestamptz,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes: every lookup is tenant-scoped, so every index leads with tenant_id
-- ---------------------------------------------------------------------------

create index if not exists calls_tenant_created_idx        on calls (tenant_id, created_at desc);
create index if not exists call_events_call_idx            on call_events (tenant_id, call_id, id);
create index if not exists turns_call_idx                  on turns (tenant_id, call_id, seq);
create index if not exists transcripts_call_idx            on transcripts (tenant_id, call_id, offset_ms);
create index if not exists transcripts_turn_idx            on transcripts (tenant_id, turn_id);
create index if not exists tool_invocations_call_idx       on tool_invocations (tenant_id, call_id, id);
create index if not exists latencies_call_stage_idx        on latencies (tenant_id, call_id, stage);
create index if not exists audio_segments_call_idx         on audio_segments (tenant_id, call_id, start_offset_ms);
create index if not exists audio_segments_expiry_idx       on audio_segments (expires_at) where expires_at is not null;
