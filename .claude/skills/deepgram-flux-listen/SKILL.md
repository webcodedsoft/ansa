---
name: deepgram-flux-listen
description: Use when integrating or debugging Deepgram speech-to-text in Ansa — Flux turn detection, the /v2/listen WebSocket, eot_threshold and eager_eot_threshold tuning, keyterm boosting, mu-law telephony audio, TurnInfo/EndOfTurn event handling, listen-socket reconnects, or when comparing Flux against Nova-3 or the OpenAI listen adapter.
---

# Deepgram Flux in Ansa

Flux is the **turn detector** on every Ansa call, and optionally also the **transcriber**.
Which of the two it is depends on `LISTEN_WORDS` (`deepgram` = one socket serving both;
`openai` = Flux for turns, OpenAI for words, composed in
`apps/api/src/telephony/composite-listen.ts`).

All API facts below were re-verified against developers.deepgram.com on 2026-08-20.
Anything marked **(repo observation)** comes from this codebase's own live-API probe on
2026-08-08 and is *not* in the vendor docs — treat those as the more reliable of the two.

## The files

| Path | What lives there |
|---|---|
| `packages/providers/listen/deepgram/src/protocol.ts` | URL building, keyterm validation, frame parsing. Pure — no socket. |
| `packages/providers/listen/deepgram/src/listen-session.ts` | Session, redial/backoff, buffering, `Transcriber`+`TurnSession` fan-out. |
| `packages/providers/listen/deepgram/src/protocol.test.ts` | Frame-parsing tests. Add here first. |
| `apps/api/src/telephony/ws-deepgram-socket.ts` | The only place `ws` meets Deepgram. Auth header lives here. |
| `apps/api/src/telephony/media.gateway.ts` (`openTurns`/`openWords`/`openListen`) | Where the URL is built from `AppConfig` and the session is opened. |
| `packages/providers/listen/turn/src/index.ts` | `TurnDetector`/`TurnSession` — the interface Flux is bent to fit. |

Vendor names (`TurnInfo`, `eot_threshold`, `flux-general-en`) must not appear outside
`packages/providers/listen/deepgram/` and `apps/api/src/telephony/ws-deepgram-socket.ts`.
CLAUDE.md rule 2. `media.gateway.ts` passes `eotThreshold`/`keyterms` — our words — into
`buildUrl`, and that is the boundary.

## The wire, in one place

```
wss://api.deepgram.com/v2/listen
  ?model=flux-general-en
  &encoding=mulaw
  &sample_rate=8000
  &eot_threshold=0.8
  &eot_timeout_ms=4000
  &keyterm=Ansa&keyterm=Adebayo&keyterm=Ikeja
```

- **`/v2` is mandatory.** `/v1/listen` serves Nova-3 and does not serve Flux.
- **Auth is `Authorization: Token <key>`, not `Bearer`.** Bearer returns 401. Deepgram's
  own quickstart uses `Token`. The OpenAI listen socket next door uses `Bearer`, so
  copying that file is the likeliest way to lose an hour. **(repo observation, and the
  vendor quickstart agrees)**
- **Audio goes as raw binary WebSocket frames.** No base64, no JSON envelope. `ws` sends a
  `Buffer` as a binary frame by default, which is exactly right.
- Hosts: `api.deepgram.com`, or `api.eu.deepgram.com` (nearer Lagos; verified to return
  an identical transcript on `flux-general-en`).

Full parameter table with ranges, defaults and every message field:
[`references/flux-parameters.md`](references/flux-parameters.md).

## Parameters that matter here

| Param | Range | Vendor default | Ansa default | Why |
|---|---|---|---|---|
| `model` | `flux-general-en`, `flux-general-multi` | required | `flux-general-en` | Multi buys no African language, costs more. |
| `encoding` | `linear16 linear32 mulaw alaw opus ogg-opus` | required | `mulaw` | What Twilio sends. |
| `sample_rate` | — | required with `encoding` | `8000` | What Twilio sends. |
| `eot_threshold` | 0.5–0.9 | **0.7** | **0.9** | Raised from 0.8 on 2026-08-23. At 0.8, a caller saying "Hi. Good morning. Uh, my name is." was committed before the name, on a call where 99% of the audio arrived. 0.9 is the ceiling; there is nowhere further to go and the next lever is the capture engine. |
| `eot_timeout_ms` | 500–60000 | **5000** | **4000** | Silence backstop, fires regardless of confidence. |
| `eager_eot_threshold` | 0.3–0.9 | unset | **deliberately unset** | See below. |
| `keyterm` | ≤100 terms, ≤500 tokens total | — | per-organization | One `keyterm=` per term. |

