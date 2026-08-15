-- An organisation runs many agents, and a number reaches exactly one of them.
--
-- Until now `tenants` WAS the agent. One row held the organisation and its single
-- persona, greeting, voice, vocabulary, hours, escalation and dialled number, and
-- `tenant_prompt_versions` was that one agent's history. Every screen in the product
-- said so out loud, because there was no honest alternative.
--
-- This separates the two. `tenants` keeps what belongs to the organisation — its name,
-- retention, consent policy, the tool registry, the webhook subscriptions and the
-- credential vault. `agents` takes what belongs to an agent, which is everything a
-- caller experiences.
--
-- Two rules are enforced here rather than in application code, for the same reason risk
-- tiers are: code can be talked out of things and a constraint cannot.
--
--   1. A phone number reaches at most one agent. A partial unique index on
--      `agents.dialled_number` — not on (tenant_id, dialled_number), because two
--      organisations claiming the same number is the worse version of the same bug.
--   2. An agent belongs to exactly one tenant, and everything hanging off it carries a
--      `tenant_id` of its own so RLS has something local to filter on. A policy that has
--      to join to find its tenant is a policy that gets dropped in a hurry.
--
-- Tools stay shared. The registry, its risk tiers, its egress allowlist and its
-- credential references are defined once per organisation on `tenants.tool_config`;
-- `agent_tools` records which of those an agent may actually call. Duplicating the
-- registry per agent would duplicate the SSRF allowlist with it, and an allowlist
-- maintained in three places is an allowlist that is wrong in two of them.

-- ---------------------------------------------------------------------------
-- The agents
-- ---------------------------------------------------------------------------

create table if not exists agents (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants(id) on delete cascade,

  -- What the caller experiences. Lifted from `tenants` verbatim, nullability included,
  -- so the backfill below is a copy and not a translation.
  name                    text not null,
  voice_id                text,
  greeting                text,
  persona                 text,
  instructions            text,
  keyterms                text[] not null default '{}',

  business_open_hour      integer,
  business_close_hour     integer,
  business_days           integer[],

  escalation_to_number    text,
  escalation_from_number  text,
  escalation_ring_seconds integer,

  -- The number this agent answers. Null is a real state: an agent can be written,
  -- reviewed and published before anyone decides which line it picks up.
  dialled_number          text,

  -- Per agent, not per tenant. Two agents both on version 3 is ordinary and means
  -- nothing — a version is only meaningful beside the agent it belongs to.
  config_version          integer not null default 1,

  -- Archived rather than deleted. `calls` points at agents for the life of the call log,
  -- and a cascade would delete the evidence along with the agent that produced it.
  archived_at             timestamptz,
  created_at              timestamptz not null default now(),

  -- The three-or-none rule migration 0012 put on `tenants`. Two of three columns is not
  -- a partially configured schedule, it is a schedule nobody can evaluate.
  constraint agents_business_hours_all_or_none check (
    (business_open_hour is null and business_close_hour is null and business_days is null)
    or
    (business_open_hour is not null and business_close_hour is not null and business_days is not null)
  ),

  -- And 0015's rule on escalation: a destination with no origination cannot be dialled.
  constraint agents_escalation_both_or_neither check (
    (escalation_to_number is null and escalation_from_number is null)
    or
    (escalation_to_number is not null and escalation_from_number is not null)
  )
);

-- Rule 1, and the reason this migration exists. Global rather than per tenant: the
-- carrier hands us a dialled number and nothing else, so if two rows could claim it the
-- ingress lookup would have no way to choose and would answer with whichever the planner
-- reached first.
--
-- Partial, so any number of agents can sit unrouted with `dialled_number is null`.
create unique index if not exists agents_dialled_number_idx
  on agents (dialled_number) where dialled_number is not null;

create index if not exists agents_tenant_idx on agents (tenant_id) where archived_at is null;

-- ---------------------------------------------------------------------------
-- Which shared tools an agent may call
-- ---------------------------------------------------------------------------

