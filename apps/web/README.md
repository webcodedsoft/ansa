# @ansa/web

The tenant-facing dashboard. Configure the agent, place a test call, read what happened.

It exists to close the testing loop. Before it, every call was tested by someone dialling a
number while somebody else read server logs and interpreted them. This lets one person change
a setting, press a button, answer their phone, and then read the call turn by turn — including
what the transcriber heard and what it should have heard.

## Running it

```bash
pnpm --filter @ansa/api start:dev        # the API, on :3000
ANSA_API_URL=http://127.0.0.1:3000 pnpm --filter @ansa/web dev   # this, on :3100
```

`ANSA_API_URL` is the only variable, and it is read per request rather than at build time, so
one build runs against a local API and a deployed one.

## Getting in

Two doors, answering different situations:

- **`/sign-up`** — starting an organisation. Creates the tenant and the account that owns it,
  and signs you straight in. An address that already has an account can create a second
  organisation using the password it already has.
- **`/accept-invitation?token=…`** — joining one that exists. The only other way a person
  comes into existence.

There is no third way, and that is structural rather than a policy: `ansa_app` has no INSERT
on `users` at all, and `tenants` sits behind an RLS policy keyed to the current tenant. Both
doors go through a `SECURITY DEFINER` function — `app.create_organisation` and
`app.accept_invitation` — and nothing else can reach those tables.

A wrong password on `/sign-up` for an address that exists is refused with the **same** 401
as a failed sign-in, deliberately. A friendlier message would confirm the address is
registered, which is exactly what `POST /auth/organisations` spends a full scrypt on a
missing account to avoid revealing.

Operators onboarding an organisation by hand still use `tools/tenant/provision.mjs` and
`tools/tenant/owner.mjs`; the latter prints an invitation token, and the link to redeem it is
`/accept-invitation?token=<token>`.

## Why every request is server-side

The API enables no CORS, so a browser cannot reach it at all. That settles the architecture
rather than leaving it to preference:

- the session token lives in an **httpOnly cookie**, so no script on the page can read it
- Server Components read data; Server Actions write it
- there is no `NEXT_PUBLIC_` variable, no `fetch` in a client component, and no route handler
  that exists only to relay a request

If a screen needs data, the page loads it. If a button changes something, an action does it.

## Layout

```
src/
├── app/                    routes only — each page reads a service and renders components
├── features/
│   ├── auth/               auth.schema.ts · auth.service.ts · auth.actions.ts · components/
│   ├── agent/              agent.schema.ts · agent.service.ts · agent.actions.ts · components/
│   └── calls/              calls.schema.ts · calls.service.ts · calls.actions.ts · components/
├── components/ui/          the shared kit: button, card, form, feedback
├── stores/                 zustand — toasts
└── lib/                    api client, formatting, form state, patterns
```

Each feature owns three files and a component folder, and they mean different things:

| file | responsibility |
|---|---|
| `*.schema.ts` | what a submission must look like, in zod, and the API body it becomes |
| `*.service.ts` | the only place that feature talks to the API |
| `*.actions.ts` | Server Actions: parse with the schema, call the service, report |

Pages and actions both go through the service. Nothing outside a feature's service constructs
an API client for that feature, which is what makes an endpoint rename a one-file change.

## The API client is generated

`src/lib/api/generated.ts` comes from `apps/api/openapi.json` and is **not written by hand**:

```bash
pnpm --filter @ansa/web generate
```

Run it after changing any API route. It is committed, because `next build` typechecks it — an
uncommitted client makes a clean checkout unbuildable — and because a contract change then
shows up in the same diff as the controller that caused it.

Two defects were found in the generator the first time anything consumed its output: it
emitted `test-calls:` as an object key, which is not valid TypeScript, and it typed path
parameters as `string` when the configuration version endpoints take an integer. The client
had never compiled. The frontend building is now the check that it does.

## Validation belongs to the API

The zod schemas here catch the two or three mistakes worth catching without a round trip and
attach them to the field that caused them. They are not a second copy of the API's rules and
must not become one — the API enforces password length, address format, tenancy and the
consent gate, and it is the only side that can.

The consent gate in particular: a refused test call renders as a warning, not an error,
because it is the system working. There is no setting here that skips it and there will not
be one.

## Publishing is a whole document

`POST /config/versions` rewrites the configuration and snapshots the result. It is not a
patch. A body missing a field does not leave that field alone — it clears it, and the version
history then records the loss as deliberate. That is why business hours and escalation are on
the agent form even though the testing loop does not need them: a form that could not see
them would silently delete them.

## No unit tests here on purpose

The check that matters is that this app compiles against the generated client and then places
a real call. `pnpm typecheck` and `pnpm build` are the gates; a phone ringing is the proof.
