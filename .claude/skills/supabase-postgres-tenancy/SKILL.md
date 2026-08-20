---
name: supabase-postgres-tenancy
description: Supabase Postgres as Ansa uses it — RLS keyed on app.current_organization(), the ansa_app role and why BYPASSRLS would make every policy inert, withOrganization/scope.mutate and the TypeORM return-shape trap, SECURITY DEFINER with pinned search_path, the pooled 6543 vs direct 5432 URLs, and the knowledge-base full-text query. Use when writing a migration, adding a table or an app.* function, writing any SQL through OrganizationScope, touching packages/db, debugging "the database looks empty" or a mutation that reported success without changing anything, or changing anything about drafts, publishing, or knowledge search.
---

# Supabase Postgres, as Ansa uses it

`packages/db` is the only package that speaks SQL. Migrations in
`packages/db/migrations/*.sql` are the sole authority on schema — `synchronize: false` in
`data-source.ts`, deliberately, because a code change that silently altered production tables
could drop the RLS policies.

Read `migrations/0002_rls.sql` before anything else. It is the root of the tenancy model and it
argues its cases.

**Every external fact below with a date was fetched 2026-08-20.** Unverified things say so.

---

## 1. The one thing that would break everything

**The app connects as `ansa_app`. Never as `postgres`.**

Postgres bypasses row security in three cases (PostgreSQL docs, verified): superusers, roles with
the `BYPASSRLS` attribute, and — unless `FORCE ROW LEVEL SECURITY` is set — the table owner.
Supabase's default `postgres` role has admin privileges and `service_role` is documented as
bypassing RLS.

That is not a hypothetical. `0002_rls.sql` asserts it at migration time, every time:

```sql
do $$
begin
  if (select rolbypassrls from pg_roles where rolname = 'ansa_app') then
    raise exception
      'ansa_app has BYPASSRLS; every policy in this migration would be silently inert';
  end if;
end
$$;
```

Because the failure is invisible to inspection: `pg_policies` still lists every policy,
`relforcerowsecurity` still reads true, and every organisation reads every other organisation's
calls. It was caught only by an adversarial test that tried to cross the boundary and succeeded.

Both switches are needed and only the first is obvious:

- `enable row level security` — turns policies on for other roles.
- `force row level security` — applies them to the **owner** too. `ansa_app` owns nothing, so
  FORCE is belt and braces; write it anyway, on every table.

The three connection strings (`.env.example`):

| Variable | Role | Port | Use |
|---|---|---|---|
| `DATABASE_URL` | `ansa_app` | **6543** | The app. Supavisor transaction mode. |
| `DIRECT_URL` | `ansa_app` | 5432 | Tests that need a stable session. |
| `MIGRATION_DIRECT_URL` | `postgres` | 5432 | Migrations and provisioning only. Owns the schema; creating roles and policies requires it. |

Verified against Supabase's connecting-to-Postgres guide 2026-08-20: 5432 is direct **and**
Supavisor session mode; 6543 is Supavisor transaction mode and the dedicated pooler. Transaction
mode "does not support prepared statements" and does not support session-level `SET` or `LISTEN`,
because connections are not held between transactions.

Which is exactly why the next section works.

---

## 2. Scoping: `withOrganization`, and why `set_config(..., true)`

```ts
await runner.query("select set_config('app.organization_id', $1, true)", [organization]);
```

The third argument is `is_local`. **Transaction-local.** A session-level `SET` would survive the
connection's return to the pool and hand the next caller someone else's organisation — the exact
cross-organisation leak this layer exists to prevent — and it is also what makes the pooled 6543
URL safe.

`app.current_organization()` is a `stable sql` function returning
`nullif(current_setting('app.organization_id', true), '')::uuid` (migration 0025). The `true`
there is `missing_ok`: unset returns NULL, so every policy fails **closed**.

**Closed, but it presents as an empty database.** Zero rows as `ansa_app` means unscoped, not
absent. If a query returns nothing and you are sure the rows exist, the first question is whether
you went through `withOrganization` — never `dataSource.getRepository()`.

Every function in `packages/db/src/*.ts` takes an `OrganizationScope` as its first argument. There
is no organisation id at any call site and therefore nowhere to pass the wrong one. Keep that
shape.

### `scope.query` vs `scope.mutate` — this is not a style rule

TypeORM's Postgres driver returns **rows** for a `select` and **`[rows, affectedCount]`** for an
`update` or a `delete` — a two-element array whether or not anything matched. So:

```ts
// ALWAYS TRUE. Always. Even when zero rows were touched.
(await scope.query("update … returning id")).length > 0
```

