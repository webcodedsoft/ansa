-- The calendar an agent books into.
--
-- Appointments have been reachable from the console since 0062 and unreachable from a call
-- ever since: nothing in `packages/tools` or the orchestrator touches the diary, so the hours
-- an operator set were offered to nobody. This is the missing link — which calendar this
-- agent's callers are booked into.
--
-- **A column, not part of the published configuration**, and that is a deliberate reading of
-- Rule 4 rather than a shortcut around it. What Rule 4 protects is a caller hearing words
-- nobody published: a draft greeting, an unpublished policy. This is a pointer to another
-- resource, and the precedent is already here — which number an agent answers lives in
-- `organization_number_routing` and not in the config document either. The words a caller
-- hears about an appointment come from the calendar's own rows, which have no draft state.
--
-- `on delete set null` rather than cascade or restrict. Deleting a calendar must not delete
-- the agent, and it must not be blocked by one; what it should do is leave the agent unable to
-- book, which is exactly what null means to the tool. The agent then says it cannot take
-- bookings rather than booking into a diary that is gone.
--
-- Nullable and defaulted to nothing: every agent that exists today books into no calendar,
-- which is what they all did yesterday.

alter table agents
  add column if not exists appointment_calendar_id uuid
    references appointment_calendars(id) on delete set null;

comment on column agents.appointment_calendar_id is
  'The calendar this agent offers and books into on a call. Null means it cannot take bookings, and the tool says so rather than guessing at a diary.';

-- Answering "which calendar is this agent booking into" on every call that offers a slot.
create index if not exists agents_appointment_calendar_idx
  on agents (appointment_calendar_id)
  where appointment_calendar_id is not null;
