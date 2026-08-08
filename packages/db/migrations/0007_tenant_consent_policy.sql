-- An organisation's own consent settings.
--
-- Tenants choose their lawful basis; they do not choose whether one is required. The
-- CHECK constraint is the point: an unrecognised policy cannot be stored, so a typo in a
-- configuration tool cannot become a call nobody was allowed to make. The application
-- also treats an unknown value as the strictest, because two independent refusals are
-- cheaper than one missed one.
--
-- Calling hours are stored as the tenant asked for them and clamped when read. Storing
-- the clamped value would lose what they actually requested, which matters when someone
-- asks why their 7am campaign did not run.

alter table tenants add column if not exists consent_policy text not null default 'per_number';
alter table tenants add column if not exists consent_basis  text;
alter table tenants add column if not exists calling_earliest_hour integer;
alter table tenants add column if not exists calling_latest_hour   integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_consent_policy_known') then
    alter table tenants add constraint tenants_consent_policy_known
      check (consent_policy in ('per_number', 'existing_relationship'));
  end if;
end $$;

-- A standing relationship has to be justified in words. An organisation that cannot say
-- why it may call its customers has not established that it may.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_consent_basis_stated') then
    alter table tenants add constraint tenants_consent_basis_stated
      check (consent_policy <> 'existing_relationship'
             or (consent_basis is not null and length(trim(consent_basis)) > 0));
  end if;
end $$;