The shape of that bug is a handler reporting success for a row it never touched. It was found by
the adversarial API test — "change a member of another organisation" answered 200 while changing
nothing, because RLS correctly matched zero rows and the check for zero rows could not see it.
RLS held; the code above it drew the wrong conclusion. It was then reintroduced in `updateAgent`,
`archiveAgent`, and `renameOrganization`.

`scope.mutate` unwraps the pair. Use it for every `update`/`delete … returning`.
`packages/db/src/mutate-not-query.test.ts` scans the source for `scope.query` template literals
containing `update`/`delete` plus `returning` and fails the build. **If it fires, the fix is
`scope.mutate`, not an exception in the test.**

### `timestamptz` comes back as a `Date`

The driver parses it. The API's schema layer rejects anything that is not an ISO string, which is
how this was caught. Every row interface types the column as `Date` (or `Date | string`) and
converts:

```ts
const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;
```

See `packages/db/src/knowledge.ts` and the `DraftRow` comment in `drafts.ts`.

---

## 3. Writing a migration

Template, matching every existing table:

```sql
create table if not exists thing (
  id              uuid primary key default gen_random_uuid(),   -- pgcrypto, enabled in 0001
  organization_id uuid not null references organizations(id) on delete cascade,
  -- …
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists thing_organization_idx on thing (organization_id);

drop trigger if exists thing_touch_updated_at on thing;
create trigger thing_touch_updated_at
  before update on thing
  for each row execute function app.touch_updated_at();

alter table thing enable row level security;
alter table thing force  row level security;
drop policy if exists organization_isolation on thing;
create policy organization_isolation on thing
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());

grant select, insert, update, delete on thing to ansa_app;
```

Non-negotiables in that block:

- **`with check` matters as much as `using`.** `using` filters what a statement can see;
  `with check` constrains what it can write. Without it an organisation can insert or update a
  row stamped with someone else's `organization_id` — invisible to them afterwards, and a leak.
- **`organization_id` is denormalised onto child tables** rather than joined for. A policy that
  has to join to find its organisation is a policy that gets dropped in a hurry (`0038`'s own
  reasoning, and `knowledge_units` before it).
- **Grants are explicit.** A new table `ansa_app` cannot touch fails at runtime, not at review.
- **Inserts read `app.current_organization()`** rather than taking the id as a parameter, so the
  value the policy checks against is the only value that can be written:
  ```sql
  insert into knowledge_retrievals (organization_id, source_id, carrier_call_id)
  select app.current_organization(), s.id, $2 from knowledge_sources s where …
  ```
- **Recreate functions from `pg_get_functiondef`, not from memory.** 0025, 0032 and 0039 all do
  this and all say why: a retyped body quietly loses a clause. Migration 0039 deletes a stale
  16-argument overload of `publish_agent_config` for exactly that reason — "an overload that
  differs from the real one only in what it forgets is worth deleting rather than documenting."

### `SECURITY DEFINER`, and when it is legitimate

Only for the chicken-and-egg at ingress: at call time we have the dialled number and the
organisation is precisely what we are trying to discover, so there is no scope to set and the
policy correctly returns nothing.

```sql
create or replace function app.tenant_for_number(dialled text) returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select id from tenants where dialled_number = dialled limit 1
$$;

revoke all on function app.tenant_for_number(text) from public;
grant execute on function app.tenant_for_number(text) to ansa_app;
```

Four properties, all required:

1. **Narrowest possible return.** The original returns only the id — no name, no config, no
   credentials. Nothing a caller could learn by probing it with numbers beyond whether a number is
   served, which answering the phone already reveals.
2. **`set search_path`** pinned. A `SECURITY DEFINER` function with a mutable `search_path` is a
   privilege-escalation hole. This repo pins `public, pg_temp`; Supabase's own guidance is
   `search_path = ''` with fully-qualified names (verified 2026-08-20). Either is defensible;
   **an unpinned one is not.**
3. **`revoke all … from public`, then grant to `ansa_app`.** A definer function left executable by
   `public` is the hole.
4. It bypasses RLS. That is the point, and it is why the body must not grow.

Everything after ingress runs `SECURITY INVOKER` (the default) inside `withOrganization`.

---

## 4. Rule 4: a call reads published configuration, never a draft

Saving in the console writes `agent_config_drafts`; publishing copies the document onto the agent
and **deletes the row, in the same transaction as the publish**. Doing the delete from the API
afterwards would leave a window where the configuration is live and the console still says there
are unpublished changes — and if that delete failed, it would say so forever.

This is a separate table rather than a `published boolean` on `agents` because a flag would put
unpublished text one forgotten `where` clause away from a caller. A table cannot be read by
mistake.

The live read path is three functions, all reading the agent's own columns and none of which
knows the drafts table exists:

- `app.agent_config_for_number(dialled)` — inbound ingress. Called via `dataSource.query`, not
  `scope.query`, because it is `SECURITY DEFINER` and runs before any scope exists
  (`packages/db/src/call-config.ts`).
