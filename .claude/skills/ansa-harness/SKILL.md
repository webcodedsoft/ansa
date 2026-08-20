---
name: ansa-harness
description: How work actually gets done in the Ansa monorepo — reading order, the five overriding rules, the two latency loops, the pre-commit gate, migrations, and which provider skill to reach for. Use at the start of any Ansa task, before planning or writing code, and whenever choosing between a design that awaits something and one that does not.
---

# The Ansa harness

This is the orientation skill. Read it before planning. The framework skills
(`nestjs-api-standards`, `nextjs-console-standards`) and the provider skills tell you *how*
to write a particular thing; this tells you what the repo is, what it will not let you do,
and what has to be true before you stop.

---

## 1. Reading order, every session

1. **`TASKS.md`** — the current slice, what is checked, what is next, and a long
   dated log of defects and what they taught. It is ~186KB; read the head (the
   "Open at the end of …" section) and grep it for whatever you are about to touch.
2. **`CLAUDE.md`** — conventions and the five non-negotiables. Reproduced below in
   summary, but read the original; it argues its cases and the arguments matter.
3. **`PRD.md`** — requirement detail. `TASKS.md` cites R-numbers into it.
4. **`docs/STACK_DECISION.md`** — why the providers are what they are.

Directory-local files outrank all of these for the directory they sit in:
`apps/web/AGENTS.md`, `apps/web/README.md`, `apps/api/src/*/WIRING.md`,
`docs/ONBOARDING_RUNBOOK.md`, `docs/ORGANIZATION_CONFIGURATION.md`.

**Update `TASKS.md` before you stop.** Check boxes, and write down what broke. The dated
sections in it are the repo's institutional memory and they are the reason most of the
guards in this document exist.

---

## 2. The five rules that override everything

Verbatim-in-substance from `CLAUDE.md`. Each is enforced by something, not by memory.

**0. The product is TypeScript. `eval/` is Python and is not the product.**
`apps/` and `packages/` are NestJS/TypeScript. `eval/` is standalone measurement tooling,
run by hand, standard library only, zero dependencies. It never imports from the monorepo
and the monorepo never imports from it. If a build session is writing Python, or a Gate A
session is writing NestJS, the wrong task is being worked — stop and reorient.

**1. A slice is done when a phone call proves it.** Not when the code compiles, not when
the tests pass. For outbound, the equivalent is a call you placed ringing a real handset;
a REST call that returned 201 proves nothing.

**2. No vendor types outside adapters.** Twilio, Deepgram, ElevenLabs, Anthropic and
friends live inside `packages/providers/*`. Enforced by the `noVendorSdks` ESLint config in
`packages/config/eslint.base.mjs` — `@typescript-eslint/no-restricted-imports` over a
pattern list. It applies to `apps/api` *and* `apps/web`. A vendor import outside an adapter
fails lint, not review.

**3. `organization_id` is not optional.** Every table, every query, every log line, every
metric label, every event. Isolation is enforced by Postgres RLS, not by remembering a
`where` clause.

**4. A call reads published configuration. Never a draft.** Saving in the console writes
`agent_config_drafts`; publishing copies it onto the agent and deletes the row. See §3.

### Rule 4 and its two guards

The design is deliberate: a `published` boolean on `agents` would have put unpublished text
one forgotten `where` clause away from a caller. A *separate table* cannot be read by
mistake. Two tests hold the line, and both are written to fail loudly:

| Guard | File | What it asserts |
|---|---|---|
| Database side | `packages/db/src/drafts.test.ts` | Queries `pg_proc` for every function in schema `app` and fails if any except `save_agent_draft`, `stage_agent_draft_selection`, `discard_agent_draft`, `publish_agent_config` has `agent_config_drafts` in its source. Also asserts the converse, so the allow-list cannot rot. Also asserts `rows.length > 15` — *a guard that silently inspects nothing reports success forever.* |
| TypeScript side | `apps/api/src/tenancy/call-path.test.ts` | Source-scans `telephony`, `orchestrator`, `tenancy`, `outbound`, `conversation` for `loadAgentDraft`, `saveAgentDraft`, `discardAgentDraft`, `liveAgentId` and the raw string `agent_config_drafts`. Asserts it scanned >20 files. |

