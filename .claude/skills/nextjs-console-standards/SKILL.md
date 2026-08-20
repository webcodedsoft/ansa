---
name: nextjs-console-standards
description: How to write frontend code in apps/web — the server-only architecture, the feature folder trinity, Server Actions and FormState, forms that span tabs, and the uncontrolled-input reset rule. Use when adding or changing a page, layout, Server Action, form, or React component under apps/web/src, or when a console screen shows stale data or a button does nothing.
---

# Next.js in Ansa

`apps/web` is the organisation-facing console. **Next.js 16.3.1**, React 19.2, App Router,
Tailwind 4, zod 4, zustand 5, TypeScript strict. Port 3100.

Read `ansa-harness` first if you have not. Read `apps/web/README.md` too — it is short and
it argues the architecture.

> **This is not the Next.js you remember.** `apps/web/AGENTS.md` carries a warning written
> by `next dev` itself: this version has breaking changes versus most training data. Real
> docs are vendored at `apps/web/node_modules/next/dist/docs/` and are **authoritative for
> this repo**. Read the relevant guide there before writing code. See §11 for what actually
> differs.

---

## 1. Everything is server-side. This is structural, not a preference.

**The API enables no CORS, so a browser cannot reach it at all.** That settles the
architecture rather than leaving it to taste:

- The session token lives in an **httpOnly cookie** (`ansa_session`), so no script on the
  page can read it.
- **Server Components read** data. **Server Actions write** it.
- There is **no `NEXT_PUBLIC_` variable**, **no `fetch` in a client component**, and **no
  route handler that exists only to relay a request**.

If a screen needs data, the page loads it. If a button changes something, an action does
it. The only environment variable is `ANSA_API_URL`, read *per request* inside `baseUrl()`
rather than captured at module load, so one build runs against a local API and a deployed
one.

The alternative — a public proxy forwarding a token from JavaScript — would put the session
where any script on the page can read it. Do not build one.

### `lib/api/server.ts` is the only place this app talks to the API

```ts
api()            // client for the signed-in caller; redirect("/sign-in") if no cookie
anonymousApi()   // no session, for the two endpoints that work without one
apiIfSignedIn()  // client or null — for sign-out, the one caller that must not redirect
withSession(fn)  // run fn; a 401 inside it means redirect("/sign-in"), not a stack trace
startSession(token, expiresAt) / clearSession()
failureMessage(error, { within? })  // an RFC 9457 problem, in words a person can act on
refusedWith(error, status)          // true when the API refused for this specific reason
```

`api()` only redirects when the cookie is **missing**. A cookie that is present and no
longer valid sails past that check and 401s inside the page, which Next renders as a crash
— hence `withSession`, used in the workspace layout. The stale cookie is deliberately not
cleared there: a Server Component cannot set cookies during render, and signing in
overwrites it anyway.

`startSession` mirrors the API's own `expiresAt` rather than inventing a duration, so the
cookie and the session row expire together. A cookie that outlives its session produces a
signed-in-looking app that 401s on every request.

---

## 2. The feature folder trinity

```
src/
├── app/                  routes only — each page reads a service and renders components
├── features/<name>/
│   ├── <name>.schema.ts    what a submission must look like, in zod, and the API body it becomes
│   ├── <name>.service.ts   the ONLY place that feature talks to the API
│   ├── <name>.actions.ts   Server Actions: parse with the schema, call the service, report
│   └── components/         the feature's own components
├── components/ui/        the shared kit — one import path: `@/components/ui`
├── stores/               zustand — toasts
└── lib/                  api client, formatting, form state, patterns, paging
```

**Pages and actions both go through the service.** Nothing outside a feature's service
constructs an API client for that feature — that is what makes an endpoint rename a
one-file change.

**Validation belongs to the API.** The zod schemas here catch the two or three mistakes
worth catching without a round trip and attach them to the field that caused them. They are
**not a second copy of the API's rules and must not become one** — the API enforces
password length, address format, tenancy and the consent gate, and it is the only side that
can. A refused test call renders as a *warning*, not an error, because it is the system
working. There is no setting that skips the consent gate and there will not be one.

`components/ui/index.ts` is a barrel, and it is safe as one because nothing in that folder
has a side effect at module load. `tabs`, `stepper` and `modal` are the client modules;
importing them from a Server Component is fine, rendering them there is not, and React
enforces that itself.

---

## 3. Server Actions and `FormState`

Every action in this app returns the same shape (`lib/form-state.ts`):