`eager_eot_threshold` must be **≤ `eot_threshold`** when both are set; higher is an error.

### Eager end-of-turn is off on purpose

Setting `eager_eot_threshold` turns on `EagerEndOfTurn` and `TurnResumed`. Deepgram's own
page prices it: *"trimming that last 100-200ms of end-to-end latency at the cost of 50-70%
more LLM calls"*, and *"Treat `TurnResumed` as a cancellation signal."*

R4.1.8 forbids speculative work without proven cancellation. `onEagerEndOfTurn` and
`onTurnResumed` are wired in `listen-session.ts` and currently never fire, because
`buildUrl` never sets the parameter. Before turning it on you must show that a
`TurnResumed` cancels the in-flight LLM request, tool dispatch **and** TTS synthesis — not
just that the code path exists.

## Keyterms: the silent failure

Deepgram's keyterm page warns against separating terms with commas or semicolons: they are
treated as literal characters, not delimiters. **(repo observation: the comma-joined
control connected happily with a 101 and returned exactly the no-keyterm transcript — no
error anywhere.)**

That is why `assertUsableKeyterms` throws at construction rather than trusting the caller:

```ts
export const assertUsableKeyterms = (keyterms: readonly string[]): void => {
  for (const term of keyterms) {
    if (/[,;:]/.test(term)) throw new Error(/* … */);
    if (term.trim().length === 0) throw new Error("Empty keyterm");
  }
};
```

Multi-word phrases are fine — `URLSearchParams` encodes the space. Limits: up to 100
terms, 500 tokens per request (beyond that returns an error).

**Keyterms are not free accuracy.** `docs/STACK_DECISION.md` records that on
`control-sikiru.ulaw`, keyterm boosting *corrupted* a name that was not in the list, three
runs each way, perfectly deterministic. Boost the vocabulary a caller will actually say;
do not dump a dictionary in.

## Messages

Server → us:

- `Connected` — handshake. Ignored.
- `TurnInfo` — everything that matters. Carries `event`, `transcript`, `words[]`,
  `end_of_turn_confidence`, `turn_index`, `audio_window_start`/`audio_window_end`.
- `ConfigureSuccess` / `ConfigureFailure` — replies to a mid-stream `Configure`. We never
  send one, so `parseEvent` returns `null` for both.
- `FatalError` — documented, with `code` and `description`.

`TurnInfo.event` is one of `StartOfTurn`, `Update`, `EagerEndOfTurn`, `TurnResumed`,
`EndOfTurn`. State machine: `Initial —StartOfTurn→ TurnOngoing —EagerEndOfTurn→
AwaitingEnd —EndOfTurn→ Initial`, with `TurnResumed` going back to `TurnOngoing`. `Update`
emits roughly every 0.25s of audio and changes no state. `turn_index` increments
immediately after `EndOfTurn`.

**Docs list only `FatalError`; this repo observed a fatal error arriving as
`type: "Error"`.** `parseEvent` accepts both and reads `description` then `message`. Do not
"tidy" the `Error` branch away — losing it means a fatal error is parsed as `null` and the
call goes deaf in silence.

`parseEvent` returns `null` for anything unrecognised. That is deliberate: a vendor adding
an event type must not take a call down.

## Ordering: turn event first, then transcript

Flux delivers the turn boundary and the final transcript in the **same frame**, so the
emission order is ours to choose. `listen-session.ts` emits the turn event first:

```ts
case "endOfTurn": {
  const t: Transcript = { text: event.text, words: toWords(event.words),
                          confidence: meanConfidence(event.words), offsetMs: streamOffsetMs() };
  for (const l of endOfTurn) l({ offsetMs: streamOffsetMs() });
  if (event.text.length > 0) for (const l of final) l(t);
  return;
}
```

The orchestrator starts its `stt_final` timer on the turn event and stops it on the
transcript. Transcript-first measured each turn against the *previous* one — a live call
reported 12.7s for a stage that actually takes none — and armed the thinking-filler at the
wrong moment. Getting the transcript at end-of-turn with no wait is this provider's real
advantage; the ordering should show that as ~0ms rather than hide it.

## The offset clock is ours, not theirs

```ts
const streamOffsetMs = (): number => Math.round(bytesWritten / BYTES_PER_MS_MULAW_8K);
```

`TurnInfo` carries `audio_window_start`/`audio_window_end`, and **their audio clock runs
270–300ms behind bytes written, consistently (repo observation).** The orchestrator
correlates transcripts against turn events on `offsetMs` and matches echo-suppressed
segments by *exact equality* — a drifting clock breaks both. Count bytes yourself.

## Reconnects

A dropped WebSocket cannot be reopened, only replaced, so `openDeepgramSession` takes a
*factory*, not a socket. Four redials on `[250, 500, 1000, 2000]` ms, then `onFailure`.

