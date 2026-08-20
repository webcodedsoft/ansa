# Next.js 16.3.1 — what differs, and where the docs say so

Companion to `nextjs-console-standards`. Extracted from the docs vendored at

```
apps/web/node_modules/next/dist/docs/
```

444 markdown files. Every path below is relative to that directory. **Those files are the
authority; this page is an index with the conclusions already drawn.** Where a claim here
disagrees with a vendored doc, the doc wins — except for the two known-stale pages listed
in the last section, where the upgrade guide wins.

---

## 0. The single most important fact about this repo

**`cacheComponents` is not enabled.** `apps/web/next.config.ts` sets only
`reactStrictMode`, `poweredByHeader` and `allowedDevOrigins`.

That splits every v16 change into two piles:

- **Applies today:** async request APIs, `proxy` vs `middleware`, `revalidateTag` arity,
  `error.tsx`'s `retry`, Turbopack, image defaults, ESLint/CLI, Node/TS floors, Server
  Action security.
- **Does not apply today:** `use cache`, `cacheLife`, `cacheTag`, `io()`, PPR, `prefetch`
  and `instant` route segment configs, the `generateMetadata` "explicit choice" rule, the
  client-hook Suspense requirements, `generateStaticParams` needing ≥1 param.

Enabling `cacheComponents` is explicitly **not a rename-only change**
(`01-app/02-guides/upgrading/version-16.md:1200-1244`) — it can surface build errors for
uncached data outside `<Suspense>` and requires adopting the whole model. It would also
**remove `dynamic`, `revalidate` and `fetchCache`**, which this app uses on fourteen page
files. Do not turn it on as a side effect of another change.

---

## 1. Async request APIs — sync access is *removed*, not deprecated

`version-16.md:281-293`:

> Version 15 introduced Async Request APIs as a breaking change, with **temporary**
> synchronous compatibility. Starting with **Next.js 16**, synchronous access is fully
> removed. These APIs can only be accessed asynchronously.
>
> - `cookies`
> - `headers`
> - `draftMode`
> - `params` in `layout.js`, `page.js`, `route.js`, `default.js`, `opengraph-image`,
>   `twitter-image`, `icon`, and `apple-icon`.
> - `searchParams` in `page.js`

`page.md:111-121`: "`searchParams` is a plain JavaScript object, not a `URLSearchParams`
instance."

New in v16 and easy to miss: the props passed to `opengraph-image`, `twitter-image`, `icon`
and `apple-icon` generators are now Promises, and `sitemap`'s `id` is a Promise
(`version-16.md:317-383`). `generateImageMetadata` still receives synchronous `params`.

### Generated route type helpers

`page.md:123-140`, `layout.md:91-110`, `route.md:105-121`, `05-config/02-typescript.md:102-108`.
`PageProps`, `LayoutProps` and `RouteContext` are **global, need no import**, and are
generated during `next dev`, `next build` or `next typegen`:

```tsx
export default async function Page(props: PageProps<'/blog/[slug]'>) {
  const { slug } = await props.params
  const query = await props.searchParams
}
```

**This repo hand-writes the prop types instead, and should keep doing so.** These helpers
live in `.next/types`, so depending on them reintroduces exactly the problem
`typedRoutes: false` was set to avoid: a `pnpm typecheck` that fails on a clean checkout
until something has been built.

---

## 2. `middleware.ts` is now `proxy.ts`

`03-file-conventions/middleware.md` is a 21-line stub marked `version: draft`:

> The `middleware.js` file convention has been **deprecated** in Next.js 16 and renamed to
> `proxy.js`. All functionality remains the same — only the file and export names have
> changed.

`version-16.md:612-658`:

> The `edge` runtime is **NOT** supported in `proxy`. The `proxy` runtime is `nodejs`, and
> it cannot be configured. … The named export `middleware` is also deprecated. Rename your
> function to `proxy`.

Config renames: `experimental.middlewarePrefetch` → `proxyPrefetch`,
`middlewareClientMaxBodySize` → `proxyClientMaxBodySize`,
`externalMiddlewareRewritesResolve` → `externalProxyRewritesResolve`,
`skipMiddlewareUrlNormalize` → `skipProxyUrlNormalize`. Codemod:
`npx @next/codemod@canary middleware-to-proxy .`

