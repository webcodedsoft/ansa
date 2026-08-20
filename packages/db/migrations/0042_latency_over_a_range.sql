-- The `latencies` table has existed since migration 0001 and nothing has ever written to
-- it. The stage timings a call produces went to `call_events` instead, which answers "why
-- was this one call slow" well and "what is the p90 across a week" badly: the event log is
-- the fastest-growing table in the schema, that question is a range over all of it, and
-- the only index it carries is by call.
--
-- So the timings land here as well now, and this is the index that makes the range query
-- worth the duplication. `created_at` leads because the filter is a range on it; `stage`
-- and `ms` ride along as included columns so the aggregate never touches the heap.
--
-- `latencies_call_stage_idx` from 0001 stays. It serves the other question — one call's
-- stages — and dropping it would turn that into a sequential scan.

create index if not exists latencies_range_idx
  on latencies (organization_id, created_at)
  include (stage, ms);
