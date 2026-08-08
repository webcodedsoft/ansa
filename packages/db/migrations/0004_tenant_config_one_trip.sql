-- Answering a call was costing two seconds before the caller heard anything.
--
-- Measured on live calls: 2048ms and 2164ms between "inbound call" and "tenant
-- resolved". Resolution was one round trip for the id and then loadTenantConfig, which
-- opens a transaction to set app.tenant_id — connect, begin, set_config, select, commit.
-- Six round trips to a database in Ohio, on the answer path, before any TwiML is
-- returned.
--
-- One function, one trip. The trust boundary is unchanged from 0003: it is keyed on the
-- dialled number, returns exactly one tenant's own configuration, and is executable only
-- by ansa_app. What it returns is what that tenant's own calls are entitled to read.

create or replace function app.tenant_config_for_number(dialled text)
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
   where t.dialled_number = dialled
   limit 1
$$;

revoke all on function app.tenant_config_for_number(text) from public;
grant execute on function app.tenant_config_for_number(text) to ansa_app;
