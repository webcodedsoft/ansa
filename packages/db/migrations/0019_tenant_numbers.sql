-- Who holds a number, and which agent answers it, are two different questions.
--
-- Migration 0018 moved `dialled_number` from `tenants` to `agents` so a number could
-- reach one agent out of several. That was right for routing and wrong for authority,
-- and this closes the gap before anything writes through it.
--
-- The reason is spelled out at the top of `apps/api/src/api/numbers/numbers.controller.ts`
-- and has not changed: `tenants.dialled_number` was operator-written on purpose, because
-- an organisation that can set its own number can claim a line it does not control. The
-- unique index only stops a *second* organisation taking it, which means the damage lands
-- on whoever is onboarded next — they find their number taken and their callers answered
-- by a stranger's agent. No proof of control is available to prevent it: the carrier
-- cannot vouch for a number it does not sell.
--
-- After 0018, `agents.dialled_number` sits on a table organisations write. So the
-- authority has to move somewhere they do not.
--
--   tenant_numbers   what the operator assigned this organisation. Operator writes,
--                    organisation reads. This is the claim.
--   agents           which of the organisation's own agents answers one of those numbers.
--                    Organisation writes. This is the routing.
--
-- The composite foreign key joins them, and it is the whole security argument: an agent
-- may only be routed a number listed against its own tenant. Not a trigger, not a check
-- in application code — an organisation cannot write a row naming a number nobody
-- assigned them, and no code path has to remember to ask.

-- ---------------------------------------------------------------------------
-- The numbers an organisation actually holds
-- ---------------------------------------------------------------------------

create table if not exists tenant_numbers (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  -- E.164. Unconstrained text like the column it replaces, because an operator types it
  -- and the carrier is the authority on what is valid.
  number     text not null,
  -- Why this organisation has it, in an operator's words: which carrier account, which
  -- ticket. Nobody reconstructs that from the number alone six months later.
  note       text,
  created_at timestamptz not null default now(),

  -- Globally unique: two organisations holding one number is the bug this table exists to
  -- make impossible, and it has to be impossible before routing rather than at it.
  primary key (number),

  -- The composite key `agents` points at. Implied by the primary key, and required all
  -- the same — a foreign key needs a unique constraint on exactly the columns it
  -- references, and it is (tenant_id, number) that carries the meaning "this organisation
  -- holds this number".
  unique (tenant_id, number)
);

create index if not exists tenant_numbers_tenant_idx on tenant_numbers (tenant_id);

-- ---------------------------------------------------------------------------
-- Backfill: whatever each tenant was already routing, it now holds
-- ---------------------------------------------------------------------------

-- Before RLS, for the reason 0011 and 0018 both give: after, this depends on the
-- migration role holding BYPASSRLS, and without it every row is filtered and the insert
-- silently does nothing.
--
-- Read from `agents` rather than `tenants`: 0018 already copied the numbers across, and
-- `agents` is what routes calls today, so `agents` is the truth about what is in use.
insert into tenant_numbers (tenant_id, number, note)
select a.tenant_id, a.dialled_number, 'backfilled from agents by migration 0019'
  from agents a
 where a.dialled_number is not null
on conflict (number) do nothing;

-- ---------------------------------------------------------------------------
-- Routing may only point at a number the organisation holds
-- ---------------------------------------------------------------------------

-- The point of the migration. `on update cascade` so an operator correcting a typo moves
-- the routing with it; `on delete restrict` so taking a number away fails loudly while an
-- agent is still answering it, rather than silently unrouting a live line.
--
-- `dialled_number` stays nullable, and a null in a composite foreign key satisfies it
-- without matching anything. An unrouted agent is unaffected.
alter table agents drop constraint if exists agents_number_held_by_tenant;
alter table agents add constraint agents_number_held_by_tenant
  foreign key (tenant_id, dialled_number)
  references tenant_numbers (tenant_id, number)
  on update cascade
  on delete restrict;

-- ---------------------------------------------------------------------------
-- Isolation
-- ---------------------------------------------------------------------------

alter table tenant_numbers enable row level security;
alter table tenant_numbers force  row level security;
drop policy if exists tenant_isolation on tenant_numbers;
create policy tenant_isolation on tenant_numbers
  using (tenant_id = app.current_tenant())
  with check (tenant_id = app.current_tenant());

-- SELECT and nothing else, and this one line is the security boundary.
--
-- `ansa_app` is the role every API request runs as. Without INSERT it cannot add a number
-- to any organisation's inventory, including its own, so the foreign key above has
-- nothing an organisation can widen. Numbers are assigned by an operator connecting as
-- the migration role, exactly as before 0018.
grant select on tenant_numbers to ansa_app;

-- ---------------------------------------------------------------------------
-- Reading the inventory
-- ---------------------------------------------------------------------------

-- Which agent, if any, answers each number this organisation holds. One query for the
-- numbers screen, which otherwise reads inventory and routing separately and shows them
-- disagreeing while a reassignment is in flight.
--
-- `security_invoker` is not optional here, and the first draft of this migration left it
-- off. A Postgres view executes as its OWNER unless told otherwise, and the owner is the
-- migration role — so the policies on `tenant_numbers` and `agents` were evaluated as a
-- role that bypasses them. The base table correctly returned zero rows to an unscoped
-- session while this view returned every organisation's numbers.
--
-- That is the failure mode 0002 warns about in its own header: invisible to inspection,
-- and caught only by trying to cross the boundary. RLS being enabled on the underlying
-- tables says nothing about a view over them.
create or replace view tenant_number_routing with (security_invoker = true) as
  select n.tenant_id,
         n.number,
         n.note,
         n.created_at,
         a.id   as agent_id,
         a.name as agent_name
    from tenant_numbers n
    left join agents a
      on a.tenant_id = n.tenant_id
     and a.dialled_number = n.number
     and a.archived_at is null;

grant select on tenant_number_routing to ansa_app;