- `app.agent_config_for_organization(organization)`
- `app.live_agent_for_organization(organization)` — resolves the organisation's oldest live agent,
  so the config endpoints and the publish agree on which agent they mean.

Two guards, both failing loudly:

- `packages/db/src/drafts.test.ts` — queries `pg_proc` and asserts no `app.*` function except
  `save_agent_draft`, `discard_agent_draft` and `publish_agent_config` mentions
  `agent_config_drafts` in its source.
- `apps/api/src/tenancy/call-path.test.ts` — walks `telephony`, `orchestrator`, `tenancy`,
  `outbound`, `conversation` and fails on any reference to `loadAgentDraft`, `saveAgentDraft`,
  `discardAgentDraft`, `liveAgentId`, or the literal string `agent_config_drafts` (because
  `scope.query` takes raw SQL, and a `join agent_config_drafts` would be invisible to a
  function-name scan).

Both assert their own file counts, because a scan that silently inspects nothing reports success
forever.

**A test call is a call.** Reading a draft "just to preview it" is the shape of the mistake.

In the draft document, `null` means *not staged* and an empty array means *staged as empty*. A
draft holding only a tool selection is ordinary; filling the other sections from the live row to
avoid the null would stage a stale copy and then publish over somebody else's change.

---

## 5. Soft delete

`deleted_at timestamptz` exists on exactly four tables: `organizations`, `users`, `memberships`,
`agents` (renamed from `archived_at` in 0032 — two flags meaning "gone" is a guaranteed bug the
first time code checks only one).

Not everywhere, and 0032 says why: *"a soft delete that reads still return is worse than none: a
'deleted' session that still authenticates, a 'deleted' credential that still opens an endpoint, a
'deleted' `do_not_call` row that stops suppressing calls."* Audio is hard-deleted because
retention is a promise. Calls, turns, transcripts and versions are records of things that
happened.

Consequences you must honour:

- Every read filters `deleted_at is null`. It is a rule, not a column.
- Partial indexes carry the predicate: `create index … on agents (organization_id) where
  deleted_at is null`.
- The `users` policy grants access *through a membership row*, so a deleted membership must stop
  granting it — otherwise removing somebody from an organisation leaves them able to read it.
- Paths reached without a session need their own filter. 0033 fixed two:
  `app.credentials_for_email` (a deleted user must not authenticate, and returning no row makes it
  indistinguishable from a wrong address) and the call-answering path (a deleted organisation must
  stop answering a number that still routes to it).

`packages/db/src/rls.test.ts` covers all of it adversarially — cross-organisation select, select
by id, filtering by the other organisation's id, aggregates that could leak row existence,
inserting a row stamped with another id, update, delete, subqueries, and every event-log table.
It runs in CI forever. Add to it when you add a table.

---

## 6. Full-text search (the knowledge base)

Schema, from `0034_knowledge_base.sql`:

```sql
search tsvector generated always as (
  setweight(to_tsvector('english', coalesce(question, '')), 'A') ||
  setweight(to_tsvector('english', body), 'B')
) stored
```

Weights are A = 1.0, B = 0.4, C = 0.2, D = 0.1 (Supabase FTS guide, verified 2026-08-20). A unit
whose *question* matches beats one that merely mentions the words in a long answer.

The query in `searchKnowledge` (`packages/db/src/knowledge.ts`) does four unobvious things:

**1. `plainto_tsquery` with `&` rewritten to `|`.**

```sql
replace(plainto_tsquery('english', $2)::text, '&', '|')::tsquery
```

`plainto_tsquery` produces AND semantics — verified: `plainto_tsquery('english','The Fat Rats')`
→ `'fat' & 'rat'`. AND does not survive a spoken question. `to_tsquery` would throw on a stray
operator and turn a bad transcription into a failed turn; `plainto_tsquery` never raises. So the
safety is kept and only the connective is changed, and it is safe to string-rewrite because the
text it produces is already sanitised lexemes.

`websearch_to_tsquery` is the other never-raises option and also produces `&` between bare terms;
it adds quoting, `OR`, and `-` negation, which are typed-search affordances a phone caller does
not have. Not obviously better here, but worth re-testing if the console gains a search box.

**2. Recall is paid for with `MIN_SHARED_TERMS = 2`, not a rank threshold.** The OR finds the right
passage and also anything sharing one common word — "Can I insure my dog on this policy" matched a
renewal passage on "policy" alone. A rank cutoff would have worked on that one corpus and nowhere
else: `ts_rank` is not comparable across collections of different sizes. Counting shared terms is,
because it is a property of the question and the passage rather than of the corpus.