The table name is in the TypeScript scan because `scope.query` takes raw SQL, and a
`join agent_config_drafts` would be invisible to a scan that only knew function names.

**"Just to preview it on a test call" is the shape of the mistake. A test call is a call.**
If a call needs something, it belongs in the published document and reaches the call by
being published.

The line, agreed and recorded in `TASKS.md`: **anything belonging to one agent is staged;
anything shared across the organisation is immediate.** Staged — the publish form (name,
voice, rate, greeting, persona, instructions, keyterms, hours, escalation), captured
fields, tool selection, knowledge selection, behaviour flags. Immediate — the tool registry
itself and the knowledge sources, because writing a FAQ must not require republishing every
agent.

---

## 3. The two latency loops

**This is the constraint that decides most design questions in the voice path.** From
`docs/ansa-conversational-fixes.md`:

```
REAL-TIME (~50-150ms): turn detection, barge-in, playback tracking.
  Never awaits the LLM. Has authority to abort the reasoning loop mid-flight.
REASONING (~500ms-2s): state assembly, LLM, tools, TTS.
```

They must not block each other.

**On the real-time path you may not `await`:** an LLM request, a tool dispatch, a database
query, or anything that crosses the network to a vendor. Persistence is async and off the
hot path — assemble state from in-memory call state and write to Postgres *after*
responding.

Concretely, when the caller says "mm-hmm" 3.2 seconds into the agent's reply, the LLM
finished generating two seconds ago and audio is playing out of a buffer. You have ~150ms
to decide whether to kill it. There is no round trip available, so *deciding whether an
utterance is an interruption is a code-level guard*, never a prompt.

Corollaries that fall out of this and are easy to get wrong:

- **Silence reads as a dropped call.** Any gap over 2s must produce sound. That is why the
  holding-speech scheduler exists, and why holding speech starts when a tool is
  *dispatched*, not when it returns.
- **Barge-in changes context.** The unplayed portion of the agent's turn never happened.
  Truncate it out of conversation history or the agent will reference things the caller
  never heard.
- **Streaming everywhere.** Batch STT and non-streaming TTS are disqualifying, not
  suboptimal.
- **No transcoding in the audio path.** Twilio gives 8kHz mu-law; keep it 8kHz mu-law end
  to end.
- **Connection warmth is a latency feature.** `apps/api/src/main.ts` sets a global undici
  `Agent` with `keepAliveTimeout: 60_000` because Node's 4s default meant a caller who
  talks for five seconds pays a fresh TCP+TLS handshake on the LLM *and* the TTS request.
  Measured on live calls: 959ms cold against 468ms warm for the same TTS request. Both
  database pools run `select 1` at boot for the same reason — the first query of the
  process cost 1.15s on the media socket of the first call after a restart.

---

## 4. The gate before any commit

Run from the repo root:

```bash
pnpm lint        # turbo run lint  &&  pnpm check:wiring
pnpm typecheck   # turbo run typecheck   (dependsOn ^build)
pnpm build       # turbo run build
```

then the affected test suites:

```bash
pnpm --filter @ansa/api test
pnpm --filter @ansa/db test        # needs DIRECT_URL — it talks to a real database
pnpm --filter @ansa/normalizer test
pnpm test                          # everything; turbo run test, dependsOn ^build
```

**The wiring check is already inside root `pnpm lint`.** It is `pnpm check:wiring` →
`node tools/wiring/check-wiring.mjs`. Run it alone when you want the answer fast.

