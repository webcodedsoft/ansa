# Specialist agents for the conversation pipeline

A plan for splitting the voice-quality work across focused agents, one per core feature,
so each can go deep instead of one generalist skimming twelve areas. Written 2026-08-08.

---

## Two corrections to the brief, before anything is built

**The product is NestJS, not Next.js.** `apps/api` is a NestJS service and CLAUDE.md rule 0
is explicit about it. Nothing in the brief actually requires Next.js — it describes a
real-time call pipeline, which is what exists. If a tenant dashboard is wanted later that
is a separate app, not a rewrite of this one. No agent should act on the Next.js line.

**Most of the brief is already built.** An agent told to "implement barge-in" will
reimplement working code. Each charter below therefore states what exists, so the agent
starts by reading it rather than replacing it.

| Brief section | State today |
|---|---|
| §2 state machine | Capture has one; the *call* does not |
| §3 turn-taking | Turn detector, mid-thought wait, bare-greeting wait, backchannel filter |
| §4 barge-in | Cancels LLM, synthesis, queue, filler, carrier audio |
| §5 STT abstraction | `Transcriber`/`TurnDetector` split; OpenAI + Deepgram; harness built, never run |
| §6–9 entities | Name and alphanumeric capture, candidate accumulation, rejection memory, DTMF |
| §10 memory | Conversation history only; no structured entity store |
| §11 intent | `classify()` returns a turn shape, not an intent |
| §16 hallucination | LLM never sees an unconfirmed value; audio gate discards invented transcripts |
| §17 tools | **Nothing.** No registry, no dispatch |
| §18 handoff | Speaks a line, transfers nowhere |
| §20 tenancy | RLS, per-tenant config and keyterms, versioned |
| §21 prompts | One prompt plus a per-turn budget; layers designed, not built |
| §22 latency | 15 event kinds and a config snapshot |
| §24 observability | Event log, viewer, no metrics |

---

## Rules every agent inherits

Non-negotiable, and they are what keep ten agents from pulling the codebase apart.

1. **Read `CLAUDE.md` first.** Function expressions, no vendor types outside adapters,
   `tenant_id` everywhere, one tool dispatch path.
2. **Guarantees live in code, not prompts.** A tenant must never be able to configure away
   readback, a risk tier, or AI disclosure.
3. **Wire it or do not claim it.** An export nothing calls fails `pnpm lint`. Finish at the
   call site, not the module boundary.
4. **A phone call proves it.** Unit tests prove a thing does not crash. Every serious bug
   this project has had was found at a seam by a real call.
5. **Do not replace a working component** because a different technology exists.
6. **Smallest change that fixes the observed behaviour**, with the reasoning stated before
   the diff.

---

## The roster

Ten agents. Priority follows the brief's own P0–P3.

### P0 · `conversation-director`
**Owns** §2 call-level state machine, §12 dialogue management, §13 acknowledgements,
§14 silence, §15 error recovery.
**Exists** Turn budgets by caller action; varied capture phrasing; recovery lines.
**Must not touch** Entity capture internals, STT, telephony.
**First task** Lift the implicit call state out of `orchestrator.ts` into an explicit
machine. The states are already there in spirit — greeting, listening, capturing,
confirming, escalating — expressed as scattered booleans.
**Done when** A call's state at any moment is one named value that can be logged, and the
transitions are unit-testable without audio.

### P1 · `stt-reliability`
**Owns** §5 provider abstraction, the comparison harness, transcript quality.
**Exists** Both providers, composite listen, audio recording, harness at
`tools/stt-compare` — **never run**.
**First task** Run it on a real recording. Report which of Twilio encoding, transcoding,
provider, or configuration is responsible. Guessing has been wrong three times.
**Done when** The name problem has a measured cause rather than a suspected one.

### P1 · `entity-capture`
**Owns** §6 entity capture, §7 names, §8 alphanumerics, §9 confirmation policy.
**Exists** `capture.ts` — candidate accumulation, rejection memory, spelling, DTMF.
**First task** Extend beyond name and reference to the other entity types, and make
confirmation risk-driven rather than always-on for numbers — §9 asks for that and R4.3.1
forbids skipping readback, so the boundary needs care and belongs in code.
**Done when** Every entity type in §6 has a capture mode and a stated confirmation rule.

### P1 · `turn-taking`
**Owns** §3 endpointing, §4 barge-in.
**Exists** Both, working. Barge-in offsets recorded but never seen populated on a call.
**First task** Verify on a real call before changing anything, then tune thresholds
against recorded audio rather than against one live impression.
**Done when** Interruption is measured, not asserted.

### P1 · `context-memory`
**Owns** §10 structured state, §11 intent, §16 hallucination prevention.
**Exists** Message history; no entity store; `classify()` is turn shape, not intent.
**First task** The structured state object in §10, populated from confirmed entities only.
It is the fix for "do not ask for what the caller already gave".
**Done when** The agent can be told a name once and use it for the rest of the call.

### P1 · `latency-audio`
**Owns** §22 latency, §23 audio pipeline integrity.
**Exists** 15 telemetry stages; ~1.1s against an 800ms budget; a PCM path built and never
enabled.
**First task** Attribute the 1.1s across stages from recorded calls. Distance to US
providers is suspected and unproven.
**Done when** Every stage has a measured p50 and the largest is named.

### P2 · `tools-and-actions`
**Owns** §17 tool registry and dispatch.
**Exists** Nothing. R5.2.0 specifies one registry, one dispatch path, many adapters.
**First task** The registry with risk tiers enforced in dispatch — `read` free, `write`
confirmed, `irreversible` transferred.
**Done when** The agent can answer a question about real data, which is the largest single
gap in the product.

### P2 · `human-handoff`
**Owns** §18 escalation and handoff summary.
**Exists** A spoken line that transfers nowhere.
**Done when** A transfer connects and the human receives the context.

### P2 · `observability`
**Owns** §24 metrics, §25 conversation tests.
**Exists** Event log, transcripts, turns, viewer.
**First task** The twenty scenarios in §25 as replayable tests against recorded audio.
**Done when** A provider or prompt change can be scored instead of argued about.

### P3 · `tenancy-and-prompts`
**Owns** §20 tenant configuration, §21 prompt layering.
**Exists** RLS, per-tenant config, versioning; prompt layers designed in
`docs/MULTI_TENANT_ARCHITECTURE.md`, not built.
**Why last** Deliberately. There is one tenant, and the base being strong matters more
than the configuration surface until there are several.

---

## Sequencing

Two agents unblock the rest and should run first, in parallel:

- **`stt-reliability`** — settles the transcription question with evidence.
- **`tools-and-actions`** — a good conversationalist with nothing to talk about is the
  largest cause of calls feeling hollow.

Then `context-memory` and `conversation-director` together, since structured state is what
the state machine transitions on.

`entity-capture` and `turn-taking` wait for the harness: both would otherwise be tuned
against a transcriber that may be misconfigured, and that tuning would have to be redone.

`observability`, `human-handoff`, `tenancy-and-prompts` last.

---

## The one thing this plan cannot decide

If the harness shows the fault is the cascade itself rather than a configuration, the
answer is speech-to-speech and roughly half these charters change. That is why
`stt-reliability` runs first and alone: it is the cheapest way to find out whether the
other nine are aimed at the right target.
