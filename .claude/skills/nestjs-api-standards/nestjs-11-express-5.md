# NestJS 11 and Express 5 — what differs from v10

Companion to `nestjs-api-standards`. Verified against the docs and the installed source,
August 2026. The lockfile resolves
`@nestjs/{common,core,platform-express}` to **11.1.28**, `express@5.2.1`,
`path-to-regexp@8.4.2`. Latest published is **11.2.1**. Express 5 is a *direct dependency*
of `platform-express@11`, not a peer — there is no supported way to stay on Express 4.

**Node >= 20 is the framework floor** (`@nestjs/core` declares `engines: { node: ">= 20" }`);
this repo requires >= 22.

## The four that could actually bite here

**1. Query strings do not parse nested objects or arrays.** Express 5 changed the default
query parser from `qs` (`extended`) to Node's flat `querystring` (`simple`). So
`?filter[where][name]=John` and `?item[]=1&item[]=2` no longer parse as you would expect,
and `apps/api` does **not** call `app.set('query parser', 'extended')`. Today nothing reads
a nested query parameter, and `PAGE_PROPS` + the filter schemas are all flat — treat flat
query strings as the constraint. If an endpoint ever genuinely needs a nested one, that is a
deliberate change to `main.ts` (and it requires typing
`NestFactory.create<NestExpressApplication>`), not something to work around in a handler.

**2. `req.query` is a getter with no setter.** This is why `ApiRequest` in `request.ts` is
structural and why nothing writes to framework properties. Two details beyond "assignment
fails": under strict mode — which all our output is — `req.query = x` **throws
`TypeError`**, and the getter is **not memoized**, so it re-parses the query string on every
access and mutating the object it returns is silently discarded. Validated values live under
`request.ansa` precisely so none of that matters.

**3. Shutdown hooks now run in the reverse of initialisation order.** `main.ts` calls
`app.enableShutdownHooks()`. In v11, `OnModuleInit` runs `C → B → A` and `OnModuleDestroy`,
`BeforeApplicationShutdown` and `OnApplicationShutdown` run `A → B → C` — dependencies are
destroyed *after* their dependents, which is what you want but is the opposite of v10.
Global modules initialise first and are destroyed last. Any drain logic written under v10
assumptions is worth re-reading; here it governs whether the media socket, the orchestrator
and the pools tear down in a safe sequence.

**4. Never add `@nestjs/platform-ws` alongside the raw `ws` media gateway.** Both install
an `upgrade` listener on the same `http.Server`, and Node fires all of them. Nest's
`WsAdapter` calls `socket.destroy()` on any path it does not own — including the media
socket — while `ws@8`'s `handleUpgrade` returns 400 for any path it does not own, including
Nest's gateway. **Two path-scoped WebSocket servers on one HTTP server mutually kill each
other's handshakes.** If both are ever needed, construct both with `{ noServer: true }` and
write one `upgrade` router that dispatches by pathname.

The current arrangement is idiomatic and safe *because* `@nestjs/websockets` is absent:
Nest loads it through `optionalRequire`, so with the package missing it registers no upgrade
handling at all, and `app.getHttpServer()` hands back a real `http.Server`.

## Route paths, if you ever write a wildcard

`path-to-regexp@8` changed the syntax and there are none in this codebase today:

| v10 | v11 |
|---|---|
| `/*` | `/*splat` — a *named* wildcard, matching any path **except** the root |
| `/*` including root | `/{*splat}` — braces make the group optional |
| `/:file?` | `/:file{.:ext}` — the optional `?` is gone |
| regex in a path | unsupported |
| `forRoutes('*')` | `forRoutes('{*splat}')` |

`()[]?+!` are reserved; escape with `\`. Nest auto-converts legacy forms and logs a warning
naming the converted route, so a stray `/*` will not crash — it will silently become
`{*path}`, which is *wider* than the `*splat` the docs recommend.

**This repo is immune by construction:** `ApiModule.configure` passes controller *classes*
to `forRoutes`, not path strings, and no route decorator anywhere contains a wildcard. Keep
it that way — "by controller rather than by path pattern" is written in the module's own
comment as "no route-matching syntax to get wrong", and Express 5 is the receipt.

## Smaller v11 items

- **Module resolution uses object references, not hashes.** A dynamic module used in two
  places is two instances unless you assign it to a variable and import that. In tests this
  shows up as a stubbed provider not taking effect; the escapes are
  `module.get(Target, { each: true })`, `module.select(Parent).get(Target)`, or
  `Test.createTestingModule({}, { moduleIdGeneratorAlgorithm: 'deep-hash' })`.
- **Middleware from global modules runs first**, regardless of position in the dependency
  graph. In v10 it was ordered by topological distance.
- **`Reflector.getAllAndOverride` still types as non-nullable.** The v11 migration guide
  claims it returns `T | undefined`; the shipped public overloads do not — only the
  implementation signature says so, and callers never see one. If you reach for it, guard
  for `undefined` by hand. (Not an issue for endpoint specs: `specOf` uses a plain
  `Reflect.getMetadata` and is typed `EndpointSpec | undefined` correctly.)
- **Filters resolve lowest-first** — route → controller → global — which is the opposite of
  guards and pipes. Interceptors run global → route inbound and route → global on the
  response. `ProblemFilter` is global, so anything route-scoped would catch first and it
  would never see the exception.
- **`IntrinsicException`** (new in v11, `@nestjs/common`) is what `BaseExceptionFilter`
  checks before logging an unknown error. `HttpException` extends it. Useful if you ever
  need to throw something the default filter must not log.
- `plainToClass` is deprecated in `ClassSerializerInterceptor`; use `plainToInstance`.
- `@Inject()` token types are narrowed in v11, so a token type v10 accepted may now fail to
  typecheck.
- Nothing breaking and nothing deprecated has landed anywhere in 11.1.x–11.2.x. If the pin
  is ever bumped, 11.2.1 carries a `multer` security fix chain, an adjacent-wildcard
  converter fix, and a run of SSE teardown fixes.
- Not dependencies here, so their v11 migrations are informational only: `@nestjs/config`
  (reading-order change), `@nestjs/cache-manager` (Keyv), `@nestjs/terminus`
  (`HealthIndicatorService`), `@nestjs/microservices`, `@nestjs/websockets`.
