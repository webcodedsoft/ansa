> **APPLIED IN FULL, 2026-08-08.** Step 0 landed in "The model can ask for a tool"; steps
> 1-5 landed with the platform tool set. `@ansa/tools` is on `apps/api/package.json`.
> **Nothing below has been proven on a phone call.**
>
> The decision the blocker was waiting on: **ship only the non-data tools.**
> `createInMemoryPolicyBook` is a fake and is registered nowhere on a real call — it is a
> test fixture and `internal/policy.test.ts` is the only thing that builds it. An agent
> answering confidently from a policy book nobody wrote is worse than one that says it
> cannot check. What ships instead is `internal/call-control.ts`: `end_call`,
> `transfer_to_human` and `business_hours`, none of which reads tenant data.
>
> **Four deviations from the text below, each deliberate:**
>
> 1. **No `deps.callId`.** `CallMediaStream.callId` is already a `CallId` and the
>    orchestrator already holds the stream. A second copy could only ever disagree.
> 2. **`deps.makeTools` is a factory, not a built `tools` / `toolRegistry` pair.** Step 5's
>    "one ordering wrinkle" is resolved the preferred way and then some: the registry is
>    per call as well as the dispatcher, because two of the three platform tools close over
>    this call's own effects — a registry built once in the module could not hold them.
> 3. **The registry is per call.** See above. Three map writes per call.
> 4. **The model is told once, not twice.** Step 3 wrote `modelMessage(outcome)` into the
>    conversation *and* then passed the summaries to `respondTo`, which adds them again.
>    The notes are added once, by whichever branch runs: `respondTo` on the read path, the
>    branch itself where no model turn follows.
>
> `isAffirmative` now exists. It is exported from `apps/api/src/orchestrator/capture.ts`
> and is the same yes that a readback is judged by, so "yeah, but…" is not a yes for a
> write either.

# Wiring `@ansa/tools` into the call path

Written by the `tools-and-actions` agent while eight other agents held
`apps/api/src/orchestrator/orchestrator.ts` open. Nothing outside `packages/tools/` was
touched, so **this package is currently reachable only from its own tests.** Applying the
edits below is what turns it into a product feature, and until they are applied nobody
should describe tool calling as working.

Apply in order. Each step compiles on its own.

---

## Step 0 — prerequisite, and the honest blocker

`packages/providers/llm` has no tool surface. `CompletionRequest` is `{ system, messages,
maxTokens }` and `CompletionStream` emits text only. **The model therefore cannot ask for a
tool, no matter what the registry contains.** Everything below is downstream of fixing that.

The smallest change that does not disturb the streaming design, in
`packages/providers/llm/src/types.ts`:

```ts
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema. Passed through to the vendor, never interpreted here. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ToolInvocation {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface CompletionRequest {
  // ...existing fields
  readonly tools?: readonly ToolSpec[];
}

export interface CompletionStream {
  // ...existing methods
  /**
   * Fires when the model asks for tools instead of speaking. Mutually exclusive with
   * onDone for that turn: a turn either answers or calls.
   */
  onToolCall(listener: (calls: readonly ToolInvocation[]) => void): void;
}
```

`ToolSpec` is deliberately structurally identical to the `name` / `description` /
`parameters` fields of `@ansa/tools`' `ToolDefinition`, so `registry.listFor(tenantId)` can
be handed straight to `complete()` with no mapping layer and no import of `@ansa/tools`
inside a provider package.

`Message` stays `{ role: "user" | "assistant"; content: string }`. Tool results re-enter
the conversation as an ordinary message (step 3). A dedicated `tool` role is nicer and can
come later; it is not needed to make the first call work, and it would change every
provider adapter.

**Owner:** whoever owns `packages/providers/llm`. Not applied here.

---

## Step 1 — `OrchestratorDeps` learns who it is acting for

`apps/api/src/orchestrator/orchestrator.ts`, inside `export interface OrchestratorDeps`
(around line 41).

```ts
  /**
   * Who this call belongs to. Required, not optional: a tool dispatch without a tenant
   * is a query that could return another tenant's row (CLAUDE.md rule 3), and the
   * dispatcher will not run one.
   */
  readonly tenantId: TenantId | null;
  readonly callId: CallId;
  /** Absent disables tool calling entirely and the agent behaves exactly as it does today. */
  readonly tools?: ToolDispatcher;
  readonly toolRegistry?: ToolRegistry;
```

Imports at the top of the same file:

```ts
import type { CallId, TenantId } from "@ansa/shared";           // extend the existing import
import { modelMessage, type ToolDispatcher, type ToolRegistry, type HoldingSpeech } from "@ansa/tools";
```

`@ansa/tools` is our own interface package, not a vendor SDK, so importing it in
orchestration code does not violate CLAUDE.md rule 2. Nothing in it imports a vendor type.

`apps/api/package.json` gains `"@ansa/tools": "workspace:*"` under `dependencies`.

**`tenantId: null` must disable tool calling.** An unregistered dialled number reaches
`runConversation` with `UNKNOWN_TENANT`, and that call may hold a conversation but must not
touch anybody's systems.

---

## Step 2 — holding speech is the filler scheduler, already built

`apps/api/src/orchestrator/orchestrator.ts`, inside `runConversation`, immediately after
`armFiller` is defined (around line 460 — it must be below `playFiller` and `cancelFiller`,
which are function expressions and do not hoist).

```ts
  /**
   * R5.4.2. The filler scheduler already covers the model gap on a timer; a tool call is
   * the same gap with a known cause, so it takes the same three registers and skips the
   * timer. `start` fires inside dispatch() before the adapter is invoked, which is the
   * entire requirement — by the time the promise settles the silence has happened.
   */
  const toolHolding: HoldingSpeech = {
    start: () => {
      cancelFiller();
      // Tier 1 (acknowledgements) is wrong here: "mm-hm" does not explain a two-second
      // pause with a reason behind it. Progress does.
      playFiller(deps.fillerTiers?.[1] ?? []);
    },
    slow: () => playFiller(deps.fillerTiers?.[2] ?? []),
    stop: () => cancelFiller(),
  };
```

Then pass it where the dispatcher is built (step 5) — the dispatcher takes the hook, the
orchestrator does not call it.

`playFiller` already refuses to fire while the agent is speaking and already keeps filler
audio out of `bytesSent` and out of the conversation history. Both behaviours are correct
for tool holding speech and neither needs changing.

---

## Step 3 — the tool loop in `respondTo`

`apps/api/src/orchestrator/orchestrator.ts`, in `respondTo` (around line 933).

Offer the tools on the request:

```ts
    const completion = deps.llm.complete({
      system: `${SYSTEM_PROMPT}\n\n${budget.instruction}`,
      messages: conversation.messages,
      maxTokens: budget.maxTokens,
      tools:
        deps.toolRegistry !== undefined && deps.tenantId !== null
          ? deps.toolRegistry.listFor(deps.tenantId)
          : undefined,
    });
```

And handle the call, beside the existing `completion.onDelta(...)`:

```ts
    completion.onToolCall((calls) => {
      if (turn?.seq !== seq) return;              // barged in; the request is void
      const dispatcher = deps.tools;
      const tenantId = deps.tenantId;
      if (dispatcher === undefined || tenantId === null) return;

      void Promise.all(
        // R5.4.4. Independent lookups run together; the tier gate is per tool, so a read
        // and a write in the same batch still behave differently from each other.
        calls.map((call) =>
          dispatcher.dispatch({ tenantId, callId: deps.callId, name: call.name, args: call.args }),
        ),
      ).then((outcomes) => {
        if (turn?.seq !== seq) return;

        for (const outcome of outcomes) {
          // What the model is told. Never optional and never softened: a failed tool
          // that reaches the model as silence becomes a success in the next sentence.
          conversation.addCaller(modelMessage(outcome));
          record.event("tool_call", {
            tenantId,
            tool: outcome.name,
            tier: outcome.tier,
            outcome: outcome.kind,
            latencyMs: outcome.latencyMs,
          });
        }

        const transfer = outcomes.find((o) => o.kind === "transfer");
        if (transfer !== undefined) {
          // Irreversible. Say the line and hand over; do not go back to the model, which
          // would be given the chance to talk itself into an alternative.
          sayNow(transfer.speech, "tool needs a human");
          return;
        }

        const confirm = outcomes.find((o) => o.kind === "confirm");
        if (confirm !== undefined) {
          // R4.3.1. The readback is spoken verbatim, not paraphrased by the model, and
          // pendingConfirmation is what the caller's next "yes" is matched against.
          pendingConfirmation = confirm;
          sayNow(confirm.speech, "tool readback");
          return;
        }

        // Reads and completed writes: the model turns the summaries into a reply. The
        // summaries are already sentences, so a failure here still degrades into speech.
        respondTo("", outcomes.map((o) => o.speech).join(" "));
      });
    });
```

