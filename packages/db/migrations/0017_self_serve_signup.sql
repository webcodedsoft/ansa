-- Self-serve sign-up: a person creates an account and their own organisation.
--
-- Until now the only way into the product was an invitation, and the only way to get the
-- first invitation was an operator running `tools/tenant/owner.mjs` by hand. That is right
-- for an organisation the operator onboards deliberately, and it is a dead end for anyone
-- who arrives on their own — they have a sign-in page and no account, and no way to get one.
--
-- Why this needs a SECURITY DEFINER function at all, rather than three inserts in the API:
--
--   * `ansa_app` has no INSERT on `users`, deliberately. That grant is absent so that there
--     is exactly one code path creating people, and it can be read in one place.
--   * `tenants` has an RLS policy of `id = app.current_tenant()`. An organisation that does
--     not exist yet cannot be the current tenant, so the insert fails its own WITH CHECK.
--     This is the chicken-and-egg the other definer functions exist for.
--
-- So the alternative to this function is loosening one of those two, and both are load-
-- bearing. A definer function with a pinned `search_path` is the narrower change: it does
-- exactly these three inserts and nothing else can reach them.

-- ---------------------------------------------------------------------------
-- app.create_organisation
-- ---------------------------------------------------------------------------

-- Dropped first for the same reason as `accept_invitation`: `create or replace` cannot
-- change OUT parameter names, and a re-run after they change fails rather than replacing.
drop function if exists app.create_organisation(text, text, text, text, timestamptz);

-- **This function does not authenticate anybody, and must not be called as though it does.**
--
-- When the address already has an account, the caller has to have verified the password
-- first — `app.credentials_for_email` then `verifyPassword`, exactly as signing in does. The
-- reason is not subtle: without that check, anyone could type a stranger's address into the
-- sign-up form and attach that stranger's account to an organisation they control. They
-- would not gain the stranger's data, but the stranger would find an organisation they never
-- joined sitting in their sign-in list, owned by somebody else.
--
-- `p_password_hash` is therefore only ever used for a genuinely new address. For an existing
-- one it is ignored, in the same way and for the same reason as in `accept_invitation`:
-- being able to overwrite a password by naming an address would be a takeover.
create or replace function app.create_organisation(
  p_name           text,
  p_email          text,
  p_password_hash  text,
  p_display_name   text,
  p_now            timestamptz
)
  -- Prefixed, because an OUT parameter named `tenant_id` is in scope for every statement in
  -- the body and makes `insert into memberships (tenant_id, …)` ambiguous at call time.
  returns table (out_tenant_id uuid, out_user_id uuid, out_created_user boolean)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  existing   uuid;
  owner_id   uuid;
  new_tenant uuid;
  is_new     boolean := false;
begin
  -- Addresses are stored lowercased and every lookup elsewhere assumes it. Normalising here
  -- rather than trusting the caller means one casing of an address cannot become a second
  -- account with the same name.
  select u.id into existing from users u where u.email = lower(p_email);

  if existing is null then
    if p_password_hash is null then
      raise exception 'a new account needs a password hash';
    end if;
    insert into users (email, password_hash, display_name)
      values (lower(p_email), p_password_hash, p_display_name)
      returning id into owner_id;
    is_new := true;
  else
    owner_id := existing;
  end if;

  -- Everything else on `tenants` has a default or is nullable, and is deliberately left
  -- alone: a brand-new organisation answers on the platform defaults until somebody
  -- publishes a configuration, and inventing values here would put a version in the history
  -- that no person chose.
  insert into tenants (name) values (p_name) returning id into new_tenant;

  insert into memberships (tenant_id, user_id, role)
    values (new_tenant, owner_id, 'owner');

  return query select new_tenant, owner_id, is_new;
end
$$;

revoke all on function app.create_organisation(text, text, text, text, timestamptz) from public;
grant execute on function app.create_organisation(text, text, text, text, timestamptz) to ansa_app;

-- `p_now` is accepted and currently unused: `tenants.created_at` and `users.created_at` both
-- default to now(). It is in the signature because every other definer function here takes
-- the caller's clock rather than reading the database's, so a test can place an event in
-- time, and widening the signature later is a migration nobody wants to write.