-- The registry lives on `tenants.tool_config`; this is the selection. A row means "this
-- agent may call this tool", and no rows means no tools — not all of them. Defaulting an
-- empty selection to full access would make adding an agent the most dangerous operation
-- in the product.
--
-- `tool_name` is text and deliberately not a foreign key: the registry is a jsonb
-- document, so there is nothing to reference. A selection naming a tool since removed
-- from the registry resolves to nothing at dispatch, which is the correct failure and
-- the same one an unregistered tool already gets.
create table if not exists agent_tools (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  agent_id   uuid not null references agents(id) on delete cascade,
  tool_name  text not null,
  created_at timestamptz not null default now(),
  primary key (agent_id, tool_name)
);

create index if not exists agent_tools_tenant_idx on agent_tools (tenant_id);

-- ---------------------------------------------------------------------------
-- Backfill: every tenant becomes one agent holding what it already had
-- ---------------------------------------------------------------------------

-- Before RLS is enabled on the new tables, not after, and that ordering is load-bearing
-- for the reason migration 0011 spelled out: after, this depends on the migration role
-- holding BYPASSRLS, and without it the policy filters every row and the insert silently
-- does nothing. A backfill that inserts zero rows and reports success is the worst
-- available outcome.
--
-- The agent's id is the tenant's id rather than a generated one. That is not a shortcut:
-- it makes this migration converge when re-run against a half-migrated database, and it
-- lets the two backfills below (`tenant_prompt_versions`, `calls`) find their agent
-- without a lookup table. New agents get `gen_random_uuid()` and cannot collide.
insert into agents (
  id, tenant_id, name, voice_id, greeting, persona, instructions, keyterms,
  business_open_hour, business_close_hour, business_days,
  escalation_to_number, escalation_from_number, escalation_ring_seconds,
  dialled_number, config_version, created_at
)
select
  t.id, t.id, t.name, t.voice_id, t.greeting, t.persona, t.instructions, t.keyterms,
  t.business_open_hour, t.business_close_hour, t.business_days,
  t.escalation_to_number, t.escalation_from_number, t.escalation_ring_seconds,
  t.dialled_number, t.config_version, t.created_at
from tenants t
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- The history moves with the agent
-- ---------------------------------------------------------------------------

-- A version belongs to an agent. Re-keyed rather than copied into a second table: one
-- append-only log with the right key beats two logs that have to agree.
alter table tenant_prompt_versions
  add column if not exists agent_id uuid references agents(id) on delete cascade;

update tenant_prompt_versions p set agent_id = p.tenant_id where p.agent_id is null;

alter table tenant_prompt_versions alter column agent_id set not null;

-- (tenant_id, version) was only ever unique because a tenant had one agent. Two agents
-- both publishing a version 2 is now ordinary, and the old key would refuse the second.
alter table tenant_prompt_versions drop constraint if exists tenant_prompt_versions_pkey;
alter table tenant_prompt_versions add primary key (agent_id, version);

create index if not exists tenant_prompt_versions_tenant_idx
  on tenant_prompt_versions (tenant_id);

-- ---------------------------------------------------------------------------
-- Which agent took the call
-- ---------------------------------------------------------------------------

-- Nullable, and it stays nullable. Calls placed before this migration genuinely have no
-- agent, and a backfilled guess would be indistinguishable from a recorded fact the next
-- time somebody asks which agent produced a bad answer. The update below is not a guess:
-- while a tenant had exactly one agent, that agent did take the call.
--
-- `on delete set null` rather than cascade, for the same reason agents are archived
-- rather than deleted: the call log outlives the configuration that produced it.
alter table calls add column if not exists agent_id uuid references agents(id) on delete set null;

update calls c set agent_id = c.tenant_id
 where c.agent_id is null
   and exists (select 1 from agents a where a.id = c.tenant_id);