```ts
type FormStatus = "idle" | "invalid" | "failed" | "succeeded";

interface FormState<TData = null> {
  status: FormStatus;
  message: string | null;                     // about the whole submission
  fieldErrors: Readonly<Record<string, string>>;
  data: TData | null;
}

idleForm<T>()                       // the initial state — declare it as a module const
invalidForm(zodError, message?)     // did not satisfy the schema; nothing was sent
failedForm(message)                 // sent, and the API said no
succeededForm(data, message?)
```

`status` is a discriminant rather than a pair of nullable fields, because `error !== null`
and `data !== null` can both be false at once, which leaves a form unable to tell "not
submitted yet" from "submitted and the API returned nothing".

`fieldErrorsOf` keeps the **first** complaint per field. Zod reports every failing rule, and
a field that is both too short and wrongly formatted does not get clearer by saying so
twice.

### The shape of an action

```ts
"use server";

export type SaveDraftState = FormState<Saved>;

export const saveDraftAction = async (
  _previous: SaveDraftState,
  form: FormData,
): Promise<SaveDraftState> => {
  const parsed = draftSchema.safeParse(publishFormInput(form));
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const result = await saveDraft(parsed.data);
    revalidatePath("/agents", "layout");
    return succeededForm({ updatedAt: result.updatedAt });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};
```

**`redirect()` throws internally.** Keep it outside every `try`, or a successful sign-in
becomes "the request failed".

`failureMessage` takes `{ within }` for a form editing one item of a collection the API
validates whole: `{ within: "http.1" }` turns *"Http #2 name is required"* into *"Name is
required"*. A path that does not match keeps its index, which is exactly when somebody
needs to be told which one.

### Toasts exist because of `revalidatePath`

When a publish succeeds the action revalidates, the server re-renders the form with the new
data, and **the success message rendered from action state goes with it** — the work landed
and the screen said nothing. `stores/toast.store.ts` lives outside the tree being replaced.

```ts
useFormToast(state, (data) => `Published version ${data.version}.`);
```

The hook guards on the *previous* status. `useActionState` keeps the last result in state,
so an effect watching only the current value fires again on every unrelated re-render and
the same toast stacks three deep. Failures deliberately do not go through here — an error
belongs next to the field that caused it, where it stays put and can be re-read.

Known cost, recorded in `TASKS.md`: `revalidatePath("/agents", "layout")` re-runs every
fetch the agent page makes, so Save and Discard take several seconds to show. Correct, but
slow enough to look broken; the toast is the only immediate feedback.

---

## 4. Forms: nested `<form>` is invalid HTML

The agent workspace is one `<form id="agent-publish">` spanning **nine tabs**. Panels
inside it that need to act — Overview, Versions, Test call — **must not** contain a
`<form>`, because nesting one is invalid HTML and the browser silently reparents it.

Two techniques, both in use:

### a. Dispatch the Server Action directly

```tsx
const [state, dispatch, pending] = useActionState(rollback, START);

const restore = (version: number) => {
  const form = new FormData();
  form.set("version", String(version));
  dispatch(form);            // no <form> element involved
};
```

### b. Bind to the outer form by id with `form=`

A field or button anywhere on the page can belong to a form it is not inside:

```tsx
<SubmitButton form={PUBLISH_FORM} idle="Save changes" busy="Saving…" pending={saving} />
<TextAreaField name="note" form={PUBLISH_FORM} … />          // inside a <Modal> overlay
<SubmitButton form={PUBLISH_FORM} formAction={action} idle="Publish" />
```

`formAction` on a submit button overrides the form's own `action`. That is how one form
carries two verbs: **its `action` is Save — the harmless one — because pressing return in
any text field submits through the default action.** Publish is reachable only from inside
the dialog.

### Native `required` is banned, and this is the reason

`FieldShell.required` marks the field and sets `aria-required`; it deliberately does **not**
set the native attribute. Chrome will not submit a form holding an invalid control it
cannot focus, and `Tabs` hides panels with `hidden` rather than unmounting them — so an
empty required field on a tab nobody is looking at made the button **do nothing at all**:
no bubble, no error, no save. The server validates every field anyway and returns a message
per field.

Because a rejected field can land on a hidden tab, `TabDef.problem` marks the tab with a
dot (with `role="img"` and `aria-label`, since colour alone would be the whole signal), and
the form-level notice names the tabs: *"On Voice and Routing & hours."*

---

## 5. Uncontrolled inputs need a `key` to reset

Nearly every field in this app is uncontrolled, reading `defaultValue`. **React does not
reset those on re-render.** Discard removed the draft, refreshed the page, and left the
discarded text sitting in the boxes.

The fix is a key that remounts the panel — but *which* key is the whole lesson:

```tsx
const shownAs = (value: unknown): string => JSON.stringify(value) ?? "none";

<ConversationTab  key={shownAs(config)} … />
<DataCapturedTab  key={shownAs(staged.capturedFields)} … />
<ToolsTab         key={shownAs(staged.enabledTools)} … />
```

- **Key each panel on its own content, not on a shared timestamp.** One key on the whole
  form taken from the draft's `updated_at` meant flipping a behaviour switch on the
  Conversation tab remounted Voice and Routing too, throwing away anything typed there.
- **Key on the value, not a timestamp.** Saving text the server stores unchanged then
  leaves the key alone, so an ordinary save no longer remounts anything.

### Local state that must follow the server: adjust during render

A remount key cannot fix state that is *deliberately* not keyed. The behaviour switches are
optimistic local state seeded once by `useState`, so discarding a draft removed the staged
flag, the page refreshed with the live value, and the switch carried on showing the flip
that had just been thrown away.

```tsx
const [bargeIn, setBargeIn] = useState(agent.bargeIn);
const [seeded, setSeeded] = useState({ bargeIn: agent.bargeIn, amd: agent.answeringMachineDetection });

if (seeded.bargeIn !== agent.bargeIn || seeded.amd !== agent.answeringMachineDetection) {
  setSeeded({ bargeIn: agent.bargeIn, amd: agent.answeringMachineDetection });
  setBargeIn(agent.bargeIn);
  setAmd(agent.answeringMachineDetection);
}
```

**During render, not in an effect.** This is React's documented way to reset state when a
prop changes. An effect paints the stale value first, and the answer can arrive after
somebody has flipped the switch again.

Optimistic writes revert on failure:

```tsx
const flip = (change, revert) => {
  startSaving(async () => {
    const result = await setAgentBehaviour(agent.agentId, change);
    if (!result.ok) { revert(); setFailure(result.message); }
  });
};
```

---

## 6. Pages

```tsx
export const metadata: Metadata = { title: "Calls · Ansa" };
export const dynamic = "force-dynamic";

type CallsSearch = { readonly page?: string; readonly perPage?: string; readonly endReason?: string };

const CallsPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<CallsSearch>;
}) => {
  const search = await searchParams;
  …
};

export default CallsPage;
```

**`params` and `searchParams` are Promises and must be awaited.** So is `cookies()`.

**Declare the searchParams shape as a `type` alias, not an `interface`.** TypeScript gives
a type alias an implicit index signature and an interface none, so only the alias can be
handed to `Pagination`'s `params`. A cast would silence the error without making it true.

Other page conventions:

- **URL is the state.** Page numbers and filters live in the query string, so a filtered
  view is a link somebody can send, the back button behaves, and paging cannot lose the
  filters. `lib/paging.ts` reads it once for every list, clamping `perPage` to the sizes the
  selector actually offers.
- **`Promise.allSettled` for anything decorative.** The workspace layout fetches four
  sidebar counts that way — a count is decoration and a failing one must never take the
  shell down. Only numbers the API genuinely returns are shown; Calls carries no badge
  because there is no total-calls endpoint, rather than a made-up one.
- Fetch in parallel with `Promise.all` when the page needs all of it, and re-throw a
  rejection you cannot render around: `if (calls.status === "rejected") throw calls.reason;`
- **`lib/paging.ts` lives outside the `Pagination` component on purpose**: Server
  Components read it, and *every export of a `"use client"` module becomes a client
  reference when the server imports it*.
- Same reason `lib/api/problem-text.ts` is separate from `server.ts` — `server.ts` reaches
  for `next/headers` at import time and cannot be loaded in a test.
- There is no live-data endpoint. "Live" is `AutoRefresh`, a client component that calls
  `router.refresh()` on an interval — re-runs the Server Component in place, no navigation,
  no lost scroll, no flash of empty page.

---

## 7. The generated API client

`src/lib/api/generated.ts` is written by `apps/api`'s emitter and is **not edited by hand**:

```bash
pnpm --filter @ansa/web generate
```

Run it after changing any API route. It is committed, because `next build` typechecks it —
an uncommitted client makes a clean checkout unbuildable — and because a contract change
then shows up in the same diff as the controller that caused it. ESLint ignores it;
findings in it are findings about the generator.

Every method throws `AnsaApiError` carrying the RFC 9457 problem document. Derive types
from the client rather than restating them:

```ts
export type AgentSummary = Awaited<ReturnType<typeof listAgents>>["items"][number];
export type LiveConfiguration = Awaited<ReturnType<typeof currentConfiguration>>;
```

