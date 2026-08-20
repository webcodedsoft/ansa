---
name: nestjs-api-standards
description: How to write backend code in apps/api — the @Endpoint decorator, the one schema object that serves validation, response projection and OpenAPI, capability authorisation, RFC 9457 problems, and organisation-scoped database access. Use when adding or changing an HTTP route, a controller, a guard, an interceptor, a Nest module or provider, a carrier webhook, or anything under apps/api/src.
---

# NestJS in Ansa

`apps/api` is NestJS 11 on `@nestjs/platform-express` (Express 5), TypeScript 5.9 strict,
vitest. Read `ansa-harness` first if you have not.

The thing that makes this codebase specific is §2: **one schema object per shape, used
three times.** Nearly everything else follows from it.

---

## 1. There are three HTTP surfaces, and only one of them is "the API"

| Surface | Path | Auth | Error shape |
|---|---|---|---|
| Dashboard API | `/api/v1/**` | Bearer session token → capability | RFC 9457 `application/problem+json` |
| Carrier webhooks | `/telephony/**`, `/handoff/**` | Twilio signature | Nest's default. Twilio reads status codes and TwiML. |
| Internal viewer | `/viewer/**` | `VIEWER_TOKEN` shared secret | Nest's default |
| Media socket | `ws` upgrade on the HTTP server | Stream parameters | not HTTP |

`ProblemFilter` is registered as `APP_FILTER` (application-wide) but **checks
`isApiPath()` and defers everything else to `BaseExceptionFilter`**. That is deliberate: a
webhook is not the place to discover its error body changed shape.

The media socket is attached in `main.ts` *after* `app.listen()`, not in a Nest lifecycle
hook, because `ws` attaches to a listening server:

```ts
await app.listen(config.port);
app.get(MediaGateway).attachTo(app.getHttpServer() as Server);
```

---

## 2. One schema object, used three times

`apps/api/src/api/http/schema.ts` is a small hand-rolled schema library. Not zod, and not a
validation library plus a decorator library, because two libraries means two declarations
of one shape and the failure mode is *a spec that lies* — which is worse than no spec,
because the frontend's types come from it.

A schema declared beside a handler is:

1. what **validates** the incoming request (`unknown: "reject"`, coercion on query/params),
2. what the outgoing response is **projected** through (`unknown: "strip"` — an allowlist),
3. what appears in `openapi.json` and therefore in the **generated client**.

Those three cannot drift, because there is only one of them.

### The vocabulary

```ts
text({ minLength, maxLength, pattern: RegExp, format })   // Schema<string>
choice(["read", "write"] as const)                        // Schema<"read" | "write">
integer({ minimum, maximum })                             // Schema<number>
number({ minimum, maximum })                              // fractional — rates, thresholds
flag()                                                    // Schema<boolean>
list(item, { maxItems })                                  // Schema<readonly T[]>
object({ a: text(), b: optional(integer()) })             // Schema<{ a: string; b?: number }>
map(values, { maxProperties })                            // keys the caller chooses — headers
optional(s)  /  nullable(s)                               // wrappers
type Infer<typeof s>                                      // the produced type
```

It is deliberately small. Grow it when an endpoint genuinely needs more, not in
anticipation — each thing it cannot express is a thing the generated client would not have
handled either.

Optionality is read off the output type (`undefined extends Infer<P[K]>`), so there is one
source of truth for a property being optional at both the type level and at runtime.

`toJsonSchema` emits **OpenAPI 3.1**: nullable is `type: ["string", "null"]`, not the 3.0
`nullable: true` keyword. Generators built for 3.1 silently ignore the old keyword and
produce a client that thinks a field is never null.

### Shared field shapes

`apps/api/src/api/schemas.ts` holds only what more than one endpoint needs — `uuid()`,
`email()`, `phoneNumber()` (E.164), `timestamp()`, `role()`, `capturedField`. **A schema
used by exactly one endpoint belongs in that endpoint's file**, next to the handler it
describes.

