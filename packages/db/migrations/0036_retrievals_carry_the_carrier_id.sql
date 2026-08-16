-- `knowledge_retrievals.call_id` was a uuid nothing on the call path could supply.
--
-- 0034 typed it as `uuid`, matching `calls.id`. But `CallId` throughout this codebase is the
-- *carrier's* identifier — Twilio's `CallSid`, a string like `CA9f3…` — and that is what the
-- media gateway holds while a call is happening. The internal uuid is generated inside the
-- recorder and never handed back out.
--
-- So the first write would have raised `invalid input syntax for type uuid`, been swallowed
-- by the deliberate catch around it (a bookkeeping row must never cost a caller their turn),
-- and left the column empty for good. The Knowledge tab's "used, 7d" would have read zero for
-- every source: a number that looks like measurement and is actually "nothing recorded it".
--
-- Renamed as well as retyped, because `call_id` beside a uuid `calls.id` is the confusion
-- that caused this. `carrier_call_id` says which one it is and matches the column on `calls`
-- it joins to. Still no foreign key: this row is written while a caller waits, and a
-- constraint violation there would cost a turn for bookkeeping.
--
-- The table is empty, so nothing is converted.

alter table knowledge_retrievals drop column if exists call_id;
alter table knowledge_retrievals add column if not exists carrier_call_id text;

comment on column knowledge_retrievals.carrier_call_id is
  'The carrier''s call id, joinable to calls.carrier_call_id. Not calls.id — see 0036.';
