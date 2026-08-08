-- Loading config by id was costing 1.74 seconds on the media socket.
--
-- Measured on the first outbound call: 12:03:17.545 media stream started, 12:03:19.285
-- tenant resolved. The by-number path already got a single-round-trip function in 0004;
-- the by-id path was still going through withTenant, which opens a transaction to set
-- app.tenant_id — connect, begin, set_config, select, commit — to a database in Ohio.
--
-- Only outbound needs this. Inbound resolves at the voice webhook and the socket's read
-- is a map lookup; outbound inlines its TwiML, never touches a webhook, and meets the
-- tenant for the first time on the socket itself.
--
-- Same trust boundary as 0003 and 0004: one tenant's own configuration, executable only
-- by ansa_app, and the caller must already hold the id.

create or replace function app.tenant_config_for_id(tenant uuid)
  returns table (
    id             uuid,
    name           text,
    keyterms       text[],
    voice_id       text,
    greeting       text,
    persona        text,
    config_version integer
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select t.id, t.name, t.keyterms, t.voice_id, t.greeting, t.persona, t.config_version
    from tenants t
   where t.id = tenant
   limit 1
$$;

revoke all on function app.tenant_config_for_id(uuid) from public;
grant execute on function app.tenant_config_for_id(uuid) to ansa_app;