**Publishing is a whole document.** `POST /config/versions` rewrites and snapshots; it is
not a patch. A body missing a field does not leave that field alone — it **clears** it, and
the version history records the loss as deliberate. That is why business hours and
escalation sit on the agent form even though the testing loop does not need them: a form
that could not see them would silently delete them.

---

## 8. Style rules that bite

- **`func-style: ["error", "expression"]` applies to components.** `const Page = () => …`,
  never `function Page()`. React does not care and the codebase reads the same top to
  bottom. **Class methods are exempt** — irrelevant here, since nothing in this app is a
  class.
- Expressions do not hoist: helpers appear above first use.
- `export default` at the bottom of a page/layout file, after the `const`.
- `no-console` is an error. `@typescript-eslint/no-explicit-any` is an error.
- `noUncheckedIndexedAccess` is on. `versions[1]?.responseLatencyP50Ms ?? null`.
- Props are `readonly`, spelled inline or as a named interface.
- `noVendorSdks` applies here too: this app talks to Ansa's own API and has no business
  importing a telephony or model SDK.
- Tailwind 4 with CSS custom properties for the palette — `text-[var(--ink-3)]`,
  `border-[var(--hairline)]`. `cn()` from `@/lib/cn` (clsx + tailwind-merge) for
  conditionals.
- `@/*` maps to `./src/*`.
- **No unit tests here on purpose.** `pnpm typecheck` and `pnpm build` are the gates; a
  phone ringing is the proof. (Two `.test.ts` files exist for pure helpers — schemas and
  `problem-text` — and that is the whole exception.)

---

## 9. Failure modes, and how they present

| Symptom | Cause |
|---|---|
| Page renders but **nothing is clickable** — no theme toggle, no tabs, no actions | You opened `127.0.0.1:3100` instead of `localhost:3100` (or vice versa) and Next refused to serve `/_next/static/**` to an unrecognised host. Pages are server-rendered so it looks like a working app. `allowedDevOrigins` in `next.config.ts` lists both; the only other clue is one terminal warning. |
| Submit button does nothing, no error, no bubble | A native `required` on a control inside a `hidden` tab panel. Use `FieldShell.required`, which does not set the attribute. |
| Discarded text still in the boxes after a refresh | Uncontrolled input with no remount `key`. See §5. |
| Typing on one tab is lost when a switch on another is flipped | The panel key is shared (a timestamp) instead of per-panel content. |
| A toggle keeps showing a value that was discarded | `useState` seeded once. Adjust during render, not in an effect. |
| The same toast three times | `useFormToast` bypassed, or an effect watching current status without guarding the previous one. |
| Everything bounces to `/sign-in` | Expired cookie hitting `withSession`. Correct behaviour. |
| A page 500s with a stack trace instead of redirecting | An API call outside `withSession` that 401'd. |
| "The request failed" after a successful sign-in | `redirect()` inside a `try` — it throws by design. |
| Validation error reads `body.http.1.name must be at least 1 characters` | You are on an older path; `failureMessage` + `problem-text.ts` render these. Pass `{ within }` when the API validates a whole collection. |
| `next build` fails inside `generated.ts` | An API route changed and the client was not regenerated. |
| `pnpm typecheck` fails on a clean checkout | Should not — `typedRoutes` is deliberately **off** because it writes its route union into `.next/types` during a build, and a typecheck that depends on a build is a typecheck that gets skipped. |
| Server Component tries to set a cookie | Not allowed. Move it to a Server Action or route handler. |

---

## 10. Things that are not what you would guess

- **`Tabs` hides panels with `hidden` rather than unmounting them**, deliberately, so a
  half-filled form survives a tab switch and one `<form>` can span all nine. Every
  consequence in §4 and §5 follows from that one decision.
- **The workspace form's default action is Save, not Publish.** Return in a text field
  submits the default action, so the default has to be the harmless one.
- **A `SaveBar` sits on every tab with fields, and saves everything on every tab.** There
  is one endpoint and one document, so there is no such thing as saving the voice without
  the greeting. Three buttons each claiming to save their own section was a real defect that
  published every tab live under a label saying Save.
- **Save writes a draft; Publish makes it live; Discard throws unpublished work away.** No
  screen in this app may make something live except Publish. Restore loads an old version
  *into the draft* and says so — it used to publish outright, which made the version list a
  second way to change what a caller hears.
- **The sign-in form is deliberately not helpful about which half was wrong.** "Those
  details did not match an account" whether the address is unknown or the password is
  wrong, because the API answers both the same way, in the same time, and a friendlier form
  would undo that and become an account-existence oracle.