- `redials` is never reset on a successful reopen. Four drops in one call is an outage, not
  four blips, and redialling forever hides it behind an agent that hears every other
  sentence.
- Audio written while down goes into the same bounded 24 000-byte (3s) buffer that covers
  the pre-open window and is flushed on reopen. Past three seconds the words are too old to
  act on; dropping the oldest is the honest failure.
- Flux is the *only* source of turn events. A socket that dies at second forty takes the
  agent's ability to know the caller stopped talking with it. There is no degraded mode —
  do not invent one.

Registering the `error` handler *before* anything else in `ws-deepgram-socket.ts` is
load-bearing: an unhandled `'error'` on a `ws` client throws and kills the process, taking
every concurrent call with it.

## Adding to the adapter — the idiom

Arrow consts, never `function` (`func-style: expression`, enforced by lint). Expressions do
not hoist, so a helper goes above its first use.

```ts
// packages/providers/listen/deepgram/src/protocol.ts
const readLanguages = (raw: unknown): readonly string[] =>
  Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
```

Never widen `DeepgramEvent` with a vendor-shaped field. Map it to something the
orchestrator already understands, or add it to `Transcript`/`TurnEvent` in
`packages/providers/listen/{transcriber,turn}` first.

## Things that are not what you'd guess

1. **`Token`, not `Bearer`.** 401 with no other clue.
2. **mu-law at 8000 works on Flux.** Deepgram's encoding page now lists `mulaw` under
   Flux's supported raw formats, but no Deepgram *example* anywhere uses the mu-law/8000
   pair. This repo proved it on the live API (101, `Connected`, correct transcript) before
   the docs said so. Do not transcode to PCM "to be safe" — the repo measured end-of-turn
   at **278ms under mu-law against 1367ms under PCM 16k** on the same waveform.
3. **A keyterm with a comma boosts nothing, silently.** No error, no warning, correct-looking
   transcript.
4. **`audio_window_end` is not your byte clock.** 270–300ms behind.
5. **A fatal error may arrive as `"Error"`, not `"FatalError"`.**
6. **`words[]` entries carry `start`/`end` in the published schema but the repo maps them to
   `startMs: 0, endMs: 0`.** The schema marks both *optional*; this codebase observed them
   absent and chose not to invent timings. If you need word timings, verify on a live
   mu-law/8k call first — do not trust the schema and do not trust the zeros.
7. **160-byte/20ms Twilio frames need no coalescing.** Verified identical to 80ms chunks.
   Forward them untouched.
8. **There is a mid-stream `Configure` message** (`{"type":"Configure","thresholds":{…},
   "keyterms":…}`) that can change thresholds and keyterms without reconnecting. Ansa does
   not use it. If per-turn keyterm changes ever matter, this is the door — not a redial.
9. **Flux is more expensive than Nova-3 streaming** (~$0.0065/min vs ~$0.0048/min pay-as-you-go
   at the time of writing) and running Flux *plus* OpenAI for words doubles the listen bill.
   `media.gateway.ts` logs `listenProvider` per call for exactly this reason.

## Nova-3 vs Flux

| | Nova-3 | Flux |
|---|---|---|
| Endpoint | `wss://api.deepgram.com/v1/listen?model=nova-3` | `wss://api.deepgram.com/v2/listen?model=flux-general-en` |
| Message | `{"type":"Results", …}` | `{"type":"TurnInfo", "event":…}` |
| Turn detection | you build it (`endpointing`, `utterance_end_ms`, `vad_events`) | model-native state machine |
| Interims | `interim_results=true` | `Update` events, ~every 0.25s |
| Keyterms | `keyterm` (Nova-3 only; Nova-2 uses `keywords`) | `keyterm` |
| Barge-in | your VAD | `StartOfTurn` |

Do not reach for Nova-3 to get a feature Flux lacks. If Flux cannot satisfy
`TurnSession`, that is information about Flux — surface it, do not reshape the interface.

## Debugging a live call

- `media.gateway.ts` logs `turn detection via deepgram flux` with model, host, both
  thresholds and keyterm **count** (never the terms — they can be caller data).
- Every call writes the carrier's raw mu-law to `recordings/` when configured. Replaying
  one file through two providers is the only way to separate a provider problem from an
  encoding one.
- Agent deaf mid-call → look for four redials then `onFailure`, not for a parse bug.
- Agent talks over the caller → `eot_threshold` too low, or `StartOfTurn` is being eaten by
  the orchestrator's echo guard.
- Agent waits forever after the caller stops → `eot_timeout_ms`, and check that audio is
  still being written (`bytesWritten` drives everything).