Pagination is in `api/http/pagination.ts`. Spread `PAGE_PROPS` into a filtered query rather
than redeclaring `page`/`perPage` — that is how one endpoint quietly ends up accepting
`perPage=5000`.

---

## 3. `@Endpoint` — everything about a route except its implementation

```ts
export interface EndpointSpec {
  summary: string;                    // one line, imperative → OpenAPI summary + client doc
  description?: string;
  capability: Capability | "public" | "authenticated";
  params?: Schema<unknown>;
  query?: Schema<unknown>;
  body?: Schema<unknown>;
  response?: Schema<unknown>;         // omitted ⇒ 204
  status?: number;                    // defaults 200, or 204 with no response. 201 on create.
  rateLimit?: { limit: number; windowMs: number; by: "ip" | "ip+email" };
}
```

Three readers, one source: `ApiGuard` reads `capability`; `EndpointInterceptor` reads the
four schemas; `openapi/document.ts` reads all of it. So a route cannot be documented as
requiring one capability and enforce another.

`Endpoint` also applies `HttpCode(statusOf(spec))`. This is not tidiness: Nest resolves the
status from its own metadata before any interceptor runs, and assigning `res.statusCode`
later is overwritten. Without it, Nest's default 201-for-POST would quietly contradict the
spec.

**A route under `/api/v1` without `@Endpoint` does not run.** `ApiGuard` throws a 500 —
"this route declares no `@Endpoint`, so its access control is undefined" — and
`routes.test.ts` fails the build first. There is no default capability, because "I did not
think about access control" and "everyone may call this" must not look the same in a diff.

### A complete endpoint

`members.controller.ts` is the shortest complete example — a paginated read, a write with
both a path parameter and a body, and a delete. Note that **none of them mentions an
organisation, because there is nowhere in the pipeline for one to be mentioned.**

```ts
const member = object({
  userId: uuid(),
  email: email(),
  displayName: text({ maxLength: 200 }),
  role: role(),
  createdAt: timestamp(),
});
const memberPage = pageResponse(member);
const memberPath = object({ userId: uuid() });
const roleChange = object({ role: role() });
const roleChanged = object({ userId: uuid(), role: role() });

@Controller(apiRoute("members"))
export class MembersController {
  constructor(@Inject(OrganizationContext) private readonly db: OrganizationContext) {}

  @Get()
  @Endpoint({
    summary: "List the people in this organisation, newest first",
    capability: "members:read",
    query: pageQuery,
    response: memberPage,
  })
  async list(@FromQuery() query: Infer<typeof pageQuery>): Promise<Infer<typeof memberPage>> {
    const page = toPageRequest(query);
    return toPageBody(await this.db.tx((scope) => listMembers(scope, page)), query);
  }

  @Patch(":userId")
  @Endpoint({
    summary: "Change someone's role",
    description: "Refuses with 409 if it would leave the organisation without an owner.",
    capability: "members:write",
    params: memberPath,
    body: roleChange,
    response: roleChanged,
  })
  async setRole(
    @FromPath() path: Infer<typeof memberPath>,
    @FromBody() body: Infer<typeof roleChange>,
  ): Promise<Infer<typeof roleChanged>> {
    const changed = await this.db.tx((scope) => setMemberRole(scope, path.userId, body.role));
    // Not a member here — which, under RLS, is also what a member of another
    // organisation looks like. 404 for both; a 403 would confirm the id exists.
    if (!changed) throw new NotFoundException();
    return { userId: path.userId, role: body.role };
  }
}
```

**Use `@FromPath` / `@FromQuery` / `@FromBody`, never Nest's `@Param` / `@Query` /
`@Body`.** Nest's hand over whatever arrived. Ours hand over what the schema produced,
already coerced and already rejected if wrong — so a parameter typed
`Infer<typeof roleChange>` is telling the truth. They throw if the interceptor did not run
rather than handing over unvalidated input.

