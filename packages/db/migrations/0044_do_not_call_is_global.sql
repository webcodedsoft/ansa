-- Somebody says "stop calling me", and nothing can write it down.
--
-- The consent gate has read `do_not_call` since it was written, and `mayCall` checks
-- suppression before anything else — before consent, before hours — because withdrawing by
-- asking is the most explicit signal a person can give. What was never there is the write.
-- The only insert anywhere in the codebase is in `rls.test.ts`; every row in this table was
-- put there by hand.
--
-- And the application role could not add one even if something tried. The write policy is
--
--   with check (organization_id = app.current_organization())
--
-- so `ansa_app` may only record a suppression scoped to itself, while the brief — and the
-- NCC rules underneath it — require the opposite: a person who asks not to be called is
-- asking every organisation on this platform, permanently. `organization_id is null` is how
-- this table already spells that, the read policy already honours it, and the unique index
-- has treated 'global' as its own scope since 0006. Only the insert was impossible.
--
-- Hence SECURITY DEFINER, with the search_path pinned as every other definer here pins it.
-- The function takes no organisation and cannot be talked into scoping the record, which is
-- the point: an organisation must not be able to write a narrower suppression than the
-- person actually asked for.
--
-- Idempotent. Somebody who says it three times in one sentence, or rings back tomorrow and
-- says it again, must not raise an error on a path whose entire job is to fail safe. The
-- first reason is kept rather than overwritten, because it is the one closest to what they
-- said at the moment they said it.

create or replace function app.record_do_not_call(
  p_phone_number text,
  p_reason       text
)
returns void
language sql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
  insert into do_not_call (organization_id, phone_number, reason)
  values (null, p_phone_number, p_reason)
  on conflict (coalesce(organization_id::text, 'global'), phone_number) do nothing
$fn$;

revoke all on function app.record_do_not_call(text, text) from public;
grant execute on function app.record_do_not_call(text, text) to ansa_app;