New type: `import type { NextProxy } from 'next/server'`.

**This app has neither file, and that is the right answer.** Two doc passages say why:

`01-getting-started/16-proxy.md:29`:
> Proxy is _not_ intended for slow data fetching. While Proxy can be helpful for optimistic
> checks … it should not be used as a full session management or authorization solution.

`proxy.md:217-219`:
> Server Functions are not separate routes in this chain. They are handled as POST requests
> to the route where they are used, so a Proxy matcher that excludes a path will also skip
> Server Function calls on that path. A matcher change or a refactor that moves a Server
> Function to a different route can silently remove Proxy coverage. **Always verify
> authentication and authorization inside each Server Function rather than relying on Proxy
> alone.**

That is this repo's model already: every action goes through the feature service, which
goes through `api()`, which carries the session token, and the API's `ApiGuard` is the real
boundary. If someone proposes a `proxy.ts` for auth, this paragraph is the answer.

---

## 3. Revalidation: `revalidateTag` changed arity; `updateTag` and `refresh` are new

This app currently imports **only `revalidatePath`** (four action files). The rest is here
because the alternatives are a better fit for two problems already recorded in `TASKS.md`.

### `revalidateTag(tag, profile)` — second argument now required

`version-16.md:440-454`:
> `revalidateTag` now requires a second argument specifying a `cacheLife` profile. The
> single-argument form is deprecated and will produce a TypeScript error.

`revalidateTag.md:23-25`: with `profile="max"` (recommended) the entry is marked stale
(stale-while-revalidate); without the second argument it expires immediately and the next
request is a blocking cache miss. `revalidateTag(tag, { expire: 0 })` for a webhook that
needs immediate expiry. Cannot be called in Client Components or Proxy.

### `updateTag` — Server Actions only, read-your-own-writes

`04-functions/updateTag.md:6-16`. `01-getting-started/09-revalidating.md:157-161`:

| | `updateTag` | `revalidateTag` |
|---|---|---|
| Where | Server Actions only | Server Actions and Route Handlers |
| Behaviour | immediately expires | stale-while-revalidate |
| Use case | read-your-own-writes | background refresh |

### `refresh` — refresh the client router from a Server Action

`04-functions/refresh.md:9-13`, `import { refresh } from 'next/cache'`. Server Actions
only. `07-mutating-data.md:421`: "The `refresh()` function does not revalidate tagged data."

### `revalidatePath` — unchanged signature, new caveats

`revalidatePath.md:25`: `revalidatePath(path, type?: 'page' | 'layout')`. Path max 1024
chars, case-sensitive; cannot be called in Client Components or Proxy. With rewrites, pass
the **destination** path, not the source (`:55-84`). And `:19`:

> Currently, it also causes all previously visited pages to refresh when navigated to
> again. This behavior is temporary…

That last line is the documented shape of the slowness `TASKS.md` records for
`revalidatePath("/agents", "layout")`. **Do not swap it out speculatively** — measure
first, and note that `refresh()` and `updateTag` change *what* is invalidated, not just
how fast it is.

`unstable_cache` is superseded by `use cache` (`unstable_cache.md:6-8`) and
`unstable_noStore` by `connection` — neither is used here. `unstable_rethrow` is still
`unstable_`.

---

## 4. Route segment config — most of it moved

`03-file-conventions/02-route-segment-config/` contains only seven files. The index table
lists **four** options: `dynamicParams`, `runtime` (edge deprecated), `preferredRegion`
(deprecated), `maxDuration`.

There is no `dynamic.md`, no `revalidate.md` and no `fetchCache.md` anywhere in the tree.
Version history, `index.md:19-21`:

> `v16.0.0` — `dynamic`, `dynamicParams`, `revalidate`, and `fetchCache` removed when
> **Cache Components** is enabled.
> `v16.0.0` — `export const experimental_ppr = true` removed.

`dynamic`, `revalidate` and `fetchCache` are now documented only in
`02-guides/caching-without-cache-components.md`, whose header says "This guide assumes you
are **not** using Cache Components".