`@Controller(apiRoute("members"))`, never a string literal. `apiRoute` prefixes
`api/v1/`, and `routes.test.ts` fails if any controller in `ApiModule` ends up outside the
prefix — which is the one way a dashboard endpoint could reach a handler unauthenticated.

### Register it

Add the controller to `API_CONTROLLERS` in `apps/api/src/api/api.module.ts`. That one list
is used three times: to register the controllers, to attach `RequestIdMiddleware`
(by controller, not by path pattern — no route-matching syntax to get wrong), and by
`routes.test.ts` to audit every route. A controller added there is guarded, validated and
audited by the act of adding it.

### Then regenerate the client

```bash
pnpm --filter @ansa/web generate
```

Rewrites `apps/api/openapi.json` and `apps/web/src/lib/api/generated.ts`. Both are
committed. `openapi.test.ts` diffs the committed spec against a fresh build; `next build`
typechecks the client. Skipping this breaks the build twice.

---

## 4. Response projection is an allowlist

`EndpointInterceptor.project` parses the handler's return value through `spec.response`
with `unknown: "strip"`. Anything the schema does not name is dropped.

**A new column cannot leak through an endpoint that was not updated to expose it.** A
`password_hash` that finds its way onto a row object never reaches the wire. It also means
`openapi.json` cannot describe a response the API does not send, because the same object
enforces both.

If the handler returns something its own schema rejects, that is a bug in us, never in the
caller — so it is a **500**, not a 422 blaming them:

```
response did not match its schema: role must be one of: member, admin, owner
```

That message is the commonest failure you will hit when adding an endpoint. It means your
`response` schema and your query's actual row shape disagree.

---

## 5. Capability-based authorisation

`apps/api/src/api/auth/capability.ts`. **Routes name a capability; roles hold
capabilities.** The indirection earns its place the first time a fourth role appears: with
`role === "owner"` scattered through handlers, adding one means finding every comparison.

```ts
type Capability =
  | "calls:read" | "calls:write"
  | "members:read" | "members:write"
  | "invitations:read" | "invitations:write"
  | "config:read" | "config:write";

const GRANTS: Record<MemberRole, readonly Capability[]> = { member: […], admin: […], owner: […] };
```

`capabilitiesOf(role)` is shipped to the dashboard through `GET /auth/me` so it can hide
controls the caller cannot use — **from the same table the guard enforces**. A second copy
on the frontend is how a button appears that always returns 403.

`ApiGuard` (an `APP_GUARD`) does four things and nothing else:

- not an API path → **defer**. Webhooks authenticate by signature; the media socket is not
  HTTP.
- API path, no `@Endpoint` → **refuse, 500**.
- `capability: "public"` → allow. Currently four routes, and `routes.test.ts` writes the
  list out so making a fifth one public shows up in review.
- otherwise → resolve the bearer token to a `Principal`, then check `can(role, capability)`.

One answer — "that session is not valid" — for an unknown token, an expired one, a revoked
one, and one belonging to a different organisation. Distinguishing them tells the holder of
a stolen token which part of their guess was right. `rememberPrincipal` runs *before* the
capability check, so a 403 is still attributable in the logs.

Guard order in `ApiModule` matters and only for the guards: `RateLimitGuard` is registered
before `ApiGuard`, so the endpoints it protects are throttled before they spend a hundred
milliseconds of scrypt.

**Every `"public"` route must declare a `rateLimit`.** `routes.test.ts` enforces it.

---

## 6. Errors are RFC 9457 problem documents

```ts
interface Problem {
  type: string;        // "urn:ansa:problem:validation-failed" — a URN, because a URL
  title: string;       //   implies a page that exists and nobody owns that hostname
  status: number;
  detail?: string;
  requestId?: string;  // echoed from X-Request-Id, so a screenshot finds the log line
  errors?: readonly { path: string; message: string }[];   // 422 only
}
```