**3. `ts_rank(u.search, q.query, 1)`.** Flag `1` divides the rank by 1 + log(document length)
(PostgreSQL docs, verified: 0 ignores length, 1 = log divisor, 2 = linear, 4 = harmonic distance
between extents for `ts_rank_cd` only, 8 = unique words, 16 = 1+log(unique words), 32 = rank/(rank+1);
combine with `|`). Without it, "Ikeja branch closes at 5pm" and a sixty-word paragraph saying the
same thing both scored 0.0405 and the winner was whichever was typed first. The passage is read
aloud in a two-sentence turn — the short one is not tidier, it is the better answer.
`ts_rank_cd` tied them too.

**4. `set local statement_timeout = '2500ms'` before the query.** The dispatcher's 3 s ceiling only
abandons the promise; the query carries on holding a connection and burning CPU for a turn nobody
is listening to. `AbortSignal` cannot help — node-postgres has no way to stop a statement in
flight short of `pg_cancel_backend` on a second connection. `SET LOCAL` is scoped to the
transaction `withOrganization` already opened, so it cannot leak to the next borrower of a pooled
connection. Slightly under the tool ceiling on purpose, so the search is the thing that gives up
and the caller hears the fallback sentence.

**The `'english'` config must match the generated column.** A query parsed under a different one
silently matches nothing, which reads as an empty knowledge base.

**The join through `agent_knowledge_sources` is the security property**, not a filter — it is why
an agent cannot answer out of a source it was never given, and it is written inside the one
retrieval function so no path exists without it.

---

## 7. Things that are not what you'd guess

1. **An empty result is the default failure mode, not an error.** Unset scope → `NULL` →
   every policy false → zero rows. It looks like an empty database.
2. **`length > 0` on an `update … returning` is always true.** The driver returns
   `[rows, count]`. Use `scope.mutate`.
3. **`timestamptz` is a `Date`, not a string.** Every row interface must say so.
4. **`BYPASSRLS` is a role attribute separate from superuser, and it defeats FORCE.** Nothing in
   `pg_policies` or `relforcerowsecurity` reveals it.
5. **`ENABLE` alone leaves the table owner exempt.** FORCE is what closes it, and it is free.
6. **Transaction pooling forbids session state but not `SET LOCAL`.** That distinction is the
   whole reason the app can run on 6543.
7. **`plainto_tsquery` is AND.** Almost every naive FTS implementation in the wild assumes OR.
8. **`ts_rank` scores are not comparable across corpora.** Never threshold on one.
9. **A partial index needs the same predicate as the query.** `where deleted_at is null` in one
   and not the other means a sequential scan.
10. **Migrations run as `postgres`; the app must not.** Two URLs, two roles, on purpose.
11. **`?pgbouncer=true` on `DATABASE_URL` is a Prisma flag.** `pg-connection-string` parses unknown
    query parameters into the config object and node-postgres does not forward them — so it is
    *inert here rather than wrong*. Inferred from reading `pg-connection-string@2.14.0`, **not
    doc-verified**; do not rely on it if the driver ever changes.

---

## 8. Version and platform facts (verified 2026-08-20)

- Self-hosted Supabase's default image moved from **Postgres 15 to Postgres 17 on 2026-06-17**.
  PG 17 cannot read a PG 15 data directory; `timescaledb`, `plv8`, `plcoffee` and `plls` are no
  longer included.
- **The Postgres major version on hosted Supabase projects is not stated** on the pages I could
  fetch (`/docs/guides/platform/upgrading`, `/docs/guides/database/extensions`). **Unverified** —
  read it from `select version()` rather than assuming.
- Hosted upgrades use `pg_upgrade` with downtime; projects with read replicas cannot be upgraded
  until the replicas are deleted.
- Supabase ships "over 50" pre-configured extensions, enabled with
  `create extension <name> with schema extensions`. The docs page no longer enumerates them. This
  repo uses only `pgcrypto` (`0001_schema_v1.sql`, for `gen_random_uuid()`).
- Default roles: `postgres` (admin), `anon`, `authenticator`, `authenticated`, `service_role`
  (documented as bypassing RLS), `supabase_admin`. The docs do not enumerate which carry
  `BYPASSRLS` beyond `service_role` — which is why 0002 asserts `rolbypassrls` directly instead of
  trusting the documentation.
- None of PostgREST, `auth.uid()`, `anon` or `authenticated` is used here. Ansa authenticates in
  the API and scopes with `set_config`. Supabase RLS examples written around `auth.uid()` need
  translating to `app.current_organization()` before they mean anything in this repo.

---

## References

- `references/rls-patterns.md` — policy recipes, the definer-function checklist, the adversarial
  test list, and what a new table needs end to end.
- `references/pooling-and-driver.md` — the three URLs, what transaction mode forbids, the TypeORM
  return shapes, `Date` handling, and `statement_timeout` under a pooler.
