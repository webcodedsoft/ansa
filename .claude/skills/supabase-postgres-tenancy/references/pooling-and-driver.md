# Pooling, the driver, and the shapes it returns

External facts fetched **2026-08-20** from:
- `https://supabase.com/docs/guides/database/connecting-to-postgres`
- `https://supabase.com/docs/guides/database/connection-management`
- `https://supabase.com/docs/guides/database/extensions`
- `https://supabase.com/docs/guides/platform/upgrading`
- `https://supabase.com/changelog` (via search: self-hosted PG 15 → 17 on 2026-06-17)

Repo facts cited by file.

---

## 1. The four connection modes

Verified from Supabase's connecting-to-Postgres guide:

| Mode | Port | Network | Notes |
|---|---|---|---|
| Direct | 5432 | IPv6 by default, IPv4 with add-on | "connects directly to your Postgres instance". Best for persistent servers, migrations, `pg_dump`. |
| Supavisor **session** mode | 5432 | IPv4-only on all tiers | Multi-tenant shared pooler. Recommended for "persistent backend on IPv4-only networks". |
| Supavisor **transaction** mode | 6543 | IPv4-only on all tiers | "ideal for serverless or edge functions". |
| Dedicated pooler (PgBouncer) | 6543 | IPv6 by default | Paid plans. "ensures best performance and latency". |

Transaction mode's constraints, verbatim and paraphrased from the same page:

- **"does not support prepared statements."** Turn them off, or errors follow.
- Does **not** support session-level features — `SET`, `LISTEN` — because connections are not
  maintained between transactions.

What that leaves working, and what Ansa depends on:

- `SET LOCAL` and `set_config(name, value, true)` are **transaction-scoped**, not session-scoped.
  They survive transaction pooling. This is the single fact that lets `withOrganization` run on
  the 6543 URL.
- `statement_timeout` set with `set local` inside a transaction is likewise safe
  (`packages/db/src/knowledge.ts`, before the full-text query).

---

## 2. Ansa's three URLs

From `.env.example`:

```
DATABASE_URL=postgresql://ansa_app.<project-ref>:<pw>@<region>.pooler.supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://ansa_app.<project-ref>:<pw>@<region>.pooler.supabase.com:5432/postgres
MIGRATION_DIRECT_URL=postgresql://postgres.<project-ref>:<pw>@<region>.pooler.supabase.com:5432/postgres
```

- **`DATABASE_URL`** — what the running API uses. `ansa_app`, pooled.
- **`DIRECT_URL`** — what the database-backed tests use
  (`organization-scope.test.ts`, `drafts.test.ts`, `organization-config.test.ts`,
  `onboarding.test.ts`, `rls.test.ts`). Still `ansa_app`, so the tests exercise the same policies
  production does.
- **`MIGRATION_DIRECT_URL`** — `postgres`. Migrations, `packages/db/seeds/dev-organization.mjs`,
  and `tools/organization/{provision,owner}.mjs`. Creating roles and policies requires the owner.
  Some test fixtures use it to *set up* rows that the `ansa_app` session then fails to see, which
  is the point.

**`DbConfig.url` in `data-source.ts` documents the requirement in the type:**

```ts
/**
 * Must point at a role with `rolbypassrls = false`. Supabase's `postgres` has
 * BYPASSRLS and would render every policy inert — see migrations/0002_rls.sql.
 */
readonly url: string;
```

### `?pgbouncer=true`

That parameter is a **Prisma** connection-string flag; Prisma uses it to disable prepared
statements. Reading `pg-connection-string@2.14.0` (`node_modules/.pnpm/...`), unknown query
parameters are collected into the parsed config object and node-postgres does not forward them to
the server, so here it is inert rather than wrong.

**This is inferred from source, not documentation.** node-postgres does not use server-side named
prepared statements unless you pass `name` to a query — which nothing in `packages/db` does — so
the underlying concern does not arise either way. If the driver ever changes, re-check both
halves of that.

---

## 3. TypeORM: the return shapes

`createDataSource` (`packages/db/src/data-source.ts`):

```ts
new DataSource({
  type: "postgres",
  url: config.url,
  synchronize: false,   // migrations are the only authority on schema
  logging: false,
  entities: [],         // no entities: everything is raw SQL through OrganizationScope
  poolSize: config.poolSize ?? 10,
});
```