Throw ordinary Nest exceptions — `NotFoundException`, `ConflictException`,
`ForbiddenException`, `ServiceUnavailableException`. `ProblemFilter` converts them.

- **422, not 400,** for a request that failed its schema: the server understood the JSON
  and the *content* was wrong. 400 is reserved for a body Express could not parse at all.
- **Anything that is not an `HttpException` is a bug.** Its message is as likely to be a
  stack frame or a connection string as anything useful, so it goes to the log and never to
  the client. Only 5xx is logged, and it is logged with `organizationId` on the line
  (harness rule 3) so "is this one organisation or all of them" is answerable without a
  repro.
- Validation messages are written to follow the field name, because the console joins them:
  `"is required"`, `"is not in the expected format"`, `"must be at most 200 characters"`.
  `minLength: 1` renders as **"is required"**, not "must be at least 1 characters" — an
  empty box is a missing answer, not a length problem.

Turning a database error into the right status is a real pattern here — see the
last-owner rule in `members.controller.ts`, which matches on a message *we wrote* in a
migration next to it in the diff, because counting owners in the handler first is a check
that races.

`document.ts` **derives** which failures an operation can produce rather than listing them:
input schemas mean 422 is possible, a capability means 401 and 403 are, a rate limit means
429 is. Listing by hand would let an operation document a 403 it cannot return.

---

## 7. Organisation-scoped database access

This is harness rule 3, made structural.

```ts
// In any controller:
const members = await this.db.tx((scope) => listMembers(scope, page));
```

There is no organisation id in that line, **and there is nowhere to put one.**

- `OrganizationGateway` is the only thing in the API that holds a database handle. It has
  no `query()` and no `run(organizationId, work)`. Its five non-`run` methods are each one
  named operation with a fixed statement, and four exist only because sign-in happens
  before an organisation is known.
- `OrganizationContext` is `@Injectable({ scope: Scope.REQUEST })`, reads the `Principal`
  the guard put on the request, and exposes `tx(work)`. The organisation comes off the
  principal and cannot be passed in.
- Every `@ansa/db` function this surface uses takes an `OrganizationScope` as its first
  argument. So the two ways a scoped query goes wrong — forgetting the scope, passing the
  wrong id — are both unrepresentable.
- If the guard did not run, `tx` **throws** rather than falling back to an unscoped
  connection. An unscoped connection presents as "the organisation has no data", which is
  a silent isolation failure rather than a loud wiring one.

`routes.test.ts` source-scans every file under `src/api` outside `src/api/tenancy` (and
`api.module.ts`, which is the wiring) and fails on any mention of `withOrganization`,
`createDataSource` or `API_DATA_SOURCE`. A second assertion fails on `, organizationId` or
`(organizationId` — passing one as an argument is the mistake this design removes.

### Two pools, on purpose

`API_DATA_SOURCE` (dashboard) and `DATA_SOURCE` (call path) are separate symbols with
separate pools, for two reasons that are both about failure:

- **Capacity.** A dashboard is bursty and a call is not. One pool means a report query and
  twenty page refreshes can exhaust the connections a live call needs to write its
  transcript, and the caller pays.
- **Policy.** They want opposite things from an unreachable database. The call path
  degrades to default configuration and answers anyway, because silence on the line is
  worse than a generic greeting (R6.2). The dashboard **refuses with 503** — an empty call
  list shown to someone auditing their calls is a lie.

Both boot with `await dataSource.query("select 1")` and both survive an unreachable
database at boot by returning `null`, because this process also answers calls.

---

## 8. Modules, providers and DI

No `@nestjs/config`. Configuration is a plain function: `loadConfig(env)` in
`apps/api/src/config/env.ts` returns a frozen `AppConfig`, provided under the `APP_CONFIG`
symbol. `loadApiConfig()` is its dashboard sibling.

