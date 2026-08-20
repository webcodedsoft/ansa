# RLS patterns

External facts fetched **2026-08-20** from:
- `https://www.postgresql.org/docs/current/ddl-rowsecurity.html`
- `https://www.postgresql.org/docs/current/textsearch-controls.html`
- `https://supabase.com/docs/guides/database/postgres/row-level-security`
- `https://supabase.com/docs/guides/database/postgres/roles`
- `https://supabase.com/docs/guides/database/full-text-search`

Repo facts are cited by file.

---

## 1. Who bypasses row security

Verbatim from the PostgreSQL docs:

> "Superusers and roles with the `BYPASSRLS` attribute always bypass the row security system when
> accessing a table. Table owners normally bypass row security as well, though a table owner can
> choose to be subject to row security with ALTER TABLE ... FORCE ROW LEVEL SECURITY."

And:

> "When row security is enabled on a table (with ALTER TABLE ... ENABLE ROW LEVEL SECURITY), all
> normal access to the table for selecting rows or modifying rows must be allowed by a row
> security policy. (However, the table's owner is typically not subject to row security policies.)"

So three exemptions: superuser, `BYPASSRLS`, and owner-without-FORCE. `ansa_app` is none of them,
and `0002_rls.sql` asserts the middle one at migration time because it is invisible to inspection.

Supabase's own note, verified: *"The `service_role` Postgres role has `bypassrls` attribute for
administrative tasks"*, and *"Table owners can bypass RLS with direct database access."*

---

## 2. Policy syntax

```sql
create policy "policy_name"
on table_name
for {select | insert | update | delete | all}
to role_name
using ( condition )        -- filters rows a statement can SEE
with check ( condition );  -- constrains rows a statement can WRITE
```

Which clause applies to which command:

| Command | `using` | `with check` |
|---|---|---|
| `select` | yes | — |
| `insert` | — | yes |
| `update` | yes (rows visible to update) | yes (the resulting row) |
| `delete` | yes | — |

Supabase's note, verified: **`UPDATE` requires a corresponding `SELECT` policy to function
properly.** This repo writes one `for all` policy with both clauses per table, which satisfies it.

Ansa's shape (`0038_drafts.sql`, and every table since 0002):

```sql
alter table agent_config_drafts enable row level security;
alter table agent_config_drafts force  row level security;
drop policy if exists organization_isolation on agent_config_drafts;
create policy organization_isolation on agent_config_drafts
  using (organization_id = app.current_organization())
  with check (organization_id = app.current_organization());
```

`drop policy if exists` first, so the migration is re-runnable.

The `organizations` table compares its own primary key instead:

```sql
create policy organization_isolation on organizations
  using (id = app.current_organization())
  with check (id = app.current_organization());
```

`users` is the one policy that grants access **through** another table (a live membership row).
That is why 0032's soft delete had to fix it: a deleted membership must stop granting access, or
removing somebody from an organisation leaves them able to read it.

---

## 3. Performance notes that also apply here

Supabase's guidance, verified:

- **Wrap a function call in `select`** so it is evaluated once per statement rather than once per
  row: `using ( (select auth.uid()) = user_id )`. Ansa's `app.current_organization()` is declared
  `stable`, which lets the planner do the same job; if you ever see a policy function evaluated
  per row in an `EXPLAIN`, this is the fix.
- **Index the column the policy filters on.** Every Ansa table has
  `create index … on thing (organization_id)`, and the soft-deleted ones carry the predicate:
  `create index agents_tenant_idx on agents (organization_id) where deleted_at is null`. A partial
  index only helps a query whose `where` clause matches its predicate.

---

## 4. `SECURITY DEFINER` checklist

Use it only where there is genuinely no scope to set — currently just ingress-time lookups and the
operator-side helpers. Every one of these must be true:

- [ ] `set search_path = public, pg_temp` (this repo) or `set search_path = ''` with fully
      qualified names (Supabase's guidance). Never unpinned — a mutable `search_path` on a definer
      function is privilege escalation.
- [ ] Returns the narrowest thing that answers the question. `app.tenant_for_number` returns the
      id and nothing else: no name, no config, no credentials.
- [ ] `revoke all on function … from public;` then `grant execute … to ansa_app;`
- [ ] `stable` (or `volatile` only if it writes).
- [ ] Body short enough to audit in one screen. It bypasses RLS; length is risk.
- [ ] Recreated from `pg_get_functiondef` if you are modifying an existing one — never retyped.
- [ ] If it takes the organisation as a parameter, it verifies the scope agrees:
      ```sql
      if app.current_organization() is distinct from organization then
        raise exception 'publish_agent_config needs the organization scope set: …';
      end if;
      ```
      (`app.publish_agent_config`, 0039.) A function that quietly wrote nothing looks exactly like
      a function that worked.

Existing definer functions, for reference: `app.tenant_for_number`, `app.agent_config_for_number`,
`app.agent_config_for_organization`, `app.close_call_by_carrier_id`, `app.expired_call_audio`,
`app.known_call_ids`, `app.min_audio_retention_days`, `app.purge_expired_audio_segments`,
`app.credentials_for_email`, `app.create_organisation`, `app.publish_agent_config`, and the
config/tools/hours/escalation/webhook readers and writers in 0011–0017.

---

## 5. Overload hazard

`create or replace function` matches on the **signature**. Adding a parameter creates a *second*
function beside the old one rather than replacing it. Migration 0039 found a 16-argument
`publish_agent_config` left behind when 0037 added `p_speaking_rate`:

> "Nothing calls it — the one caller passes seventeen — but it is still resolvable, and what it
> would do if resolved is publish a version that silently drops the speaking rate, skips it in the
> snapshot, and now also leaves the draft in place."

When you change a signature, `drop function if exists app.name(<old arg types>);` in the same
migration. Find survivors with:

```sql
select p.oid::regprocedure
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app'
 order by 1;
```

---

## 6. The guards, and what each one actually proves

| Guard | Proves |
|---|---|
| `packages/db/src/rls.test.ts` | Organisation A cannot read, count, insert-as, update, delete or subquery its way to organisation B's rows — across every event-log table, not just `calls`. Plus the soft-delete cases: a removed member's row, a deleted organisation still routed to by a number, a deleted user signing in. |
| `packages/db/src/mutate-not-query.test.ts` | No `scope.query` template literal contains `update`/`delete` with `returning`. Asserts its own file count so it cannot silently scan nothing. |
| `packages/db/src/drafts.test.ts` | No `app.*` function except `save_agent_draft`, `discard_agent_draft` and `publish_agent_config` mentions `agent_config_drafts` — read from `pg_proc.prosrc`, so it catches a function added tomorrow. |
| `apps/api/src/tenancy/call-path.test.ts` | No file under `telephony`, `orchestrator`, `tenancy`, `outbound`, `conversation` references the draft helpers *or the literal table name* (raw SQL through `scope.query` would evade a function-name scan). Asserts >20 files scanned. |
| `0002_rls.sql` | `ansa_app` does not have `BYPASSRLS`. At migration time, every time. |

Tests are excluded from the call-path scan deliberately: one may legitimately save a draft to
prove a call ignores it, which is the opposite of the mistake being looked for.

---

## 7. Adding a table: the full list

1. `organization_id uuid not null references organizations(id) on delete cascade` — denormalised,
   even when it is reachable by a join.
2. `created_at` / `updated_at timestamptz not null default now()`, plus the
   `app.touch_updated_at()` trigger (0031 put it everywhere; a new table without it is the
   inconsistency).
3. Index on `organization_id`; add `where deleted_at is null` if the table soft-deletes.
4. `enable` **and** `force` row level security.
5. `organization_isolation` policy with **both** `using` and `with check`.
6. `grant select, insert, update, delete … to ansa_app;`
7. Sequences, if any: `grant usage, select on all sequences in schema public to ansa_app;`
8. A case in `rls.test.ts` proving organisation A cannot see organisation B's rows in it.
9. A row interface in `packages/db/src/` typing `timestamptz` columns as `Date`.
10. If any live call path reads it, decide explicitly whether it belongs to the published
    document — and if it is editable in the console, whether it needs staging in
    `agent_config_drafts` (see 0040 and 0041 for how the rest of the agent was staged).

---

## 8. Translating Supabase RLS examples

Almost every Supabase example is written for PostgREST with `auth.uid()`, `anon` and
`authenticated`. Ansa uses none of that: authentication happens in the NestJS API, and the
database is told who is asking via `set_config('app.organization_id', …, true)`.

| Supabase example | Ansa equivalent |
|---|---|
| `to authenticated` | (omit — only `ansa_app` connects) |
| `(select auth.uid()) = user_id` | `organization_id = app.current_organization()` |
| `auth.jwt() ->> 'org'` | `app.current_organization()` |
| `service_role` for admin work | `MIGRATION_DIRECT_URL` as `postgres`, migrations and provisioning only |

Do not enable PostgREST-shaped policies "for consistency". The only client is the API.
