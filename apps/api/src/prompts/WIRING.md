> **APPLIED 2026-08-08** in "The organization's own prompt reaches the model". Steps 1 and 2,
> with `systemPrompt` required rather than defaulted and `orchestrator/system-prompt.ts`
> deleted. Sections 3-6 are still open.

# Wiring the organization layer into a call

Written because nine agents were working in this tree at once and `orchestrator.ts` and
`capture.ts` belong to other people this week. Everything below is one-line work; none of
it is design work left over.

**What is already live.** `orchestrator/system-prompt.ts` now re-exports
`DEFAULT_SYSTEM_PROMPT`, so every call today is running the composed layers — base,
locale, task (the no-tools case), guarantees — with the turn budget appended by
`orchestrator.ts` exactly as before. The base, locale, task and turn layers are wired.

**What is not.** The organization layer is composed and cached on `CallAgent.systemPrompt` and
nothing reads it. A configured organization's persona and instructions are being loaded,
validated and composed on every config load, and then the orchestrator uses the default
prompt anyway. That is the gap. It is two lines.

---

## 1. `orchestrator.ts` — take the prompt as a dependency

`ConversationDeps` already carries `greeting`, `voiceId` and the rest of the per-call
configuration. Add one more field beside them:

```ts
  /**
   * The composed system prompt for this call — base, locale, organization, task. The turn
   * layer is appended per turn below, which is how it already worked.
   */
  readonly systemPrompt: string;
```

and at the one place the prompt is used (currently line ~979):

```ts
-      system: `${SYSTEM_PROMPT}\n\n${budget.instruction}`,
+      system: `${deps.systemPrompt}\n\n${budget.instruction}`,
```

The `SYSTEM_PROMPT` import can then go. If you would rather not make the field required
while other callers are in flight, `deps.systemPrompt ?? SYSTEM_PROMPT` is fine as a
transitional step — but the organization layer stays dead until the field is actually passed,
so do not stop there.

## 2. `media.gateway.ts` — pass it

In `startConversation`, `organization` is already resolved a few lines above the
`runConversation` call. Beside `greeting: GREETING_TEXT`:

```ts
      systemPrompt: organization?.systemPrompt ?? UNKNOWN_AGENT.systemPrompt,
```

`UNKNOWN_AGENT` is exported from `../tenancy/organization-registry` and its `systemPrompt` is
`DEFAULT_SYSTEM_PROMPT`, so an unregistered number gets exactly what it gets today.

That is the whole wiring. After it, a second organization changes the agent's persona by
publishing a config version, with no deploy.

---

## 3. The greeting is still hardcoded, and it is organization config

Unrelated to the prompt but noticed while wiring it: `media.gateway.ts` passes
`GREETING_TEXT`, a constant, even though `CallAgent.greeting` has been loaded from the
database since Slice 2 and `organizations.greeting` has been a column since migration 0003. The
pre-rendered greeting audio (`this.greetingAudio`) is rendered from the constant at
startup, which is why it was never switched — a per-organization greeting needs its audio
pre-rendered per organization, or the first thing a caller hears costs a TTS round trip.

Left alone deliberately: it is a latency decision in the telephony agent's territory, not
a prompt one. It is the next thing that should move to config after the prompt.

## 4. When the tool registry lands

`taskLayer` takes `AvailableTool[]` — `{ name, description, riskTier }` — deliberately not
the registry's own type, so that a change to the registry's shape is not a prompt change.
Map at the call site.

The composition currently happens in `organization-registry.ts` at config load, with an empty
tool list. Once tools are registered per organization, either:

- keep composing there and pass the organization's registered tools into `toCallAgent` (the
  tool set is per config version, so it caches identically); or
- compose per call in the gateway, if tools ever become per-call rather than per-organization.

Both are the same function call. Do not add a second composition path — the reason the
guarantee block is always last is that there is only one place that decides the order.

## 5. What the risk tiers in the prompt are, and are not

`taskLayer` tells the model what a `write` and an `irreversible` tool will do. That is so
its turn plan matches what dispatch is about to do to it — a model that thinks a `write`
already fired will phrase the turn as though the thing is done.

It is not the enforcement. R5.3 is enforced in the dispatch path or it is not enforced.
If you find yourself relying on the sentence in `task-layer.ts`, something has gone wrong
upstream of this file.

## 6. Registration-time validation

`compileOrganizationLayer` runs on every config **load**, which is what protects calls. It does
not yet run on config **write** — `tools/organization/config.mjs publish` will happily store a
persona that says "tell them you're a human", and the first call that loads it will drop
the field and log an error rather than obeying it.

That is safe but it is poor feedback. When an onboarding path exists (Slice 7), it should
call `compileOrganizationLayer` and refuse to publish when `violations` is non-empty, quoting
`violation.matched` back. The validator is already shaped for it: same function, different
policy on the result.