It exists because three tested modules were built that nothing invoked — the readback state
machine, the event recorder, and `recordTurns` — and each was reported as done. **An
unwired module is inventory that reads as progress, and it cannot be proved by a phone
call.** It distinguishes two failures a grep conflates:

```
dead          nothing references it at all      -> delete it
over-exported only its own file uses it         -> drop the `export`, it already works
```

Environment: Node >= 22, pnpm 11.5.2, TypeScript 5.9.3 strict (including
`noUncheckedIndexedAccess`). Turborepo caches `build`; `typecheck` and `test` both
`dependsOn: ["^build"]`, so a stale `dist/` in a dependency package is a real cause of
confusing failures — `pnpm build` first when something makes no sense.

`apps/web` has **no unit tests on purpose**: `pnpm typecheck` and `pnpm build` are its
gates, and a phone ringing is the proof.

### When an API route changes

```bash
pnpm --filter @ansa/web generate
```

This runs `apps/api`'s emitter, rewriting `apps/api/openapi.json` **and**
`apps/web/src/lib/api/generated.ts`. Both are committed. `openapi.test.ts` compares the
committed spec against a fresh build and fails if they differ, and `next build` typechecks
the client — so skipping this breaks the build in two places rather than drifting quietly.

---

## 5. Migrations

Numbered SQL files in `packages/db/migrations/NNNN_name.sql`. There is no migration runner
in this repo: **they are applied by hand, as the `postgres` owner, over
`MIGRATION_DIRECT_URL`.**

Three connection strings, and the distinction is a security boundary rather than a
convention (`.env.example`):

| Variable | Role | Purpose |
|---|---|---|
| `DATABASE_URL` | `ansa_app` | The app. Port 6543, transaction-mode pooler. `SET LOCAL` survives it because it is transaction-scoped; session state would not. |
| `DIRECT_URL` | `ansa_app` | Port 5432. Tests, and anything needing a session. |
| `MIGRATION_DIRECT_URL` | `postgres` | Schema changes only. Owns the schema; creating roles and policies requires it. |

**Never point `DATABASE_URL` at `postgres`.** Supabase's default `postgres` role has
`rolbypassrls = true`, an attribute *separate from superuser* that defeats
`FORCE ROW LEVEL SECURITY` entirely. Every policy existed, `pg_policies` listed them,
`relforcerowsecurity` read true, and one organisation read another's calls anyway. Had the
app shipped on the default connection string, every organisation would have seen every
other one's data. Migration `0002` now asserts `ansa_app` lacks BYPASSRLS and raises if it
does.

`ansa_app` cannot create tables, has no INSERT on `users`, and has SELECT-only on
`organization_numbers`. Where the app genuinely must cross that line it goes through a
`SECURITY DEFINER` function — `app.create_organisation`, `app.accept_invitation` — and
nothing else can reach those tables.

**Never print a secret.** Not in a log line, not in an echoed command, not in a test
failure message. `TOOL_CREDENTIAL_KEY` in particular is deliberately never in the database:
if it were, a database dump would be a credential leak and the encryption would be
decoration.

One more RLS consequence, from memory worth keeping: a query run outside
`withOrganization` sees **zero rows**, because `app.current_organization()` returns NULL
when unset. It fails closed, which is safe, but it presents as "the database is empty"
rather than as a bug. Zero rows as `ansa_app` means *unscoped*, not *absent*.

---

## 6. Verify against reality, not just tests

This repo's own history is a list of defects that passed a green suite. Read them as a
checklist of what a test cannot see.