`sayNow` is used rather than `sayRecovery` because a readback is a reply to what the caller
just said; arriving after the next sentence would be worse than not arriving. It already
supersedes whatever is playing and already runs everything through `forSpeech`, which is
how tool output gets normalized (R4.2 — tool results are not exempt).

---

## Step 4 — the caller's "yes"

Declare beside `let capture: CaptureState = idle;` (around line 845):

```ts
  /** The write the caller has been read and has not yet answered. One at a time. */
  let pendingConfirmation: DispatchOutcome | null = null;
```

And check it at the top of the transcript path, before `captureHandled` (around line 1288),
so a yes is consumed as an answer rather than sent to the model as conversation:

```ts
    const awaiting = pendingConfirmation;
    if (awaiting !== null && awaiting.kind === "confirm") {
      pendingConfirmation = null;
      const agreed = isAffirmative(normalise(whole));
      if (!agreed) {
        sayNow("No problem, I've left it as it is.", "confirmation declined");
        return;
      }
      void deps.tools?.dispatch({ /* same tenantId, callId, name, args */
        confirmationId: awaiting.confirmationId,
      }).then((done) => { conversation.addCaller(modelMessage(done)); sayNow(done.speech, "write done"); });
      return;
    }
```

`isAffirmative` does not exist yet. It belongs to `entity-capture` or
`conversation-director`, not to this package — a "yeah, go on" that is read as a no is an
annoyance, and one read as a yes when it was "yeah, but…" is a wrongly-changed record.
**Until it exists, only a bare "yes" should be treated as agreement.** Defaulting to no is
the safe direction and the dispatcher enforces it anyway: without the id, nothing fires.

Note the dispatch call must repeat the *same* `name` and `args`. The dispatcher fingerprints
them and refuses a confirmation whose arguments moved after the caller heard them, so
storing the original call alongside the outcome is required, not optional.

---

## Step 5 — construction, at the call site

`apps/api/src/telephony/media.gateway.ts`, in `startConversation`, just above the existing
`runConversation(stream, { … })` (around line 370).

```ts
    const toolRegistry = createToolRegistry();
    registerInternalTools(toolRegistry, policyTools(this.policyBook));

    const tools = createToolDispatcher({
      registry: toolRegistry,
      log: log.child({ tenantId: tenant?.tenantId ?? null }),
      holding: /* passed through from the orchestrator — see the note below */ undefined,
    });
```

and in the deps object:

```ts
      tenantId: tenant?.tenantId ?? null,
      callId: asCallId(stream.callId),
      tools,
      toolRegistry,
```

**One ordering wrinkle to resolve when applying this.** The holding-speech hook lives inside
`runConversation` (step 2) but the dispatcher is constructed outside it (step 5). Two ways,
pick one:

- *Preferred:* move construction inside `runConversation`, passing the gateway only the
  registry. The dispatcher is per-call anyway — its confirmation store must not be shared
  between calls — so this is the more correct shape as well as the simpler edit.
- Otherwise: give `DispatcherOptions.holding` a setter, which is worse and is only listed
  so the choice is deliberate.

The registry is per-process and can be built once in the module; the dispatcher is per-call.
A shared dispatcher would let a confirmation issued on one call be redeemed on another —
`ConfirmationStore` binds `callId` and refuses it, but building one per call means the
question never arises.

---

## What this does not wire

- **HTTP connector (route A) and MCP (route B).** Not written. `ToolAdapter` is the whole
  seam; both are one file each and neither may touch `dispatch.ts`. When they land they
  inherit tier enforcement, ceilings, holding speech, redaction and logging for free —
  that is the R5.2.0 claim and it is already tested against two routes in
  `dispatch.test.ts`.
- **A real tenant data source.** `createInMemoryPolicyBook` is a fake. `PolicyBook` is the
  interface a real one implements.
- **The credential vault (R5.2.1) and egress allowlist (R5.2.2).** They belong to the HTTP
  adapter and would be dead code today — nothing in `packages/tools` can make an outbound
  request. Redaction of credential-shaped argument keys is in place (`redact.ts`), so
  whatever the vault ends up looking like, its values do not reach a log line.
- **Circuit breakers (R5.2.3).** Per-tool hard timeouts are in; a breaker across calls is
  not, and needs somewhere to keep state per tenant endpoint. Same file as the HTTP adapter.