Injection tokens are `Symbol`s exported from a `tokens.ts` beside the module, each with a
docstring explaining why it exists. Providers are factories:

```ts
{
  provide: TTS_PROVIDER,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig) => createElevenLabsTts({ apiKey: config.elevenLabsApiKey }),
}
```

`TelephonyModule` is **the only place a carrier is named**. Swapping Twilio means changing
one factory.

Config validation happens at boot and fails loudly. `TOOL_CREDENTIAL_KEY` must be 32 bytes
base64 or `loadConfig` throws, because a wrong-length key means every credential in the
vault is unopenable and that presents as "all the organisation's tools are broken" three
layers from the cause. `DEEPGRAM_API_KEY` is `required` rather than conditional, because a
deployment without it cannot hear the caller stop talking — it should fail at boot rather
than answer a call and never reply.

**Export what other modules inject.** `TelephonyModule` exports `ORGANIZATION_REGISTRY`
with a comment saying why: providing without exporting is a boot failure, not a lint error.

### Booting

`main.ts` is worth reading in full once. Three decisions that cost real time to rediscover:

```ts
const app = await NestFactory.create(AppModule, {
  logger: ["error", "warn"],     // ours is the structured logger; but startup errors are
  abortOnError: false,           // the only thing explaining a failed boot
});
```

`abortOnError: false` is the load-bearing one. Nest's default on a failed dependency
resolution is `process.abort()` — a native core dump taken *before* the bootstrap promise
settles, so the `catch` at the bottom of the file had never once run. A one-line missing
export presented as a silent exit with an empty log.

`unhandledRejection` and `uncaughtException` are logged and **deliberately do not exit**:
there is no supervisor, and exiting drops every call in progress to save one. The
`bootstrap().catch` *does* `process.exit(1)`, because nothing is listening yet and a
half-started process holding an open pool sits there looking healthy. `exitCode` alone was
not enough — an open pool keeps the event loop alive indefinitely.

---

## 9. Style rules that bite

- **`func-style: ["error", "expression"]`.** Free functions are `const f = () => …`.
  **Class methods are exempt automatically** — the rule only sees free functions — so
  controllers, modules, guards, interceptors and gateways stay classes with ordinary
  methods. Decorators require it.
- Expressions do not hoist. A helper must appear **above** its first use. Moving code
  produces "used before declaration".
- `no-console` is an error. Use `createLogger({ component: "api" })` from `@ansa/shared`.
- `@typescript-eslint/no-explicit-any` is an error. The `eslint-disable` line *is* the
  comment explaining why, which makes the exception visible in review.
- `consistent-type-imports` is on: `import type { Foo }`.
- `noUncheckedIndexedAccess` is on in the base tsconfig. `array[0]` is `T | undefined`.
- No vendor SDK imports outside `packages/providers/*` — `noVendorSdks` covers `apps/api`.

---

## 10. Failure modes, and how they present

| Symptom | Cause |
|---|---|
| 500 `"this route declares no @Endpoint"` | You added a route under `/api/v1` and forgot the decorator. `routes.test.ts` should have caught it first. |
| 500 `"response did not match its schema: …"` | Handler returns a shape the response schema rejects. Read the field named in the message. |
| 500 `"request was not validated: the API interceptor did not run"` | A `@FromBody`-style decorator on a handler the interceptor skipped — usually a route outside the prefix. |
| `Error: OrganizationContext used on a request that was never authenticated` | Controller wired outside `ApiModule`, or route outside the prefix so `ApiGuard` deferred. |
| Everything returns 503 | No `DATABASE_URL`, or the pool failed at boot. Check for `"no DATABASE_URL: the dashboard API will answer 503"` in the log. |
| Endpoint returns 200 where the spec says 201 | You set `status` in the spec but Nest resolved its own first — cannot happen if you used `@Endpoint`, which applies `HttpCode`. Suspect a hand-written `@HttpCode`. |
| `openapi.test.ts` fails | You changed a route and did not run `pnpm --filter @ansa/web generate`. |
| `next build` fails on `generated.ts` | Same cause, one layer later. |
| API exits 1 with no output | A missing provider export. If you see this, `abortOnError: false` has been removed. |
| A query returns zero rows that definitely exist | Ran outside `withOrganization`. `app.current_organization()` is NULL, RLS fails closed. |
| `packages/db` tests pass alone, fail in a full run | Fixture collision — another file owns that organisation-id prefix and deletes it in `afterAll`. |

