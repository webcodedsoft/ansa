# KICKOFF.md — the first prompt

Paste the block below into Claude Code in a directory containing `PRD.md`,
`TASKS.md`, `CLAUDE.md`, `TEST_PROTOCOL.md` and `eval/`.

This starts the **build**: NestJS, TypeScript, Slice 1. The Python in `eval/` is
measurement tooling for Gate A and is not touched during build slices.

---

```
Read CLAUDE.md, TASKS.md and PRD.md in full before doing anything. CLAUDE.md is
the conventions, TASKS.md is the plan, PRD.md holds the requirement detail that
R-numbers refer to.

Project: Ansa — an AI voice agent that answers inbound phone calls for companies
in Nigeria. Multi-tenant SaaS, horizontal across industries, Nigeria-first on
accent, numbers and telephony. Inbound only. Outbound does not exist and must
not be designed for.

Language: TypeScript and NestJS. The eval/ directory is Python measurement
tooling for Gate A — do not read it, modify it, or write any Python this
session. If you find yourself writing Python, you are in the wrong place.

We are on Slice 1: a phone number that answers, speaks one Nigerian-accented
sentence, and hangs up. That is the whole scope. Do not build the conversation
loop, the event log, tools, or a dashboard — those are Slices 2 onward and each
has its own session.

Work in this order, stopping after each for my review:

1. Turborepo + pnpm monorepo per the repo shape in CLAUDE.md. apps/api as a
   NestJS app, packages/providers/{listen,tts,telephony}, packages/shared,
   packages/config. Empty interfaces are fine at this stage — I want the shape
   and a passing `pnpm lint && pnpm typecheck` before any logic. Stop.

2. Twilio inbound webhook + bidirectional media stream over WebSocket, mu-law
   8kHz. Log that audio frames are arriving. Stop.

3. The TTS provider interface plus one implementation behind it. Tell me which
   provider you propose and why before you write the adapter — the choice is
   PROVISIONAL and gets revisited at Gate A, so pick for ease of integration,
   not for accuracy. Stop.

4. Wire it together: the agent answers and says "Thank you for calling Ansa."
   Nothing else. Then stop.

Rules for this session:

- No vendor SDK types outside packages/providers/*. This is rule 2 in CLAUDE.md
  and it is what lets me change providers after Gate A without a rewrite. If a
  Twilio or TTS type appears in apps/api business logic, that is a defect.
- tenant_id is not needed yet (that is Slice 2) but do not design anything that
  would make adding it painful.
- No `direction` fields, no CallType enums, no outbound-shaped abstractions.
- Ask before installing anything beyond what the slice needs.
- Update TASKS.md checkboxes as things complete, before you stop.

Start by telling me, in your own words, what Slice 1 is and what it explicitly
excludes. Then stop and wait for me before writing code.
```

---

## Why it is shaped this way

**It fences the language.** The single most confusing thing about this repo is
that it contains Python that is not the product. The prompt says so in the third
paragraph and gives a self-check: writing Python means you are in the wrong
place.

**It fences the slice.** A capable model will helpfully scaffold the whole
pipeline on day one. Slice 1 is four steps with a stop after each, and the scope
exclusion is stated twice.

**It marks the provider choice as provisional.** Otherwise the model reasons
about accuracy, picks a "best" provider, and you inherit a decision that was
supposed to be Gate A's.

**It asks for a read-back before code.** If the restatement comes back wrong you
have lost thirty seconds instead of a session.

---

## Later prompts, roughly

**Slice 2** — "Slice 1 is confirmed working. Move to Slice 2: Postgres schema
with tenant_id on every table, RLS policies, the adversarial isolation test, the
call event log, and the internal call viewer. Read the Slice 2 section of
TASKS.md. Ugly UI is fine — it is a debugging tool, not a product surface."

**Gate A** — a separate session, in `eval/`, Python only. Use the Gate A prompt
in `eval/README.md`. Never mix it with a build session; the language boundary is
the guardrail and running both at once removes it.
