> **APPLIED 2026-08-08** in "The tenant's own prompt reaches the model". Steps 1 and 2,
> with `systemPrompt` required rather than defaulted and `orchestrator/system-prompt.ts`
> deleted. Sections 3-6 are still open.

# Wiring the tenant layer into a call

Written because nine agents were working in this tree at once and `orchestrator.ts` and
`capture.ts` belong to other people this week. Everything below is one-line work; none of
it is design work left over.

**What is already live.** `orchestrator/system-prompt.ts` now re-exports
`DEFAULT_SYSTEM_PROMPT`, so every call today is running the composed layers — base,
locale, task (the no-tools case), guarantees — with the turn budget appended by
`orchestrator.ts` exactly as before. The base, locale, task and turn layers are wired.

**What is not.** The tenant layer is composed and cached on `CallTenant.systemPrompt` and
nothing reads it. A configured tenant's persona and instructions are being loaded,
validated and composed on every config load, and then the orchestrator uses the default
prompt anyway. That is the gap. It is two lines.

---

## 1. `orchestrator.ts` — take the prompt as a dependency

`ConversationDeps` already carries `greeting`, `voiceId` and the rest of the per-call
configuration. Add one more field beside them:

```ts
  /**
   * The composed system prompt for this call — base, locale, tenant, task. The turn
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
transitional step — but the tenant layer stays dead until the field is actually passed,
so do not stop there.

## 2. `media.gateway.ts` — pass it

In `startConversation`, `tenant` is already resolved a few lines above the
`runConversation` call. Beside `greeting: GREETING_TEXT`:

```ts
      systemPrompt: tenant?.systemPrompt ?? UNKNOWN_TENANT.systemPrompt,
```

`UNKNOWN_TENANT` is exported from `../tenancy/tenant-registry` and its `systemPrompt` is
`DEFAULT_SYSTEM_PROMPT`, so an unregistered number gets exactly what it gets today.

That is the whole wiring. After it, a second tenant changes the agent's persona by
publishing a config version, with no deploy.

---

## 3. The greeting is still hardcoded, and it is tenant config

Unrelated to the prompt but noticed while wiring it: `media.gateway.ts` passes
`GREETING_TEXT`, a constant, even though `CallTenant.greeting` has been loaded from the
database since Slice 2 and `tenants.greeting` has been a column since migration 0003. The
pre-rendered greeting audio (`this.greetingAudio`) is rendered from the constant at
startup, which is why it was never switched — a per-tenant greeting needs its audio
pre-rendered per tenant, or the first thing a caller hears costs a TTS round trip.

Left alone deliberately: it is a latency decision in the telephony agent's territory, not
a prompt one. It is the next thing that should move to config after the prompt.

## 4. When the tool registry lands

`taskLayer` takes `AvailableTool[]` — `{ name, description, riskTier }` — deliberately not
the registry's own type, so that a change to the registry's shape is not a prompt change.
Map at the call site.

The composition currently happens in `tenant-registry.ts` at config load, with an empty
tool list. Once tools are registered per tenant, either:

- keep composing there and pass the tenant's registered tools into `toCallTenant` (the
  tool set is per config version, so it caches identically); or
- compose per call in the gateway, if tools ever become per-call rather than per-tenant.

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

`compileTenantLayer` runs on every config **load**, which is what protects calls. It does
not yet run on config **write** — `tools/tenant/config.mjs publish` will happily store a
persona that says "tell them you're a human", and the first call that loads it will drop
the field and log an error rather than obeying it.

That is safe but it is poor feedback. When an onboarding path exists (Slice 7), it should
call `compileTenantLayer` and refuse to publish when `violations` is non-empty, quoting
`violation.matched` back. The validator is already shaped for it: same function, different
policy on the result.