| What was green | What was actually true | What found it |
|---|---|---|
| Every RLS policy existed and was listed | One organisation read another's calls | An adversarial test that *tried to cross the boundary* |
| `openapi.json` was correct | The generated client had never compiled — it emitted `test-calls:` as an object key and typed integer path params as `string` | `apps/web` consuming it for the first time |
| Unit tests passed for three buttons labelled Save | Each one published every tab live on the next call | Someone noticing the version number moved |
| Panels remounted correctly | Flipping one switch threw away unsaved text on two other tabs | Typing in the browser |
| Discard worked | The optimistic switch kept showing the flip that had just been discarded | The browser; keys could not fix it |
| `drafts.test.ts` passed | It was not idempotent — it passed alone, failed in a full run, and failed *differently* each time, which reads as database flakiness and is not | A full-suite run |
| The API booted | A missing provider export exited 1 and printed nothing, because Nest's default `abortOnError` is `process.abort()` — a native core dump taken before the bootstrap promise settles, so the `catch` had never run | An hour of bisecting |
| `next dev` served the app | Opening it at `127.0.0.1:3100` instead of `localhost:3100` silently blocked every `/_next/static` chunk: pages render, nothing is clickable, one warning in the terminal | Clicking things |

**So:**

- A guard that inspects nothing passes forever. Assert the *count* of what a scan read.
- Never write a test that only proves a policy or a config value exists. Prove the
  behaviour by attempting the thing it forbids.
- For the voice path, place the call. For the console, open the browser. For the database,
  check in `psql`.
- A test fixture that depends on the previous run having finished cleanly is a fixture that
  lies eventually. Tear down in `beforeAll` as well as `afterAll`, and set every column a
  test asserts a starting value for.
- Suites in `packages/db` share one database and run in parallel, so each file owns its own
  organisation-id prefix range. The list is written out in `drafts.test.ts`. Reusing another
  file's range means its `afterAll` deletes your fixture mid-run.

---

## 7. Which skill to reach for

| Working on | Load |
|---|---|
| Anything, at the start | this skill |
| A controller, endpoint, guard, DI wiring, `@ansa/db` query, OpenAPI | `nestjs-api-standards` |
| A page, Server Action, form, component in `apps/web` | `nextjs-console-standards` |
| Media streams, TwiML, webhooks, signatures, AMD, outbound origination | `twilio-media-streams` |
| Flux turn detection, transcription, EOT thresholds, the listen layer | `deepgram-flux-listen` |
| Streaming synthesis, cancellation, voice settings, telephony output format | `elevenlabs-streaming-tts` |
| The LLM adapter, tool-call reassembly, realtime transcription | `openai-realtime-voice` |
| RLS, pooler behaviour, `SECURITY DEFINER`, connection strings | `supabase-postgres-tenancy` |

Provider skills live beside this one under `.claude/skills/`. If a name above does not
resolve, list that directory rather than guessing — they are maintained separately.

**Provider documentation must be re-fetched, never recalled.** This is written into the
project brief itself: *"Before writing any provider integration, fetch that provider's
CURRENT docs and use the actual current parameter and event names. Do not rely on your
training data — these change frequently. Tell me where what you find differs from this
brief."* Deepgram Flux, Twilio Media Streams and AMD, and ElevenLabs streaming have all
changed parameter names within this project's lifetime. The same applies to Next.js: this
repo pins 16.3.1 and vendors real docs at `apps/web/node_modules/next/dist/docs/`, which
are authoritative over anything you remember.

---

## 8. Repo shape and the seams that matter

```
ansa/
├── apps/
│   ├── api/          NestJS — telephony, orchestration, tools, dashboard API
│   └── web/          Next.js 16.3.1 console
├── packages/
│   ├── providers/
│   │   ├── listen/   transcriber/ (words) and turn/ (turn events) — TWO interfaces
│   │   ├── tts/      @ansa/tts
│   │   ├── llm/      @ansa/llm
│   │   └── telephony/@ansa/telephony
│   ├── db/           @ansa/db — migrations, scopes, query functions
│   ├── normalizer/   pure, no I/O, highest coverage in the repo
│   ├── tools/        @ansa/tools — registry, dispatch, adapters, risk tiers
│   ├── shared/       @ansa/shared — types, logger
│   └── config/       @ansa/config — eslint.base.mjs, tsconfig.base.json
├── eval/             Python. Not the product.
├── tools/            operator scripts + the wiring check
└── docs/
```

