# Streaming Chat Completions, as the cascaded turn

Fetched **2026-08-20** from:
- `https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events`
- `https://developers.openai.com/api/docs/guides/function-calling.md`
- `https://developers.openai.com/api/docs/guides/prompt-caching.md`
- `https://developers.openai.com/api/docs/guides/latency-optimization.md`
- `https://developers.openai.com/api/docs/guides/fast-mode.md`
- `https://developers.openai.com/api/docs/guides/streaming-responses.md`
- `https://developers.openai.com/api/docs/models/all.md`

`https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create`
**404s**; parameter-level claims sourced only from its search summary are marked *partially
verified* below.

---

## 1. The frame

Every SSE line is `data: {…}` or `data: [DONE]`. A frame that carries neither content nor a tool
fragment (keepalives, the role announcement, `[DONE]`) is skipped by `parseSseDelta`, which
returns `null`.

```jsonc
{
  "choices": [{
    "index": 0,
    "delta": {
      "role": "assistant",              // first chunk only
      "content": "…",                   // text fragment
      "tool_calls": [{
        "index": 0,
        "id": "call_…",
        "type": "function",
        "function": { "name": "…", "arguments": "{\"par" }
      }]
    },
    "finish_reason": null
  }],
  "usage": null                          // non-null only on the final chunk, and only if asked
}
```

`finish_reason` values: `stop`, `length`, `tool_calls`, `content_filter`, `function_call`
(deprecated).

Chunk boundaries do not respect line boundaries. `openai-llm.provider.ts` keeps the trailing
partial in `buffer` and only parses complete lines:

```ts
buffer += decoder.decode(value, { stream: true });
const lines = buffer.split("\n");
buffer = lines.pop() ?? "";
```

Deleting that `pop()` produces a bug that only appears under network conditions you cannot
reproduce locally.

---

## 2. Tool-call reassembly

The name arrives once, on the first fragment of a call. The arguments arrive a few characters at
a time. `index` is the correlation key when the model asks for two tools at once.

```ts
for (const fragment of frame.toolCalls) {
  const held = pendingCalls.get(fragment.index) ?? { name: null, args: "" };
  pendingCalls.set(fragment.index, {
    name: fragment.name ?? held.name,
    args: held.args + fragment.argsFragment,
  });
}
```

Three rules the existing code encodes and a change should not lose:

1. **A call whose arguments do not parse is dropped, not run with `{}`.** A tool invoked with
   arguments the model did not choose is worse than a tool not invoked. `assemble` collects those
   into `malformed`, and if nothing survives, the turn goes to `onError` — which the orchestrator
   turns into a spoken recovery line rather than silence.
2. **A tool with no parameters streams no arguments at all.** `text === "" ? {} : JSON.parse(text)`.
   That is not malformed.
3. **`onDone` and `onToolCall` are mutually exclusive for a turn.** Firing both puts an empty
   assistant turn into the conversation beside the tool result.

### Definition shape — Chat Completions vs Responses

Chat Completions (what this provider sends):

```json
{ "type": "function",
  "function": { "name": "…", "description": "…", "parameters": { } } }
```

Responses / Realtime (flat, plus `strict`):

```json
{ "type": "function", "name": "…", "description": "…",
  "parameters": { }, "strict": true }
```

`strict: true` requires `additionalProperties: false` on every object, every property listed in
`required`, and optional fields expressed as `type: ["string", "null"]`. Responses normalises
toward strict by default; **Chat Completions stays non-strict unless you set it.** Ansa does not
set it — `parameters` is opaque JSON Schema passed straight through from `@ansa/tools`.

`tool_choice`: `"auto"` (default), `"required"`, `"none"`, `{"type":"function","name":"X"}`, or
an `allowed_tools` subset. `parallel_tool_calls: false` caps a turn at one tool.

An empty `tools: []` is omitted rather than sent — some deployments reject it, and a call with no
tools registered must behave exactly as it did before tools existed.

---

## 3. Cancellation and deadlines

```ts
signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
```

Both failures arrive as the same `AbortError`. `cancelled` is the flag that tells them apart:

- **cancelled === true** — barge-in. Return silently. No `onError`, no `onDone`, no deltas after
  the flag was set. The caller interrupted; whatever the model was saying never happened.
- **cancelled === false** — the 8 s deadline. Must reach `onError` so the orchestrator can speak.

The reader is also cancelled explicitly mid-loop (`await reader.cancel().catch(...)`) so the
socket does not sit there draining tokens nobody will hear and nobody wants to pay for.

