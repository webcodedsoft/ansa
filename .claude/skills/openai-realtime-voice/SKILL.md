---
name: openai-realtime-voice
description: OpenAI for Ansa's phone calls — the GA Realtime session shape (session.update, audio/pcmu vs audio/pcm 24k, server_vad vs semantic_vad, keywords), the transcription models and what each one refuses, and streaming Chat Completions for the cascaded turn (tool-call fragments, abort on barge-in, prompt caching). Use when touching packages/providers/listen/openai, packages/providers/llm, apps/api/src/telephony/ws-listen-socket.ts, or the orchestrator's LLM turn; when changing TRANSCRIPTION_MODEL, TURN_DETECTION, VAD_EAGERNESS or OPENAI_SEND_PCM; when a call goes deaf, commits turns too early, or emits phantom caller text; and before picking an OpenAI model id for anything.
---

# OpenAI, as Ansa uses it

Two entirely separate surfaces, and confusing them is the first mistake:

| Surface | Where | What it does here |
|---|---|---|
| **Realtime, transcription intent** | `packages/providers/listen/openai/` | Words and turn boundaries off the carrier's μ-law socket. |
| **Chat Completions, streamed** | `packages/providers/llm/src/openai/` | The cascaded turn: system prompt + history in, deltas and tool calls out. |

Ansa does **not** run speech-to-speech. There is no `gpt-realtime-*` model in this repo, no
`session.audio.output`, no OpenAI voice. TTS is ElevenLabs, turn detection is currently
Deepgram Flux (`DEEPGRAM_*` is required at boot; see `apps/api/src/config/env.ts`). If a task
says "use the Realtime API," check whether it means transcription — it almost always does.

**Every fact below with a date was fetched on 2026-08-20.** Anything I could not verify is
marked *unverified* rather than asserted.

> **The docs moved.** `platform.openai.com/docs/*` now 301s to
> `developers.openai.com/api/docs/*`. Machine-readable indexes:
> `https://developers.openai.com/api/docs/llms.txt` and
> `https://developers.openai.com/api/reference/llms.txt`. Most guide pages have a `.md`
> twin (`.../guides/realtime-transcription.md`) that fetches far better than the HTML.

---

## 1. Rules this repo enforces

- **No vendor types outside `packages/providers/*`.** `openai@7.4.0` is a dependency of
  `packages/providers/listen/openai` **only** — check `package.json` before importing it
  anywhere. `packages/providers/llm` has no OpenAI dependency at all; it hand-rolls SSE over
  `fetch`. Do not "tidy" that by adding the SDK.
- **Arrow consts, never `function`.** `func-style: expression`. Helpers appear above first use.
- **The socket URL lives in exactly one file**: `apps/api/src/telephony/ws-listen-socket.ts`.
  The provider package never names a WebSocket library — it takes a `ListenSocket`.
- **Silence is the worst outcome.** Every failure path must end in speech. That is why
  `openListenSession` splits `onFailure` (terminal, tell the caller) from `onVendorError`
  (recoverable, log only).

---

## 2. Realtime transcription — the current wire shape

Connect (verified: `apps/api/src/telephony/ws-listen-socket.ts`, and `?intent=transcription`
confirmed current by the Realtime transcription guide, 2026-08-20):

```
wss://api.openai.com/v1/realtime?intent=transcription
Authorization: Bearer <OPENAI_API_KEY>
```

For a speech-to-speech session it is `?model=…` instead — the WebSocket guide's example is
`wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1`. Not what we open.

### The GA session document

Beta's flat `input_audio_format` is retired. Audio config nests under `session.audio.input`:

```json
{
  "type": "session.update",
  "session": {
    "type": "transcription",
    "audio": {
      "input": {
        "format": { "type": "audio/pcmu" },
        "transcription": { "model": "gpt-4o-transcribe", "language": "en" },
        "turn_detection": { "type": "semantic_vad", "eagerness": "auto" }
      }
    }
  }
}
```

This is what `encodeSessionUpdate` in `packages/providers/listen/openai/src/protocol.ts`
builds, typed as the SDK's own `SessionUpdateEvent` so a renamed field fails `typecheck`
rather than failing on a call.

### Audio formats — verbatim, and one live contradiction

From `openai@7.4.0`'s `resources/realtime/realtime.d.ts` (`RealtimeAudioFormats`) and the
Realtime conversations guide, the three variants are:

