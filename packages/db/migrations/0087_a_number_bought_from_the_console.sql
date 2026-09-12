-- Numbers an organisation buys for itself, beside the ones it brings.
--
-- `organization_numbers` has held two kinds of row since 0054 without saying which: numbers
-- an operator attached by hand, and numbers a holder proved by pointing a webhook here. Both
-- are the organisation's own line at its own carrier. This adds a third kind — a number the
-- platform bought on the organisation's behalf, in the platform's carrier account — and it
-- has to be told apart, because it is the only kind the platform is billed for and the only
-- kind the platform can release.
--
-- `ansa_app` still has no INSERT or DELETE on the table. 0019 made that the boundary and
-- 0054 opened one narrow hole for the webhook proof; these are the second and third holes,
-- each scoped to `app.current_organization()` so a request can only ever write its own row.
-- Releasing clears any agent routed to the number first: `agents_number_held_by_organization`
-- would otherwise refuse, and an agent pointed at a number that no longer rings is worse than
-- one with no number at all — the console shows the second and hides the first.

alter table organization_numbers
  add column if not exists managed_by text not null default 'holder'
    constraint organization_numbers_managed_by_check check (managed_by in ('holder', 'platform')),
  add column if not exists carrier_sid text,
  add column if not exists country text,
  add column if not exists monthly_price text;

comment on column organization_numbers.managed_by is
  '''holder'': the organisation''s own number at its own carrier, attached by an operator or proved by webhook. ''platform'': bought from the console in the platform''s carrier account, billed to the platform, releasable from the console.';
comment on column organization_numbers.carrier_sid is
  'The carrier''s own id for a platform-bought number; what releasing it at the carrier needs. Null for a holder''s number.';

create function app.attach_purchased_number(p_number text, p_sid text, p_country text, p_price text)
returns boolean
language plpgsql
volatile security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  org uuid := app.current_organization();
begin
  if org is null then
    raise exception 'attach_purchased_number needs the organization scope set';
  end if;
  insert into organization_numbers (organization_id, number, note, managed_by, carrier_sid, country, monthly_price)
  values (org, p_number, 'bought from the console', 'platform', p_sid, p_country, p_price)
  on conflict (number) do nothing;
  return exists (
    select 1 from organization_numbers n where n.number = p_number and n.organization_id = org
  );
end;
$fn$;

create function app.release_purchased_number(p_number text)
returns text
language plpgsql
volatile security definer
set search_path to 'public', 'pg_temp'
as $fn$
declare
  org uuid := app.current_organization();
  sid text;
begin
  if org is null then
    raise exception 'release_purchased_number needs the organization scope set';
  end if;
  select n.carrier_sid into sid
    from organization_numbers n
   where n.number = p_number and n.organization_id = org and n.managed_by = 'platform';
  if not found then
    return null;
  end if;
  update agents set dialled_number = null
   where organization_id = org and dialled_number = p_number;
  delete from organization_numbers where number = p_number and organization_id = org;
  return sid;
end;
$fn$;

revoke all on function app.attach_purchased_number(text, text, text, text) from public;
revoke all on function app.release_purchased_number(text) from public;
grant execute on function app.attach_purchased_number(text, text, text, text) to ansa_app;
grant execute on function app.release_purchased_number(text) to ansa_app;