**So the fourteen `export const dynamic = "force-dynamic"` lines and the one
`export const revalidate = 0` in this app are correct and supported — and they are the
thing that breaks first if `cacheComponents` is ever switched on.**

Two new segment configs exist but are Cache-Components-only: `prefetch`
(`'auto' | 'partial' | 'force-disabled'`) and `instant` (`true | false | { level }`).

---

## 5. `fetch` is not cached by default

`02-guides/caching-without-cache-components.md:11`:
> By default, `fetch` requests are not cached. You can cache individual requests by setting
> the `cache` option to `'force-cache'`.

`fetch.md:52-58` — the default is `auto no cache`: fetched every request in development,
once during `next build` when the route is statically prerendered, and every request when
request-time APIs are detected on the route. Caching is opt-in. Tag limits: 128 tags, 256
characters each. GET memoization still applies per render pass but **not in Route
Handlers**.

Route Handler `GET` has defaulted to dynamic since `v15.0.0-RC` (`route.md:668`).

---

## 6. Error handling — `error.tsx` takes `{ error, retry }`

`03-file-conventions/error.md:20-51`:

```tsx
'use client'
export default function Error({ error, retry }: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  return <button onClick={() => retry()}>Try again</button>
}
```

`error.md:117-121`: `retry()` re-fetches and re-renders the boundary's children.
`error.md:155-157`: `reset()` still exists but is demoted — "In most cases, you should use
`retry()` instead." `global-error.tsx` takes the same props.

Version rows (`error.md:327-335`): `v16.3.0 | retry prop became stable.` /
`v16.2.0 | unstable_retry prop added.`

**New: `catchError`** (`04-functions/catchError.md`), a programmatic component-level
boundary — `import { catchError, type ErrorInfo } from 'next/error'`, where
`ErrorInfo = { error, retry, reset }`. Stable at 16.3.0.

**`forbidden()` and `unauthorized()` are still experimental** — both file conventions carry
`version: experimental` and both functions require `experimental: { authInterrupts: true }`.
Nothing in 16.x graduated them. Under Cache Components the response has already begun
streaming as 200, so a real 403/401 status has to come from `proxy`.

`not-found.js` is unchanged; `global-not-found.js` is new and experimental
(`experimental.globalNotFound`), and must return a full HTML document.

**This app has no `error.tsx`, `global-error.tsx`, `not-found.tsx` or `loading.tsx`
anywhere.** An unhandled throw in a Server Component therefore has no boundary above it.
If you add one, use the `{ error, retry }` signature — not `{ error, reset }` from memory.

---

## 7. Parallel routes now require `default.js`

`version-16.md:931-951`:
> All parallel route slots now require explicit `default.js` files. Builds will fail
> without them. To maintain previous behavior, create a `default.js` file that calls
> `notFound()` or returns `null`.

This app has no parallel routes. `parallel-routes.md:70` also notes you cannot mix
prerendered and dynamic slots at one segment level.

---

## 8. `after()`, `connection()`, `io()`

- **`after` is stable** (since v15.1.0). Usable in Server Components, Server Functions,
  Route Handlers and Proxy. `after.md:40`: it is not a request-time API and does not make a
  route dynamic. **New hard rule** (`after.md:120,166`): a Server Component — including a
  page, layout or `generateMetadata` — **cannot** call `cookies()` or `headers()` inside the
  `after` callback; it throws at runtime. Read them before and close over the values. Route
  Handlers and Server Functions may still call them inside.
- **`connection` is stable** (since v15.0.0).
- **`io()` is new in 16.3.0** (`04-functions/io.md`), Cache-Components-oriented:
  `await io()` suspends during prerendering but resolves immediately during a request,
  inside cached scopes, in the browser, and in apps without Cache Components. `io.md:87`
  prefers it over `connection()` because `connection()` also blocks prefetches.

---

## 9. Server Actions — security model worth knowing

`02-guides/server-actions.md:78-85`:

> - **CSRF check.** The request's `Origin` is compared to the `Host` (or
>   `X-Forwarded-Host`)…
> - **Body size limit.** Action requests are capped at 1MB by default…
> - **Encrypted action IDs and dead code elimination.** Action references are encrypted at
>   build time, and unused Server Functions are stripped from client bundles so they have no
>   public endpoint.
> - **Closure variable encryption.** Variables captured by an inline action are encrypted
>   before being sent to the client. For multi-instance and self-hosted deployments, set
>   `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` to a stable key shared across instances.

`server-actions.md:174`:
> Each Server Action is identified by the action ID that is part of its build artifacts.
> New deployments typically generate new IDs (Next.js rotates them at most every 14 days,
> even when the source is unchanged), so a client still running the previous build may
> invoke an action ID that no longer exists.

`data-security.md:538`: the key must be base64 whose decoded length is a valid AES size
(16, 24 or 32 bytes).

**Two operational consequences for Ansa.** More than one instance behind a load balancer
without `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` breaks encrypted closures across instances.
And a long-lived console tab across a deploy will hit a missing action ID — the 1MB body
cap matters too, for the knowledge-source upload path.

`server-actions.md:28`:
> Next.js dispatches Server Actions one at a time per client. … do not rely on
> `Promise.all` to parallelize Server Actions from the client.

`server-actions.md:43-48`: a re-render ships in the same response when the action calls
`updateTag`, `revalidatePath`, `refresh`, mutates cookies, or calls `redirect`.
`revalidateTag` with a SWR profile is the exception and does *not* trigger it.

`useActionState` itself is unchanged: `const [state, formAction, pending] =
useActionState(action, initialState)`, and the action's first parameter is the previous
state (`02-guides/forms.md:226-249`). `useFormState` was replaced by it back in 15.

---

## 10. `generateMetadata`

Shape unchanged, but `params`/`searchParams` are Promises. Server Components only
(`generate-metadata.md:110,116`). No v16 version row — its table stops at v15.2.0.

Everything in the "With Cache Components" section (`:1254-1316`) — the explicit-choice
error, the `'use cache'` fix, the `DynamicMarker` pattern — does not apply here.

Still deprecated since 14: `themeColor`, `colorScheme` and `viewport` inside `metadata`;
use `generateViewport`.

---

## 11. Turbopack, CLI, ESLint, TypeScript, images, `<Link>`

- **Turbopack is the default bundler** for both `next dev` and `next build`
  (`08-turbopack.md:39`). `--turbopack` is no longer needed; this repo's scripts are already
  clean. **A project with a custom webpack config now fails the build** unless you pass
  `--turbopack` (ignore it), migrate it, or `--webpack` (opt out). Filesystem caching is on
  by default for dev (16.1) and build (16.3); dev output moved to `.next/dev`, so `next dev`
  and `next build` can run concurrently and a lockfile prevents two of either.
- **`next lint` is gone**, and so is the `eslint` key in `next.config`. ESLint flat config
  is the default; the new import style is
  `import nextVitals from 'eslint-config-next/core-web-vitals'`. This repo already runs
  `eslint .` with a flat config, so nothing to do.
- **`next typegen` exists** (15.5.0) and generates route types *and* `next-env.d.ts`;
  `next typegen && tsc --noEmit` is the documented CI pattern. Also new: `next upgrade`
  (16.1) and `next experimental-analyze` (16.1).