---

## 11. Things that are not what you would guess

- **The OpenAPI document is not written; it is read off the controllers.** `document.ts`
  walks `controller.prototype` with `Reflect.getMetadata(PATH_METADATA, …)` and
  `METHOD_METADATA` from `@nestjs/common/constants` — a plain `Reflect.getMetadata` rather
  than Nest's `Reflector`, because the generator runs without an application context and
  must get the same answer the guard gets. Paths are sorted so regenerating after an
  unrelated change produces no diff; an "is the spec current" test is only useful if the
  output is deterministic.
- **The API version is derived from `API_PREFIX`**, not written twice. A spec whose version
  disagrees with the path it documents is a spec people stop believing.
- **`ApiRequest` is a structural interface, not `express.Request`.** Partly the vendor-type
  rule, partly practical: Express 5 made `req.query` a *getter*, so code that assigned to
  it silently stopped working. Nothing here writes to framework properties — validated
  values live under `request.ansa` and are read through the param decorators.
- **The rate limiter keys on `socket.remoteAddress`, deliberately not
  `X-Forwarded-For`.** A header any client can set is not an identity, and a limiter keyed
  on one is a limiter with an off switch. `clientAddress()` in `request.ts` is the one
  function to change when this sits behind a proxy we control.
- **`stateOf(request)` creates the per-request scratch space lazily** rather than requiring
  the middleware, so a controller wired without it still authenticates and merely loses its
  `X-Request-Id`. Throwing instead would be a 500 on a route that was otherwise fine.
- **A schema that declares nothing for a part accepts nothing from it.** If `spec.body` is
  undefined the handler gets `undefined`, not the raw body. Handing the raw value over
  would make "I forgot to declare the body" indistinguishable from "this endpoint takes no
  body".
- **Coercion is on for query and path, off for body.** A JSON body sending `"25"` for an
  integer is a client bug, and silently accepting it hides the bug until something sends
  `"25 "`.
- **404 rather than 403 for another organisation's record.** Under RLS they are the same
  fact, and a distinct 403 would confirm the id exists.
- **Nest's `Reflector` is not used for endpoint specs.** `specOf(handler)` is the single
  reader, shared by the guard, the interceptor and the generator.

---

## 12. NestJS 11 and Express 5

The v10 → v11 differences, the Express 5 consequences, and what this repo is and is not
exposed to, are in the companion file: **[`nestjs-11-express-5.md`](nestjs-11-express-5.md)**.

Read it before you write a wildcard route, touch `main.ts`, add a lifecycle hook, add a
Nest WebSocket adapter, or need a nested query parameter. The four that could actually bite
here, in one line each:

- **Query strings do not parse nested objects or arrays.** Express 5's default parser is
  `simple`, not `qs`. This repo does not change it; treat flat query strings as the constraint.
- **`req.query` is a getter with no setter** — assignment throws under strict mode, and the
  getter is not memoized. This is why `ApiRequest` is structural and validated values live
  under `request.ansa`.
- **Shutdown hooks run in the reverse of initialisation order** in v11, the opposite of v10.
  `main.ts` calls `enableShutdownHooks()`.
- **Never add `@nestjs/platform-ws` alongside the raw `ws` media gateway** — two path-scoped
  WebSocket servers on one HTTP server mutually kill each other's handshakes.

