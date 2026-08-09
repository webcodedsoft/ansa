# The dashboard API

Self-service for a tenant organisation: its people, its agent's configuration, its call
history. Read `CLAUDE.md` first — everything here is downstream of rule 3.

Two files are worth reading before you write anything:

- `calls/calls.controller.ts` — a capability-gated, paginated read. Closest to what you
  are probably building.
- `auth/auth.controller.ts` — a public route, an authenticated one, and a write.

---

## The one thing that is not negotiable

**A handler has no way to name a tenant.** Not a header, not a query parameter, not a path
segment, not an argument. This is not a rule anybody has to remember; it is what the types
and the wiring allow.

```ts
const members = await this.db.tx((scope) => listMembers(scope, page));
```

Five layers hold that up, and each one fails closed on its own.

**1. The credential carries the organisation.** A session token is
`ansa_s.<tenant uuid>.<secret>`. The tenant in it is an unverified claim, and acting on it
before verifying it is safe because of *how* it is acted on: the request opens a
transaction scoped to the claimed tenant and looks the session up inside it, under RLS. A
token rewritten to name a different organisation finds no session row. The lie is what
makes it fail — nothing compares the claim to anything, so there is no comparison to leave
out. `auth/tokens.ts`, `tenancy/tenant-gateway.ts`.

**2. `TenantContext.tx()` is the only door.** It is request-scoped, reads the principal the
guard put on the request, and has no tenant parameter. If the guard never ran, it throws
rather than falling back to an unscoped connection — which would present as "this
organisation has no data" and be an isolation failure disguised as an empty page.
`tenancy/tenant-context.ts`.

**3. Query functions take a `TenantScope`, never `(db, tenantId)`.** A `TenantScope` only
comes out of `withTenant`, so holding one means the transaction has already set
`app.tenant_id`. And because there is no tenant id in the signature, there is no tenant id
to pass the wrong value for. Both of the usual mistakes are unrepresentable.
`packages/db/src/accounts.ts`, `packages/db/src/call-page.ts`.

**4. The guard is global and deny-by-default.** `ApiGuard` is an `APP_GUARD`. Every route
under `/api/v1` inherits it the moment it exists. A route there with no `@Endpoint`
decorator is refused with a 500, because a route whose access control was forgotten and a
route everyone may call must not look the same. `auth/api.guard.ts`.

**5. Postgres.** RLS is enabled and *forced* on every table, with a policy on each. Even a
bug in all four layers above sees zero rows rather than someone else's.
`packages/db/migrations/0016_api_accounts.sql`.

`routes.test.ts` is the test that keeps this true after everyone who wrote it has moved on.
It walks the controllers `ApiModule` registers and fails if a route is outside the prefix,
missing an `@Endpoint`, publicly reachable without being on a written-down list, public
without a rate limit — and it greps the source for `withTenant`, `createDataSource` and
`API_DATA_SOURCE` outside `tenancy/`. `isolation.test.ts` then does it for real, over HTTP,
with two organisations and a forged token.

> The eslint rule that would express layer 3 mechanically is not there because this
> repository's hooks refuse edits to `eslint.config.mjs`. The source scan in
> `routes.test.ts` is standing in for it and fails the same build.

---

## Writing an endpoint

```ts
@Controller(apiRoute("agents"))            // never a raw path string
export class AgentsController {
  constructor(private readonly db: TenantContext) {}

  @Get()
  @Endpoint({
    summary: "List this organisation's agents, newest first",
    capability: "config:read",             // required. no default.
    query: pageQuery,
    response: pageResponse(agent),
  })
  async list(@FromQuery() query: Infer<typeof pageQuery>) {
    const page = toPageRequest(query);
    return toPageBody(await this.db.tx((scope) => listAgents(scope, page)));
  }
}
```

Then add the controller to `API_CONTROLLERS` in `api.module.ts` — one list, used to
register the controllers, attach the middleware, build the OpenAPI document and drive the
tests.

### `@Endpoint` is the whole contract

One decorator, read by four things that therefore cannot disagree: the guard takes
`capability` from it, the rate limiter takes `rateLimit`, the interceptor takes the
schemas, and the OpenAPI generator takes all of it.

- `capability` — a value from `auth/capability.ts`, or `"authenticated"` (any member, for
  routes about the caller themselves), or `"public"`. Public routes must declare a
  `rateLimit`, and adding one changes `routes.test.ts`, so it shows up in review.
- `params` / `query` / `body` — schemas. **A part with no schema accepts nothing**: the
  handler receives `undefined`. "I forgot to declare the body" must not look like "this
  endpoint takes no body".
