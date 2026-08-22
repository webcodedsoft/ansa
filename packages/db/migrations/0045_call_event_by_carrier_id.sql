-- What answered an outbound call reaches stdout and nowhere else.
--
-- The carrier's answering-machine verdict arrives on its own webhook, several seconds into
-- a call, on a different request from the media socket. The `CallRecorder` that writes
-- every other event is per-socket and out of scope there, so the verdict is logged and
-- forgotten — which leaves two things in the brief unanswerable. The human-answer rate,
-- because nothing records what answered. And the AMD false-positive rate, which matters
-- specifically here: the model is trained on US carrier patterns and nobody knows how it
-- behaves on Nigerian networks, so "how often is it wrong" is not a question that should
-- wait for somebody to notice.
--
-- `app.close_call_by_carrier_id` already solves the same shape of problem for the status
-- callback: SECURITY DEFINER, called outside any organisation scope, resolving the call
-- from the carrier's own id. This is that, for events.
--
-- The organisation is resolved from the row rather than passed in, and that is the safety
-- argument rather than a convenience: the webhook cannot know an organisation, so if it
-- could pass one it could pass somebody else's. An unknown carrier id writes nothing and
-- says so by returning false — a webhook for a call we never recorded is ordinary during a
-- deploy, and must not raise.

create or replace function app.record_call_event_by_carrier_id(
  p_carrier_call_id text,
  p_kind            text,
  p_detail          jsonb
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_call         uuid;
  v_organization uuid;
begin
  select c.id, c.organization_id
    into v_call, v_organization
    from calls c
   where c.carrier_call_id = p_carrier_call_id
   order by c.created_at desc
   limit 1;

  if v_call is null then
    return false;
  end if;

  insert into call_events (organization_id, call_id, kind, detail)
  values (v_organization, v_call, p_kind, coalesce(p_detail, '{}'::jsonb));

  return true;
end;
$fn$;

revoke all on function app.record_call_event_by_carrier_id(text, text, jsonb) from public;
grant execute on function app.record_call_event_by_carrier_id(text, text, jsonb) to ansa_app;