`entities: []` is not an oversight. There is no repository layer; every query is raw SQL written
next to the comment explaining it.

### The trap

`runner.query()` returns:

| Statement | Returns |
|---|---|
| `select …` | `Row[]` |
| `insert … returning …` | `Row[]` |
| `update … returning …` | `[Row[], affectedCount]` |
| `delete … returning …` | `[Row[], affectedCount]` |

A two-element array is truthy and has `length === 2` whether or not anything matched. Hence:

```ts
const returnedRows = <T>(result: unknown): T[] => {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === "number"
  ) {
    return result[0] as T[];
  }
  return Array.isArray(result) ? (result as T[]) : [];
};
```

`scope.mutate` wraps it. `scope.query` does not. The two have the same TypeScript signature on
purpose — `mutate` unwraps the pair — so nothing in the type system can tell them apart and the
difference only shows in the SQL string. That is why the guard is a source scan
(`mutate-not-query.test.ts`) rather than a type.

Three separate regressions of this bug are on record: the original adversarial-API finding, then
`updateAgent` and `archiveAgent`, then `renameOrganization`.

### Transaction handling

```ts
} catch (error) {
  // The transaction may already be aborted by the failing statement; rolling back a
  // dead transaction would replace the real error with a meaningless one.
  if (runner.isTransactionActive) {
    await runner.rollbackTransaction().catch(() => undefined);
  }
  throw error;
} finally {
  await runner.release();
}
```

`isTransactionActive` before rollback, and `release()` in `finally`. A leaked query runner is a
leaked pooled connection.

---

## 4. `timestamptz` is a `Date`

node-postgres parses `timestamptz` into a JavaScript `Date`. The API's schema layer rejects
anything that is not an ISO 8601 string, which is how this was found.

Two conventions in the codebase, both fine:

```ts
// drafts.ts — the column is always present, so the type is exact
readonly updated_at: Date;
// …
updatedAt: row.updated_at.toISOString(),
```

```ts
// knowledge.ts — tolerant, for columns that may arrive either way
const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;
```

Typing a `timestamptz` column as `string` compiles, passes review, and fails at the API boundary
at runtime.

Other type notes:

- `count(*)` returns `bigint`, which the driver hands back as a **string**. `knowledge.ts` casts in
  SQL: `(select count(*)::int from knowledge_units u where …) as unit_count`.
- `uuid` comes back as a string. `asOrganizationId` brands it, and `withOrganization` rejects a
  malformed value in TypeScript rather than letting the cast in `app.current_organization()` fail
  mid-transaction with a less obvious error.
- Arrays (`text[]`, `integer[]`) come back as JS arrays. `jsonb` comes back parsed.

---

## 5. Cancelling a slow query

There is no client-side cancel. node-postgres has no way to stop a statement already in flight
short of a second connection issuing `pg_cancel_backend`. An `AbortSignal` on the promise only
abandons the promise — the query keeps holding a connection and burning CPU.

So bound it in Postgres:

```ts
await scope.query("set local statement_timeout = '2500ms'");
```

`set local` is scoped to the transaction `withOrganization` already opened, so it cannot leak to
the next borrower of a pooled connection. Set it slightly **under** whatever ceiling the caller
enforces, so the query is the thing that gives up and the caller can say something useful rather
than apologise for a tool that never answered.

---

## 6. Platform facts

- Self-hosted default image moved **PG 15 → PG 17 on 2026-06-17**. PG 17 cannot read a PG 15 data
  directory; `timescaledb`, `plv8`, `plcoffee` and `plls` are dropped from the images.
- **The hosted major version is not documented on the pages I fetched.** Read it with
  `select version()`. Unverified.
- Hosted upgrades: `pg_upgrade`, project offline during the window, original database returns if
  it fails, `pg_basebackup` taken on success. Projects with read replicas cannot be upgraded until
  the replicas are deleted.
- Extensions: "over 50" pre-configured; enable with `create extension <name> with schema
  extensions`. The overview page no longer lists them. Ansa uses `pgcrypto` only
  (`0001_schema_v1.sql`), for `gen_random_uuid()`.
- Connection monitoring: `pg_stat_activity`, the dashboard, and Grafana. Pool size is configurable
  in Supavisor. `poolSize` on our side defaults to 10.