`queueMicrotask(() => void run())` — the request is deferred one microtask so that listeners
registered synchronously after `complete()` returns are attached before anything is emitted.
Without it, an early failure reaches nobody and the turn goes silent with no error anywhere.

---

## 4. Prompt caching

| Fact | Value |
|---|---|
| Trigger | Automatic for prompts **≥ 1,024 tokens**. Strict minimum on GPT-5.6+; earlier models 1,024–2,048. |
| Cached | System, developer, user and assistant messages; images; tools; structured-output schemas; audio — when identical across requests. |
| Routing key | `prompt_cache_key`. Reuse the same key across requests. |
| Keeping it warm | Roughly **15 requests/minute per key** to avoid misses. |
| TTL | GPT-5.6+: exact 30 minutes, refreshed on reuse. Earlier: 5–10 minutes in memory, max 1 hour; up to 24 hours with extended retention where supported. |
| Price | Cached input at **0.1×**. GPT-5.6+ cache *writes* at 1.25×. |
| Reporting | Chat Completions: `usage.prompt_tokens_details.cached_tokens`. Responses: `usage.input_tokens_details.cached_tokens`. |
| Realtime API | Not mentioned in the caching guide. **Unverified.** |

Caching keys on an exact prefix. Ansa's prompt is built by `composeSystemPrompt` as five layers
in a fixed order (identity, base conduct, locale, fenced organisation text, task layer,
guarantees), with the per-turn budget line appended afterwards by `orchestrator/turn-budget.ts`.
That is already the right shape — stable prefix, volatile suffix — provided nothing per-call
sneaks into an early layer. `identityLine(organisation.name)` is per-organisation, which means the
cache partitions per organisation; that is correct behaviour, not a bug, but it changes the
warm-traffic arithmetic.

**Nothing measures this today.** `stream_options: { include_usage: true }` is not sent, so
`usage` is `null` on every chunk and `cached_tokens` is unobtainable.

### The minimal diff to get visibility

In the request body of `createOpenAiLlm`:

```ts
stream: true,
stream_options: { include_usage: true },
```

and in the read loop, a branch that picks `usage` off the final frame. `parseSseDelta` currently
returns `null` for any frame without `choices` — and the usage chunk has an **empty** `choices`
array — so it would need widening before the number could be read at all.

---

## 5. Latency

The guide is directional only. Verbatim:

- *"Cutting 50% of your output tokens may cut ~50% of your latency."*
- *"Cutting 50% of your prompt may only result in a 1–5% latency improvement"* — unless the
  context is very large.
- Streaming is *"the single most effective approach"* for perceived latency.
- Model size is the primary factor in tokens-per-second.

**OpenAI publishes no per-model time-to-first-token figures.** Any TTFT number in a design
document here must come from `eval/` with a date attached.

`service_tier: "fast"` (aliased `"priority"`; renamed from Priority Processing on 2026-07-30):
up to 2.5× faster and more consistent latency, demonstrated on `gpt-5.6-sol`. Supported on
Responses and Chat Completions. Not for fine-tuned models or embeddings. Cached-input discounts
still apply. Per-token premium; regional availability varies. A ramp-rate limit applies above
1M TPM with >50% TPM growth in 15 minutes.

---

## 6. Model catalogue, small/fast end

`gpt-5.6` (sol / terra / luna), `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.1`,
`gpt-5-mini`, `gpt-5-nano`, `gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-4o-mini`.

Marked legacy or deprecated: GPT-4.5 Preview (deprecated), `gpt-3.5-turbo` (legacy), `o3` and
`o4-mini` (succeeded by GPT-5 / GPT-5 mini).

`DEFAULT_MODEL` in `openai-llm.provider.ts` is `"gpt-4o-mini"`.

---

## 7. `max_tokens` vs `max_completion_tokens`

*Partially verified.* The Create-chat-completion reference 404'd on 2026-08-20. Its search
summary states that `max_completion_tokens` "works with all models, even o-series which use
hidden thinking tokens", and the community and guide material consistently treat `max_tokens` as
the older parameter.

The provider sends `max_tokens: request.maxTokens ?? 120`. Before changing it, fetch the
reference page and confirm — and remember what the ceiling is *for*: it is the second line of
defence behind "a voice turn is two sentences" (R6.3), not a cost control. On a reasoning model,
`max_completion_tokens` counts reasoning tokens too, so the same number buys fewer spoken words.