- `response` — omit it and the endpoint answers 204.
- `status` — defaults to 200, or 204 with no response. Set 201 on a create.

### Schemas

`http/schema.ts`: `text`, `integer`, `flag`, `choice`, `list`, `object`, `optional`,
`nullable`. Shared field shapes are in `schemas.ts` (`uuid()`, `email()`, `timestamp()`,
`role()`). A schema used by one endpoint lives in that endpoint's file.

Two things it does that are easy to miss:

- **Unknown fields on input are a 422**, not silently ignored. A caller who misspells a
  field wants to hear about it.
- **The response schema is an allowlist.** The returned value is projected through it and
  anything it does not name is dropped. So a column added to a table cannot leak through
  an endpoint nobody updated, and `openapi.json` cannot describe a response the API does
  not send. Do not bypass it by returning `unknown`.

Handler parameters come from `@FromPath()`, `@FromQuery()`, `@FromBody()` — never Nest's
own `@Body()` or `@Query()`, which hand over whatever arrived. Type them
`Infer<typeof theSchema>` and the annotation is true rather than hopeful.

### Pagination

Keyset, `?limit=&cursor=` in, `{ items, nextCursor }` out, cursor opaque. `toPageRequest`
on the way in, `toPageBody` on the way out, and the query function does
`keysetWhere` / `keysetOrder` / `keysetParams` / `toSlice` from `@ansa/db`. Offset
pagination is wrong on these lists: they are newest-first and written to constantly, so a
row arriving between pages makes a reader see a duplicate.

### Errors

Throw Nest's exceptions. `ProblemFilter` turns everything under `/api/v1` into RFC 9457
`application/problem+json` with a stable `type`, and logs 5xx with the request id and the
tenant. Anything that is not an `HttpException` becomes a bare 500 — its message never
reaches the client, because it is as likely to be a connection string as a sentence.

**404, not 403, for someone else's record.** Under RLS "not yours" and "not there" are the
same query result, and answering differently would confirm the id exists.

### Writing to the database

Use `scope.mutate()` for `update` and `delete` with a `returning` clause, and `scope.query()`
for everything else. TypeORM's driver returns `[rows, affectedCount]` for those two
statements — a two-element array whether or not anything matched — so
`(await scope.query("update … returning id")).length > 0` is **always true**. That bug
shipped in the first draft of this layer and `isolation.test.ts` caught it: changing a
member of another organisation answered 200 while changing nothing.

---

## OpenAPI and the client

```
pnpm --filter @ansa/api openapi
pnpm --filter @ansa/api openapi -- --client ../../../web/src/ansa-api.ts
```

`apps/api/openapi.json` is committed and `openapi.test.ts` fails if it is stale, so the
spec cannot be edited by hand into something the code does not do. The client generator
lives in `openapi/client.ts` — in TypeScript, so it is typechecked and tested like
everything else — and emits one dependency-free file with a method per operation.

The generated client is not committed. It is a build artefact of whichever frontend
consumes it.

---

## What is deliberately not here

- **No `organisations` table.** An organisation *is* a row in `tenants` — the row the
  carrier resolves a dialled number to. A parallel table would be a second answer to "who
  is this customer".
- **No self-serve sign-up.** Tenants are onboarded by hand (PRD §11): `provision.mjs`
  creates the organisation, `owner.mjs` invites its first owner. Everything after that is
  self-service.
- **No email.** `POST /invitations` returns the token once and a human passes it on. When a
  mailer arrives the token stops being in the response and starts being in the message;
  nothing else changes.
- **No password reset, and no "my sessions" list.** Both need email or more UI than exists.
  `sessions` already records `user_agent` and `last_seen_at` for the second one.
- **No refresh tokens.** Sessions are absolute, seven days, then sign in again. A sliding
  window keeps a stolen token alive exactly as long as the thief keeps using it.
- **No call audio.** `RECORD_AUDIO_DIR` writes the caller's raw µ-law stream to the
  process's own disk. It is an operator diagnostic that is off by default, keyed by the
  carrier's call id rather than by anything this API exposes, swept on
  `tenants.audio_retention_days`, and playable by nothing without transcoding — so an
  endpoint over it would answer 404 for almost every call and would make this API a media
  path. The real objection is what the file is: a caller reading their policy number
  aloud. Serving that needs expiring, single-use, unguessable URLs and a record of who
  listened to whose voice. That is a slice with its own decisions, not a field on a
  response. The review loop it would serve works without it, because the question a
  reviewer answers is "is this text what was said".
- **No distributed rate limiting.** `http/rate-limit.ts` is per process and protects
  password and token guessing. Traffic shaping belongs in front of the process.
