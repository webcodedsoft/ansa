> **APPLIED 2026-08-08** in "The call keeps a record, not just a transcript". All seven
> steps, with one deviation: step 3 routes a confirmed value by the entity kind capture
> now reports rather than by the `asName` regex, and a kind the store has no field for
> writes nothing. The "proving it on a phone call" section is still owed.

# Wiring `call-facts` into the call

Written by the `context-memory` agent during a parallel run in which nine agents shared
one working tree. `orchestrator.ts`, `capture.ts` and `media.gateway.ts` were contended,
so nothing in this file has been applied. **The module is tested and unwired**, which by
CLAUDE.md's own standard means it is not done — a phone call cannot prove it yet.

Line numbers are as of `26239bf`. They will have drifted; every edit below quotes the code
it attaches to, so anchor on the quote, not the number.

Apply in order. Each step leaves `pnpm lint && pnpm typecheck && pnpm test` green on its
own, and steps 1–4 are the minimum that makes the module do anything.

---

## 1. `apps/api/src/orchestrator/orchestrator.ts` — accept the store as a dependency

**Where** `OrchestratorDeps`, after `readonly transcriptionConfig?: ...` (`:106`).

```ts
  /**
   * What the agent knows about this call, and how well it knows it.
   *
   * Constructed by the gateway rather than here, because the organization is resolved on the
   * media socket and the orchestrator has never needed to know it. Absent on a call whose
   * number has no organization configuration — the same calls for which the recorder is already
   * skipped.
   */
  readonly facts?: CallFactsStore;
```

**Import** `import type { CallFactsStore } from "../conversation/call-facts";`

**Why a store rather than a organization id.** The alternative — passing `organizationId` and building
the store inside `runConversation` — makes the orchestrator learn the organization in order to
construct one object, and the gateway already holds it three lines above the
`runConversation` call. This way `deps.facts` is one optional dependency with a natural
absent case, like `recorder`.

---

## 2. `apps/api/src/telephony/media.gateway.ts` — construct it

**Where** in `startConversation`, immediately after the `recorder` block that ends
`stream.onClosed((reason) => { ... });` (`:365`), and before `const listen = ...`.

```ts
    // Only when the organization resolved. A call on an unconfigured number is already running
    // with base vocabulary and recording nothing; there is nothing to scope state to and
    // CLAUDE.md rule 3 does not admit a placeholder organization.
    const facts =
      organization?.organizationId == null
        ? undefined
        : createCallFacts({
            organizationId: organization.organizationId,
            callId: stream.callId,
            callDirection:
              stream.parameters[DIRECTION_PARAM] === "outbound" ? "outbound" : "inbound",
          });
```

**And** add `facts,` to the `runConversation(stream, { ... })` object, next to `recorder`.

**Import** `import { createCallFacts } from "../conversation/call-facts";`

The `DIRECTION_PARAM` ternary is copied verbatim from `recorder.started` a few lines above,
so the two cannot disagree about which way the call went.

---

## 3. `apps/api/src/orchestrator/orchestrator.ts` — record a confirmed value

This is the step that makes "told once, used for the rest of the call" true.

**Where** in `captureHandled`, inside `if (result.captured !== null) { ... }` (`:1107`),
after the existing `const asName = ...` line and before `respondTo(...)`.

```ts
      // Confirmed by the caller against a readback, so it may now be used. Source matters
      // more than the value: this is one of the five provenances that are allowed to write
      // an identifier, and the model is not among them.
      deps.facts?.observe({
        field: asName ? "callerName" : "policyNumber",
        value: result.captured,
        source: "caller-confirmation",
        atMs: Date.now(),
      });
```

**Why `asName`** rather than `capture.subject`: `capture` has already been reset to `idle`
two lines above, so the subject is gone. The `asName` regex is the existing code's own
answer to the same question and reusing it keeps one rule, not two.

---

## 4. `apps/api/src/orchestrator/orchestrator.ts` — give the model the state

**Where** in `respondTo`, the `deps.llm.complete({ system: ... })` call (`:977`).

```ts
    const known = deps.facts === undefined ? "" : renderFacts(deps.facts.facts);
    const completion = deps.llm.complete({
      // Order is deliberate. Standing instructions, then what is known about this call,
      // then how long this particular reply may be — the per-turn instruction sits
      // nearest the generation because it is the one that changes every turn.
      system: [SYSTEM_PROMPT, known, budget.instruction].filter((s) => s !== "").join("\n\n"),
      messages: conversation.messages,
      maxTokens: budget.maxTokens,
    });
```

