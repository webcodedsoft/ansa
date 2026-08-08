-- Letting a status callback close a call it has no tenant context for.
--
-- The carrier reports "completed, 46 seconds" to a public webhook that knows only a call
-- SID. RLS quite correctly hides every row from it, so the callback fired, logged, and
-- wrote nothing — the same chicken-and-egg as tenant resolution in 0003, and the same
-- answer.
--
-- Narrow by construction: it updates one call, found by an identifier the carrier issued,
-- and returns nothing. It cannot read a transcript or reach another tenant's data, and a
-- caller who guessed a SID could only mark a call ended that the carrier has already
-- ended anyway.

create or replace function app.close_call_by_carrier_id(
  carrier_id text,
  status text,
  duration integer
) returns void
  language sql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
  update calls
     set carrier_status = status,
         -- The carrier's figure wins: it is billing truth, and ours was a stand-in for
         -- exactly the case where this callback never arrived.
         duration_seconds = coalesce(duration, duration_seconds),
         ended_at = coalesce(ended_at, now())
   where carrier_call_id = carrier_id;
$$;

revoke all on function app.close_call_by_carrier_id(text, text, integer) from public;
grant execute on function app.close_call_by_carrier_id(text, text, integer) to ansa_app;