- **The picker for choosing an organisation appears only when the choice is real** — the
  API splits sign-in into two calls, but most people belong to one organisation and asking
  them to pick from a list of one serves the API's shape rather than theirs.
- **`useActionState` returns `[state, dispatch, pending]`** and `dispatch` is callable
  directly with a `FormData` — that is what makes §4a work.
- **The root route is a redirect to `/calls`**, not a dashboard. The loop this app serves is
  configure, call, read.
- **The generated client had never compiled** the first time anything consumed it — it
  emitted `test-calls:` as an object key and typed integer path parameters as `string`. The
  frontend building is now the check that it does.

---

## 11. Next.js 16.3.1 — what differs from older training data

**Before writing code that is not already patterned somewhere in `src/`, read the relevant
guide under `apps/web/node_modules/next/dist/docs/`.** That directory is the authority for
this repo. The conclusions, with doc paths and line numbers, are in the companion file:
**[`nextjs-16-reference.md`](nextjs-16-reference.md)**.

The short version.

**`cacheComponents` is not enabled here.** That splits v16 in two. Async request APIs,
`proxy` vs `middleware`, `revalidateTag`'s new arity, `error.tsx`'s `retry`, Turbopack,
image defaults, ESLint/CLI and the Server Action security model **all apply**. `use cache`,
`cacheLife`, `cacheTag`, `io()`, PPR, the `prefetch`/`instant` segment configs and the
`generateMetadata` explicit-choice rule **do not**. Enabling it is not a rename-only change
and it would remove the `dynamic` and `revalidate` exports this app uses on fourteen pages —
never turn it on as a side effect of something else.

Confirmed by this repo's own source, which is on 16.3.1 and builds:

| Behaviour | In this repo |
|---|---|
| `cookies()` | **async** — `(await cookies()).get(SESSION_COOKIE)` |
| `params` / `searchParams` | **Promises** — `await params`, `await searchParams` |
| Setting a cookie during render | forbidden; Server Action or route handler only |
| `revalidatePath` | `revalidatePath("/agents", "layout")` — the second argument scopes it |
| Route segment config | `export const dynamic = "force-dynamic"` on fourteen pages, `revalidate = 0` on `/live` |
| `typedRoutes` | available, deliberately disabled (see §9) |
| `allowedDevOrigins` | a `next.config.ts` option; dev-only |
| `useActionState` | from `react`; `[state, dispatch, pending]`, action takes previous state first |
| Bundler | Turbopack by default; no `--turbopack` flag needed, and none is present |
| Config file | `next.config.ts`, typed as `NextConfig` |

Five things that would be wrong from memory:

1. **Synchronous `cookies()` / `params` is fully removed in 16, not merely deprecated** —
   and several vendored per-API pages still carry the stale Next-15 "still works" sentence.
   `version-16.md:285` overrides them.
2. **`middleware.ts` is now `proxy.ts`**, Node runtime only, and it is explicitly *not* an
   auth boundary — a Server Function is a POST to the route it lives on, so a matcher change
   can silently drop coverage. This app has neither file, and verifying auth inside the
   action (via the API's guard) is the documented right answer.
3. **`revalidateTag(tag)` now needs a second `cacheLife` argument**; the one-argument form
   is deprecated and errors in TypeScript. Only `revalidatePath` is used here. `updateTag`
   (Server Actions only, read-your-own-writes) and `refresh` (refresh the client router from
   an action) are new and are plausible answers to the slow-`revalidatePath` note in
   `TASKS.md` — measure before swapping, they change *what* is invalidated.
4. **`error.tsx` takes `{ error, retry }`**, not `{ error, reset }`. `retry` went stable in
   16.3.0; `reset` still exists but is demoted. There is no `error.tsx`, `not-found.tsx` or
   `loading.tsx` anywhere in this app, so an unhandled throw in a Server Component has no
   boundary above it. `forbidden()` / `unauthorized()` are **still experimental** and need
   `experimental.authInterrupts`.
5. **Server Actions are dispatched one at a time per client** — do not `Promise.all` them
   from the browser — the body cap is 1MB, action IDs rotate at most every 14 days so a tab
   left open across a deploy will call a missing one, and any multi-instance deployment needs
   a shared `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` or encrypted closures break across
   instances.

Also worth knowing: `fetch` is **not** cached by default; `after()` is stable but a Server
Component may not call `cookies()`/`headers()` inside its callback; `<Link>`'s
`legacyBehavior` no longer exists in the docs at all; `next lint` is gone; and
`next-env.d.ts` is now supposed to be gitignored, which this repo has not yet done.