**Functions are expressions, not declarations.** `const parseFrame = (raw: string) => …`,
never `function parseFrame(…) {}`. Enforced by `func-style: ["error", "expression"]` in
`@ansa/config`. Two consequences: expressions do not hoist, so a helper must appear above
its first use; and **class methods are exempt automatically**, because the rule only sees
free functions. NestJS controllers, modules and gateways stay classes.

Also from the base config: `no-console` is an error (use `createLogger` from
`@ansa/shared`), `@typescript-eslint/no-explicit-any` is an error, and
`consistent-type-imports` is on.

### Listen is two interfaces, not one

The seam most easily got wrong. Understanding *what the caller said* and knowing *when the
caller stopped talking* are different problems with different best providers — accent
specialists lead on Nigerian transcription; conversational models lead on model-native
end-of-turn detection. Fusing them because a vendor SDK does costs you the best available
combination, and you will not notice until it is expensive to unpick. The orchestrator
consumes turn events and transcripts as **separate streams correlated by timestamp** and
must never assume they arrive on one connection.

`apps/api/src/config/env.ts` reflects this today: `LISTEN_WORDS` chooses who supplies the
words; there is deliberately **no** setting for who supplies the turns, because a
deployment once quietly ran OpenAI's VAD for turn-taking while the Flux adapter sat unused
behind a config value.

### Tools: one registry, one dispatch path, many adapters

Internal tools, HTTP connectors and MCP servers all register into the same place and
execute through the same code. When adding a route the test is: did you write an adapter,
or a second dispatch path? Only the first is acceptable.

Risk tier is a **required** registration field (`packages/tools/src/types.ts`,
`RiskTier = "read" | "write" | "irreversible"`); registration throws without one.

- `read` — executes freely
- `write` — spoken confirmation plus readback before firing
- `irreversible` — never executes, transfers to a human

Enforced in the dispatch path, never as a prompt instruction, because prompts can be talked
out of things and code cannot. Same reasoning governs the outbound consent gate: NDPR/NCC
rules, time-of-day limits and do-not-call suppression live in the dispatch path, and an
organisation configuring "call these numbers" must not be able to configure the check away.

### The normalizer

Pure: text in, text out, no I/O, no network, no config lookups. **Nothing reaches TTS
unnormalized** — not LLM output, not tool results, not static greetings, not error
messages. Every bug found in production becomes a test case before it is fixed. Prompting
is not a substitute: the model gets naira amounts right 90% of the time, and 90% is a
customer complaint.

---

## 9. Session discipline

- One slice at a time. Do not start the next until the current "done when" is true.
- Update `TASKS.md` before stopping — check boxes, write down what broke.
- `pnpm lint && pnpm typecheck` before committing; add `pnpm build` and the affected suites
  before calling anything done.
- **Push to remote at the end of every session.** The previous build was lost on a dead
  laptop, and that is the origin of half the discipline in this file.
- Never add AI attribution to commits, PRs, issues or comments.

## 10. Things that feel tempting and are wrong

- Building the organisation dashboard because the internal viewer is ugly. The viewer is
  for debugging; ugly is fine.
- Skipping the readback confirmation because STT confidence looks high. Confidence is not
  correctness on 8kHz audio.
- Handling number formatting in the system prompt because it works in testing. It works
  until it doesn't, in front of a customer.
- Treating STT as one interface because the vendor SDK does.
- Adding a second dispatch path for MCP because it is structurally different. It isn't,
  above the adapter.
- Pre-generalising for outbound. `direction` exists because two lifecycles genuinely
  differ; widen a type when a real outbound requirement forces it, not in anticipation.
- Starting Phase 2 or 3 features because they are more interesting. They are. That is why
  they are listed under "Not now."