| `type` | Notes |
|---|---|
| `"audio/pcm"` | **"Only a 24kHz sample rate is supported."** `rate` is always `24000`. |
| `"audio/pcmu"` | G.711 μ-law. What Twilio hands us. |
| `"audio/pcma"` | G.711 A-law. |

**Contradiction, 2026-08-20:** the API-reference page
`developers.openai.com/api/reference/resources/realtime/client-events` still lists the *beta*
names `pcm16`, `g711_ulaw`, `g711_alaw`. The guides and the installed SDK both say
`audio/pcm` / `audio/pcmu` / `audio/pcma`. **Trust the SDK types** — they are what `typecheck`
enforces, and `toInputFormat` already matches them.

`toInputFormat` throws for any other encoding/rate pair. That is deliberate: passing the
carrier's 8 kHz through as `audio/pcm` builds a request the provider cannot honour, and the
vendor types are what surfaced it. `OPENAI_SEND_PCM=true` transcodes μ-law → 24 kHz PCM via
`muLawToPcm`; off by default because it is a hypothesis about an already-poor channel, not a
decision.

### Turn detection

Verified against the VAD guide (`/api/docs/guides/realtime-vad`) and the client-events
reference, 2026-08-20:

- `server_vad` — `threshold` (0–1, higher = needs louder audio), `prefix_padding_ms`,
  `silence_duration_ms`. `create_response` and `interrupt_response` are **conversation-mode
  only** and do nothing in a transcription session.