create index if not exists calls_agent_idx on calls (tenant_id, agent_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Isolation
-- ---------------------------------------------------------------------------

alter table agents enable row level security;
alter table agents force  row level security;
drop policy if exists tenant_isolation on agents;
create policy tenant_isolation on agents
  using (tenant_id = app.current_tenant())
  with check (tenant_id = app.current_tenant());

alter table agent_tools enable row level security;
alter table agent_tools force  row level security;
drop policy if exists tenant_isolation on agent_tools;
create policy tenant_isolation on agent_tools
  using (tenant_id = app.current_tenant())
  with check (tenant_id = app.current_tenant());

-- Update, because renaming an agent, moving its number and archiving it are all
-- ordinary. No delete: `archived_at` is how an agent goes away, so the call log keeps
-- its referent.
grant select, insert, update on agents to ansa_app;

-- Delete, because the selection is a set replaced wholesale. Deleting a row here revokes
-- an agent's access to a tool and destroys no history.
grant select, insert, delete on agent_tools to ansa_app;

-- ---------------------------------------------------------------------------
-- Ingress, still in one round trip
-- ---------------------------------------------------------------------------

-- Same trust boundary as 0003, 0004, 0005, 0011, 0012, 0013, 0014 and 0015: SECURITY
-- DEFINER because RLS cannot answer "which tenant?" when the tenant is the question,
-- keyed on an identifier the caller already holds, and returning one tenant's own row.
--
-- The signature keeps every column it returned before and appends `agent_id` and
-- `enabled_tools`, so this stays one query on the answer path. The two-step version cost
-- two seconds (see 0004) and nothing here is worth paying that again.
--
-- The join is the whole change: the number now lives on the agent, while the shared
-- registry, subscriptions and credentials still come from the tenant.
drop function if exists app.tenant_config_for_number(text);
create function app.tenant_config_for_number(dialled text)
  returns table (
    id                      uuid,
    agent_id                uuid,
    name                    text,
    keyterms                text[],
    voice_id                text,
    greeting                text,
    persona                 text,
    instructions            text,
    business_open_hour      integer,
    business_close_hour     integer,
    business_days           integer[],
    tool_config             jsonb,
    enabled_tools           text[],
    event_config            jsonb,
    escalation_to_number    text,
    escalation_from_number  text,
    escalation_ring_seconds integer,
    credentials             jsonb,
    config_version          integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select t.id, a.id, a.name, a.keyterms, a.voice_id, a.greeting, a.persona, a.instructions,
         a.business_open_hour, a.business_close_hour, a.business_days,
         t.tool_config,
         (select coalesce(array_agg(at.tool_name), '{}')
            from agent_tools at where at.agent_id = a.id),
         t.event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         (select jsonb_object_agg(c.ref, c.sealed)
            from tenant_credentials c where c.tenant_id = t.id),
         a.config_version
    from agents a
    join tenants t on t.id = a.tenant_id
   -- An archived agent does not answer. Its number should have been released first, but
   -- a number left behind must ring nobody rather than ring a retired script.
   where a.dialled_number = dialled and a.archived_at is null
   limit 1
$$;

revoke all on function app.tenant_config_for_number(text) from public;
grant execute on function app.tenant_config_for_number(text) to ansa_app;

-- The counterpart for a call whose agent is already known: outbound carries the agent id
-- out with the origination, and the media socket must not resolve it a second time.
drop function if exists app.agent_config_for_id(uuid);
create function app.agent_config_for_id(agent uuid)
  returns table (
    id                      uuid,
    agent_id                uuid,
    name                    text,
    keyterms                text[],
    voice_id                text,
    greeting                text,
    persona                 text,
    instructions            text,
    business_open_hour      integer,
    business_close_hour     integer,
    business_days           integer[],
    tool_config             jsonb,
    enabled_tools           text[],
    event_config            jsonb,
    escalation_to_number    text,
    escalation_from_number  text,
    escalation_ring_seconds integer,
    credentials             jsonb,
    config_version          integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select t.id, a.id, a.name, a.keyterms, a.voice_id, a.greeting, a.persona, a.instructions,
         a.business_open_hour, a.business_close_hour, a.business_days,
         t.tool_config,
         (select coalesce(array_agg(at.tool_name), '{}')
            from agent_tools at where at.agent_id = a.id),
         t.event_config,
         a.escalation_to_number, a.escalation_from_number, a.escalation_ring_seconds,
         (select jsonb_object_agg(c.ref, c.sealed)
            from tenant_credentials c where c.tenant_id = t.id),
         a.config_version
    from agents a
    join tenants t on t.id = a.tenant_id
   where a.id = agent
   limit 1
$$;

revoke all on function app.agent_config_for_id(uuid) from public;
grant execute on function app.agent_config_for_id(uuid) to ansa_app;

-- `app.tenant_config_for_id(uuid)` keeps its signature and its callers, and now answers
-- with the tenant's oldest live agent. That is exactly right while a tenant has one and
-- a coin toss the moment it has two, so it survives only for the paths that hold no
-- agent — the viewer and the retention sweep, neither of which is on the call path.
-- Anything on the call path takes `agent_config_for_id` instead.
drop function if exists app.tenant_config_for_id(uuid);
create function app.tenant_config_for_id(tenant uuid)
  returns table (
    id                      uuid,
    agent_id                uuid,
    name                    text,
    keyterms                text[],
    voice_id                text,
    greeting                text,
    persona                 text,
    instructions            text,
    business_open_hour      integer,
    business_close_hour     integer,
    business_days           integer[],
    tool_config             jsonb,
    enabled_tools           text[],
    event_config            jsonb,
    escalation_to_number    text,
    escalation_from_number  text,
    escalation_ring_seconds integer,
    credentials             jsonb,
    config_version          integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select * from app.agent_config_for_id((
    select a.id from agents a
     where a.tenant_id = tenant and a.archived_at is null
     order by a.created_at, a.id
     limit 1
  ))
$$;

revoke all on function app.tenant_config_for_id(uuid) from public;
grant execute on function app.tenant_config_for_id(uuid) to ansa_app;

-- ---------------------------------------------------------------------------
-- Resolution alone, for the paths that only need an id
-- ---------------------------------------------------------------------------

drop function if exists app.tenant_for_number(text);
create function app.tenant_for_number(dialled text) returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select a.tenant_id from agents a
   where a.dialled_number = dialled and a.archived_at is null
   limit 1
$$;

revoke all on function app.tenant_for_number(text) from public;
grant execute on function app.tenant_for_number(text) to ansa_app;

drop function if exists app.agent_for_number(text);
create function app.agent_for_number(dialled text) returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select a.id from agents a
   where a.dialled_number = dialled and a.archived_at is null
   limit 1
$$;

revoke all on function app.agent_for_number(text) from public;
grant execute on function app.agent_for_number(text) to ansa_app;

-- ---------------------------------------------------------------------------
-- A version, read back
-- ---------------------------------------------------------------------------

drop function if exists app.tenant_config_at_version(uuid, integer);
create function app.agent_config_at_version(agent uuid, v integer)
  returns table (
    name                    text,
    voice_id                text,
    greeting                text,
    persona                 text,
    instructions            text,
    keyterms                text[],
    business_open_hour      integer,
    business_close_hour     integer,
    business_days           integer[],
    escalation_to_number    text,
    escalation_from_number  text,
    escalation_ring_seconds integer,
    version                 integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select p.name, p.voice_id, p.greeting, p.persona, p.instructions, p.keyterms,
         p.business_open_hour, p.business_close_hour, p.business_days,
         p.escalation_to_number, p.escalation_from_number,
         p.escalation_ring_seconds, p.version
    from tenant_prompt_versions p
   where p.agent_id = agent and p.version = v
$$;

revoke all on function app.agent_config_at_version(uuid, integer) from public;
grant execute on function app.agent_config_at_version(uuid, integer) to ansa_app;

-- ---------------------------------------------------------------------------
-- What `tenants` no longer routes
-- ---------------------------------------------------------------------------

-- The agent-shaped columns stay on `tenants` for now, unread. Dropping them in the same
-- migration that starts writing to `agents` leaves no way back if the copy above turns
-- out to be wrong, and a column nothing selects costs nothing but disk.
--
-- The unique index does have to go. It would refuse a second organisation the number a
-- first one released, and it no longer routes anything — `agents_dialled_number_idx` is
-- the routing table now.
drop index if exists tenants_dialled_number_idx;