- **`next-env.d.ts` should now be gitignored** (`05-config/02-typescript.md:112-121`: "Add
  it to `.gitignore`. If your project already tracks the file, remove it from Git."). The 14
  and 15 docs said to commit it. **This repo still tracks `apps/web/next-env.d.ts`** — a
  real, small divergence from current guidance.
- **Floors:** Node 20.9+, TypeScript 5.1+, Chrome/Edge/Firefox 111+, Safari 16.4+. This
  repo requires Node 22 and pins TS 5.9.3.
- **`next/image`:** `priority` is **deprecated** in favour of `preload`, and
  `image.md:289` says most cases want `loading="eager"` or `fetchPriority="high"` instead.
  Defaults changed: `qualities` → `[75]`, `minimumCacheTTL` 60s → 14400s, `imageSizes` drops
  `16`, `maximumRedirects` → 3, `dangerouslyAllowLocalIP` → false. `images.domains` and
  `next/legacy/image` are deprecated. **This app imports no `next/image` at all** (icons are
  `lucide-react`), so none of it bites today.
- **`<Link>`:** `legacyBehavior` **does not exist in the v16 docs** — one hit in the whole
  tree, in the Pages Router v13 upgrade guide. The App Router prop table is `href`,
  `replace`, `scroll`, `prefetch`, `onNavigate`, `transitionTypes`. `useLinkStatus` from
  `next/link` gives `{ pending }`.
- **Scroll:** Next no longer overrides `scroll-behavior: smooth` during navigation
  (`version-16.md:961-983`); opt back in with `<html data-scroll-behavior="smooth">`.
- **Removed entirely:** AMP (`next/amp`, `useAmp`), `serverRuntimeConfig` /
  `publicRuntimeConfig`, `devIndicators.appIsrStatus`/`.buildActivity`/`.buildActivityPosition`,
  `experimental.dynamicIO`, `experimental.useCache`, `unstable_rootParams` (→
  `next/root-params`, new in 16.3.0).
- **Promoted out of `experimental`:** `cacheComponents`, `turbopack`, `typedRoutes`,
  `reactCompiler`, `adapterPath`, `cacheHandlers`, `cacheLife`, `partialPrefetching`.
- **Still `experimental`:** `authInterrupts`, `staleTimes`, `useOffline`, `globalNotFound`,
  `typedEnv`, `prefetchInlining`, `instantInsights`, `useTypeScriptCli`.
- **`agentRules: false`** in `next.config` stops `next dev` auto-writing `AGENTS.md` /
  `CLAUDE.md` (`02-guides/ai-agents.md:85-95`). Do not set it — `apps/web/AGENTS.md` is the
  warning that sends the next agent to these docs, and the block re-creates itself anyway.

React 19.2 is in play: View Transitions, `useEffectEvent`, and `<Activity>` (which backs
Cache Components' state preservation) — `version-16.md:385-393`.

---

## 12. Two vendored docs are stale — do not copy from them

1. **`cookies.md:68`, `headers.md:46`, `page.md:65`, `layout.md:89`, `default.md:65`,
   `dynamic-routes.md:149`** all still carry the Next-15 sentence "you can still access it
   synchronously in Next.js 15, but this behavior will be deprecated in the future", and
   their version tables stop at `v15.0.0-RC`. **`version-16.md:285` overrides them:
   synchronous access is fully removed.**
2. **`parallel-routes.md:92,101`** still says a missing `default.js` renders a 404.
   **`default.md:26` and `version-16.md:933` say the build fails** for named slots.

Also stale: `06-cli/next.md:105` still carries a `--no-lint` blurb saying linting "will be
removed from `next build` in Next 16" — it already has been.

When a per-API page and the upgrade guide disagree, **the upgrade guide is authoritative.**

---

## 13. Codemods available (16.x)

From `02-guides/upgrading/codemods.md`:

| Codemod | Effect |
|---|---|
| `pnpm dlx @next/codemod@canary upgrade latest` | umbrella; also `pnpm next upgrade` on 16.1+ |
| `middleware-to-proxy` | file, export and five config-key renames |
| `remove-unstable-prefix` | `unstable_cacheTag` → `cacheTag`, etc. |
| `remove-experimental-ppr` | removes `export const experimental_ppr = true` |
| `next-lint-to-eslint-cli` | creates `eslint.config.mjs`, rewrites scripts |
| `next-async-request-api` | only if sync `params`/`cookies()`/etc. remain |
| `next-experimental-turbo-to-turbopack` | `experimental.turbo` → `turbopack` |
| `cache-components-instant-false`, `remove-partial-prefetch` | 16.3, Cache Components only |
| `agents-md` | (re)creates the `AGENTS.md` managed block |

`codemods.md:65`: the upgrade codemod runs **non-interactively when stdin is not a TTY** —
that is, when an agent runs it. Do not run any of these without being asked; this repo is
already on 16.3.1 and none of them have work to do.