- `semantic_vad` — `eagerness`: `auto` (default, equivalent to `medium`), `low` ("will let the
  user take their time to speak"), `medium`, `high` ("will chunk the audio as soon as
  possible"). The reference lists `idle_timeout_ms` on this variant. **No published wait-timeout
  numbers per eagerness level** — unverified, do not quote any.
- `null` — no automatic chunking; you commit with `input_audio_buffer.commit`.
- **In a transcription session VAD only controls how audio is chunked.** It is not deciding
  whether a model replies, because no model is replying.

`TurnDetection` in `protocol.ts` models exactly these two, and `listen-session.ts` degrades to
`{ type: "server_vad", silenceMs: 700 }` on its first `error` event matching `/turn detection/i`
before the session is ready. That fallback exists because a live call went deaf for its whole
duration when a model rejected `semantic_vad` and the rejection was logged as a warning.

### `keywords`, and why it is still unwired

The transcription object accepts `model`, `prompt`, `keywords`, `languages`, and `delay`
(`minimal | low | medium | high | xhigh`). Verified 2026-08-20.

Per the file-transcription guide, `keywords` is documented under **`gpt-transcribe`**;
`gpt-4o-transcribe` and `gpt-4o-mini-transcribe` are listed as supporting `prompt` and
streaming, not `keywords`. The comment in `protocol.ts` is therefore still accurate: wiring
keyterms means changing model first.

**Do not pass keyterms as `prompt` instead.** Whisper-family models regurgitate their prompt on
silence or noise; on a live call this produced a phantom caller turn reading *"Expect these
terms: Ansa, policy, premium, naira."* which the agent then answered. The `NOTE:` in
`encodeSessionUpdate` is load-bearing.

### Events we act on

`parseEvent` pins these to `RealtimeServerEvent["type"]`, so a vendor rename breaks the build:

| Event | Becomes |
|---|---|
| `session.updated` | `ready` — flushes the pre-ready buffer |
| `error` | `error` — non-terminal by default |
| `input_audio_buffer.speech_started` (`audio_start_ms`) | `speechStart` |
| `input_audio_buffer.speech_stopped` (`audio_end_ms`) | `endOfTurn` |
| `conversation.item.input_audio_transcription.delta` (`delta`) | `interim` |
| `conversation.item.input_audio_transcription.completed` (`transcript`) | `final` |

Unknown types return `null` — a vendor adding an event must not take a call down.

Interruption events (`conversation.item.truncate` with `item_id`/`content_index`/`audio_end_ms`,
and `response.cancel`) are real and current but belong to **conversation** sessions. Ansa's
barge-in is handled in the orchestrator against ElevenLabs, not here.

---

## 3. Transcription models — what each one refuses

Verified from `/api/docs/guides/speech-to-text.md`, `/api/docs/guides/realtime-transcription.md`
and `/api/docs/models/all.md`, 2026-08-20:

| Model | Realtime | Streaming deltas | `keywords` | Notes |
|---|---|---|---|---|
| `gpt-live-transcribe` | yes (**realtime sessions only**) | yes | yes | No word timestamps, no speaker labels, **no confidence scores**. |
| `gpt-transcribe` | yes | after commit | yes | Returns detected `languages` on completion. |
| `gpt-4o-transcribe` | yes | yes (`stream=true` on files) | not documented | Supports `prompt`. |
| `gpt-4o-mini-transcribe` | yes | yes | not documented | |
| `gpt-4o-transcribe-diarize` | — | yes | — | `diarized_json`, up to 4 speaker refs. |
| `gpt-realtime-whisper` | yes | — | — | **`turn_detection` must be `null`.** |
| `whisper-1` | — | no | no | Legacy. `prompt` capped at 224 tokens; only model with `timestamp_granularities`. |

Neither `gpt-live-transcribe` nor this repo's adapter produces word-level confidence. That is a
real gap against R4.1.5 and `listen-session.ts` reports `confidence: null` rather than inventing
a number. Keep it that way.

**Two files in this repo disagree about the default model.** `apps/api/src/config/env.ts:151`
defaults to `gpt-4o-transcribe` and argues mini rendered "policy" as *apology/penalty/course*.
`.env.example` sets `TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe` and claims mini is ~120 ms
faster, and adds *"gpt-live-transcribe rejects mu-law and cannot be used here"* — which the live
docs neither confirm nor deny. Resolve this before quoting either as the repo's position, and
re-measure `gpt-live-transcribe` against μ-law before repeating the claim.

---

## 4. The cascaded LLM turn

`packages/providers/llm/src/openai/openai-llm.provider.ts` POSTs `/v1/chat/completions` with
`stream: true` and parses SSE by hand. The shapes it depends on, verified against the
Chat Completions streaming-events reference 2026-08-20:

- `choices[].delta.content` — string fragments.
- `choices[].delta.tool_calls[]` — `index`, `id`, `type: "function"`, `function.name`,
  `function.arguments`. Name arrives once on the first fragment; arguments arrive a few
  characters at a time. `index` is the only thing pairing fragments when the model asks for two
  tools at once — which is exactly what `assemble` keys on.
- `finish_reason`: `stop`, `length`, `tool_calls`, `content_filter`, `function_call` (deprecated).
- Tool definitions on Chat Completions are **nested**: `{ type: "function", function: { name,
  description, parameters } }`. The Responses API uses a flat shape with `name` at top level —
  do not copy a Responses example into this provider.

### Cancellation

`cancel()` sets `cancelled` and aborts an `AbortController`. The request signal is
`AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])` — two distinct
failures through one signal, and `cancelled` is what distinguishes a barge-in (silent) from an
8 s timeout (must reach `onError`, which becomes a spoken recovery line). Text produced after
the caller interrupted describes a reply they never heard and must not enter history.

`queueMicrotask(() => void run())` defers the request so listeners registered synchronously
after `complete()` returns are attached before anything is emitted. Removing it makes early
failures reach nobody, and the turn goes silent with no error anywhere.

### Things the repo does not send yet

All verified 2026-08-20; each is a real, cheap improvement, and none is wired:

- **`stream_options: { include_usage: true }`** — adds a final chunk carrying `usage`, including
  `usage.prompt_tokens_details.cached_tokens`. Without it every earlier chunk has `usage: null`
  and **there is no cache-hit reporting at all**.
- **`prompt_cache_key`** — caching is automatic for prompts ≥ **1,024 tokens** (a strict minimum
  on GPT-5.6+; 1,024–2,048 on earlier models). Cached input bills at **0.1×**; on GPT-5.6+ cache
  writes bill at 1.25× and the TTL is an exact 30 minutes refreshed on reuse. Reuse one key and
  keep it warm at roughly 15 requests/minute. Ansa's system prompt is five stable layers
  (`apps/api/src/prompts/compose.ts`) followed by a per-turn budget line — close to the ideal
  shape for a cache prefix, if it clears 1,024 tokens.
- **`max_completion_tokens`** — the provider sends `max_tokens: request.maxTokens ?? 120`.
  `max_completion_tokens` is the parameter that works across all current models including
  reasoning models. *Partially verified:* the reference page for Create chat completion 404'd
  on 2026-08-20 and this comes from its search summary — confirm the deprecation status before
  changing the wire field.
- **`service_tier: "fast"`** — "Fast mode", renamed from Priority Processing on 2026-07-30.
  Claims up to 2.5× faster and more consistent latency for `gpt-5.6-sol`. Cached-input discounts
  still apply; no fine-tuned models or embeddings. Per-token premium.

### Model choice

Current small/fast ids include `gpt-5.6` (sol/terra/luna), `gpt-5.4-mini`, `gpt-5.4-nano`,
`gpt-5-mini`, `gpt-5-nano`, `gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-4o-mini`. This repo's
`DEFAULT_MODEL` is still `gpt-4o-mini`, chosen for latency and flagged "revisit against quality
at Gate A" — it is now several generations behind and that revisit is overdue.

**OpenAI publishes no time-to-first-token figures.** The latency guide gives directional rules
only: *"Cutting 50% of your output tokens may cut ~50% of your latency"* and *"Cutting 50% of
your prompt may only result in a 1–5% latency improvement."* Anyone who quotes a TTFT in
milliseconds for a named model is quoting something they measured or something they made up —
in this repo, measure it (`eval/`) and write the number down with the date.

---

## 5. Failure modes, and how they present on a call

| Symptom | Cause | Where |
|---|---|---|
| Agent deaf for the whole call, one warning in the log | Model rejected the turn-detection mode; session never confirmed | `READY_TIMEOUT_MS = 6_000` fires `onFailure`; `/turn detection/i` triggers the `server_vad` fallback first |
| First word of the call missing | Audio sent before `session.updated` | `pending` buffer, capped at `MAX_PENDING_BYTES = 24_000` (3 s of μ-law), oldest dropped |
| Every latency and offset 6× too large | Byte accounting done on wire bytes with `OPENAI_SEND_PCM=true` | `bytesWritten += chunk.data.length` **before** `toWire` — carrier bytes always |
| Caller chopped mid-sentence | `server_vad` at a short `silence_duration_ms` | Prefer `semantic_vad` with `eagerness: "low"`; `VAD_SILENCE_MS` defaults to 900 |
| Agent answers something nobody said | Keyterms passed as `prompt`; model regurgitated it | Never set `prompt` on the transcription object |
| Calls ending on a vendor `error` that was harmless | Treating every `error` as terminal | `onVendorError` logs; only `onFailure` ends things |
| Tool fires with `{}` the model never chose | Malformed argument JSON run anyway | `assemble` drops it and routes to `onError` → spoken recovery |
| Turn produces both an empty assistant message and a tool result | Firing `onDone` and `onToolCall` for one turn | They are mutually exclusive by contract |

---

## 6. Things that are not what you'd guess

1. **`audio/pcm` accepts exactly one rate.** 24000. Not the carrier's 8000, not 16000. Passing
   anything else builds a request the provider cannot honour.
2. **The API reference and the guides disagree about format names right now.** The reference is
   stale beta (`g711_ulaw`); the SDK and guides are GA (`audio/pcmu`). The SDK wins.
3. **`create_response` and `interrupt_response` are inert in a transcription session.** They
   read like barge-in controls. They are not; VAD there only chunks audio.
4. **`eagerness: "auto"` is `medium`, not "pick for me".** There is no adaptive mode.
5. **`gpt-live-transcribe` is realtime-only and returns no confidence.** Switching to it for
   `keywords` support costs you the one signal the readback logic would most like to have.
6. **`gpt-realtime-whisper` forbids turn detection entirely** — `turn_detection` must be `null`.
7. **A tool call's `index` is not its position in the array.** `fragmentsFrom` falls back to the
   array position when the vendor omits `index`, because a fragment without an index is still a
   call the model asked for — but do not assume the two agree.
8. **Chat Completions nests tools under `function`; Responses does not.** Copying between the
   two APIs is the most common way this provider breaks.
9. **There is no cache-hit number unless you ask for one.** No `stream_options.include_usage`,
   no `cached_tokens`, no way to know whether caching is working.
10. **Which voices distort over μ-law is not documented anywhere I could find.** The voice list
    (`alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar`; `marin`/`cedar`
    recommended; `speed` 0.25–1.5) is verified — the μ-law degradation ranking is **unverified**
    and is anyway moot here, because Ansa's TTS is ElevenLabs.

---

## References

- `references/realtime-session.md` — the full GA session document, every field verified
  2026-08-20, plus the beta→GA rename table and the transcription-model matrix.
- `references/cascaded-completions.md` — SSE frame shapes, tool-call reassembly, cancellation
  ordering, prompt caching mechanics, and the exact diff needed to add usage reporting.