**Import** `import { renderFacts } from "../conversation/facts-prompt";`

`renderFacts` returns `""` until something is known, so turn one is byte-for-byte the
prompt that is sent today and the greeting path cannot regress.

---

## 5. `apps/api/src/orchestrator/orchestrator.ts` — the keypad

**Where** in the `stream.onDigit` handler, inside `if (result.captured !== null)`
(`:1158`), before `respondTo(...)`.

```ts
      deps.facts?.observe({
        field: "policyNumber",
        value: result.captured,
        source: "dtmf",
        atMs: Date.now(),
      });
```

Always a number: the keypad is only ever offered for one, and `capture.ts` says why —
there is no key for "Sikiru".

---

## 6. `apps/api/src/orchestrator/orchestrator.ts` — the candidate under confirmation

Without this the state knows nothing until a readback succeeds, and the agent can ask for
a name it is at that moment in the middle of confirming.

**Where** in `captureHandled`, inside `if (capture.kind === "confirming") { ... }`
(`:1134`), alongside the two `record.event` calls.

```ts
      deps.facts?.observe({
        field: capture.subject === "name" ? "callerName" : "policyNumber",
        value: capture.value,
        source: "stt",
        atMs: Date.now(),
      });
```

The value never reaches the model: `renderFacts` renders an unconfirmed identifier as
"they have given it and you are still checking it", with no value in the line. That is
tested in `facts-prompt.test.ts`.

---

## 7. `apps/api/src/orchestrator/orchestrator.ts` — the open question

**Where** two edits, both small.

At the top of `respondTo` (`:933`), after `conversation.addCaller(forModel);`:

```ts
    // They have answered. Whatever we were waiting on is no longer outstanding.
    deps.facts?.clear("pendingQuestion");
```

In `completion.onDone`, next to the existing `log.info("agent turn", ...)`:

```ts
    const asked = full.trim();
    if (asked.endsWith("?")) {
      deps.facts?.observe({
        field: "pendingQuestion",
        value: asked.split(/(?<=[.!?])\s+/).filter((s) => s.endsWith("?")).at(-1) ?? asked,
        source: "model",
        atMs: Date.now(),
      });
    }
```

A code-side rule, not a prompt one: the agent does not have to cooperate for this to be
right, and a turn that ends in a question mark is a question by construction.

---

## What is deliberately not wired, and why

**`intent` and `reasonForCall` stay UNKNOWN.** `classify()` returns a turn shape — polar,
wh, explanation — not an intent, which `docs/AGENT_PLAN.md` already records under §11.
The slots exist and render correctly; filling them needs the intent classifier, and
guessing an intent from the turn shape would put a wrong label in front of the model with
a confident-sounding status attached.

**`currentTask` stays UNKNOWN.** It belongs to the call-level state machine that
`conversation-director` is lifting out of `orchestrator.ts`. When that machine exists, one
`observe({ field: "currentTask", source: "business-rule" })` per transition fills it, and
doing it now would be a second, disagreeing account of what the call is doing.

**Nothing consumes `confirmedFact` yet**, because there is no tool registry to consume it.
That is the whole point of the function: when `tools-and-actions` lands, a tool argument
comes from `confirmedFact(facts.policyNumber)` and gets `null` for anything the caller has
not agreed to out loud, rather than from a model that read a number off the transcript.

**A contested value is recorded and not acted on.** When a transcription result
contradicts a confirmed identifier, `observe` returns `reason: "contested"` and changes
nothing. The right response is to re-open the readback for that field — the caller may be
correcting themselves — and that belongs to `entity-capture`, which owns the capture loop.
Until it is handled, the agent keeps using the value the caller confirmed, which is the
safe direction but not the complete answer. Worth a `record.event("fact contested", ...)`
at the call site in step 3 so it can be counted rather than assumed rare.

---

## Proving it on a phone call

Unit tests prove the transitions. They cannot prove this, and the charter is explicit that
only a call can:

1. Say "my name is Ada Obi" at the start of the call and confirm it when read back.
2. Talk about something else for two or three turns.
3. Ask "do you know who you're speaking to?"

The agent must use the name without asking for it again, and the log must show
`callerNameConfirmed: true` for the whole call. Then the negative case: give a policy
number, confirm it, and later mumble a different one mid-sentence. The confirmed value
must survive — the log shows `contested`, not a changed value.
