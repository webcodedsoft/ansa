# Deepgram Flux — full reference

Verified against developers.deepgram.com on **2026-08-20**. Sources fetched:
`/reference/speech-to-text/listen-flux`, `/docs/flux/configuration`, `/docs/flux/state`,
`/docs/flux/quickstart`, `/docs/flux/voice-agent-eager-eot`, `/docs/flux/nova-3-migration`,
`/docs/flux/feature-overview`, `/docs/keyterm`, `/docs/encoding`, `/docs/sample-rate`,
`deepgram.com/pricing`.

## Endpoint

```
wss://api.deepgram.com/v2/listen
wss://api.eu.deepgram.com/v2/listen      # EU region
```

Header: `Authorization: Token <DEEPGRAM_API_KEY>` — **`Token`, not `Bearer`**.
Audio: raw binary WebSocket frames.

## Query parameters

| Parameter | Type | Allowed values | Default | Notes |
|---|---|---|---|---|
| `model` | string | `flux-general-en`, `flux-general-multi` | *required* | |
| `encoding` | string | `linear16`, `linear32`, `mulaw`, `alaw`, `opus`, `ogg-opus` | *required for raw audio* | Omit for containerized audio (WAV/Ogg/WebM). |
| `sample_rate` | int | — | *required when `encoding` is set* | |
| `eot_threshold` | float | 0.5 – 0.9 | `0.7` | Confidence required to emit `EndOfTurn`. Higher = fewer false positives, slightly more latency. |
| `eot_timeout_ms` | int | 500 – 60000 | `5000` | Silence backstop; fires regardless of confidence. Docs suggest 7000–10000 for pause-prone speakers, 3000–4000 for rapid response. |
| `eager_eot_threshold` | float | 0.3 – 0.9 | unset (eager disabled) | Enables `EagerEndOfTurn` + `TurnResumed`. **Must be ≤ `eot_threshold` if both set**, else error. |
| `keyterm` | string, repeatable | plain terms only | — | One parameter per term. Up to 100 terms; 500 tokens per request. |
| `language_hint` | string or array | language codes | — | **Only valid with `flux-general-multi`.** |
| `profanity_filter` | bool | `true`, `false` | `false` | |
| `numerals` | bool | `true`, `false` | `false` | Converts written numbers to numeric form. |
| `redact` | string | `numbers`, `aggressive_numbers` | — | Only these two are supported on Flux. |
| `mip_opt_out` | bool | — | — | Model Improvement Program opt-out. |
| `tag` | string | — | — | Free-form label for usage reporting. |

Notes for Ansa: `numerals` is off and should stay off — `packages/normalizer` owns number
handling and prompting/vendor flags are not a substitute (CLAUDE.md). `redact` is not a
substitute for the tool-security tests either.

## Server → client messages

### `Connected`
```json
{ "type": "Connected", "request_id": "…", "sequence_id": 0 }
```

### `TurnInfo`
```json
{
  "type": "TurnInfo",
  "request_id": "ad12514a-0d38-4f7e-8fba-cce10d8f174c",
  "sequence_id": 11,
  "event": "EndOfTurn",
  "turn_index": 0,
  "audio_window_start": 0,
  "audio_window_end": 1.3,
  "transcript": "Hello, how are you?",
  "words": [
    { "word": "Hello,", "confidence": 0.96, "start": 0, "end": 0.18 }
  ],
  "end_of_turn_confidence": 0.86,
  "languages": ["en"],
  "languages_hinted": ["en"]
}
```

Schema per the API reference: `words[].start` and `words[].end` are **optional**;
`word` and `confidence` are always present. `languages` / `languages_hinted` appear on
`flux-general-multi`.

`event` ∈ `Update` | `StartOfTurn` | `EagerEndOfTurn` | `TurnResumed` | `EndOfTurn`.

### `ConfigureSuccess`
Fields: `type`, `request_id`, `sequence_id`, `thresholds` (`eager_eot_threshold`,
`eot_threshold`, `eot_timeout_ms`), `keyterms`, `language_hints`.

### `ConfigureFailure`
Fields: `type`, `request_id`, `sequence_id`.

### `FatalError`
Fields: `type`, `sequence_id`, `code`, `description`.

> **Repo observation (2026-08-08):** a fatal error was seen arriving with
> `"type": "Error"`. `parseEvent` accepts both `Error` and `FatalError`, and reads
> `description` falling back to `message`.

## Client → server control messages

### `Configure` (mid-stream)
```json
{
  "type": "Configure",
  "thresholds": { "eager_eot_threshold": 0.6, "eot_threshold": 0.8, "eot_timeout_ms": 4000 },
  "keyterms": ["Ansa", "Ikeja"],
  "language_hints": ["en"]
}
```

### `CloseStream`
```json
{ "type": "CloseStream" }
```
Flushes the final turn, then tears down. Ansa closes the socket instead; if a trailing
partial turn ever matters, this is the correct way to get it.

`KeepAlive` is **not documented** for `/v2/listen`. Unverified whether the v1 keepalive
works here.

## State machine

```
Initial (Ready)
   │ StartOfTurn
   ▼
TurnOngoing (Speaking)  ◄──── TurnResumed ────┐
   │ EagerEndOfTurn                            │
   ▼                                           │
AwaitingEnd (Processing) ──────────────────────┘
   │ EndOfTurn
   ▼
Initial
```

- `Update` messages emit continuously (~every 0.25s of audio) and change no state.
- `turn_index` increments **immediately following** an `EndOfTurn`.
- The `EndOfTurn` transcript always matches the immediately preceding `EagerEndOfTurn`
  transcript.
- `EagerEndOfTurn` always contains a nonempty transcript.
- `TurnResumed` only ever follows `EagerEndOfTurn`.

## Eager end-of-turn — vendor's own cost statement

> "Good for trimming that last 100-200ms of end-to-end latency at the cost of 50-70% more
> LLM calls."

> "Treat `TurnResumed` as a cancellation signal. Be ready to discard or revise any LLM
> replies in progress."

## Audio chunking

Deepgram's Flux agent guide recommends "~80ms audio chunks" at 16 kHz (≈2 560 bytes) and
uses 4 096-byte chunks in its examples.

**Repo measurement (2026-08-08):** Twilio's native 20ms / 160-byte mu-law frames produce an
*identical* transcript to coalesced 80ms chunks. No coalescing layer is needed for
telephony audio.

## Keyterm prompting

- "Instantly increase accuracy and recognition of up to 100 important terminology, product
  and company names, industry jargon, phrases and more."
- "To pass multiple separate keyterms, repeat the `keyterm` parameter."
- Multi-word phrases: URL-encode the spaces (`%20` or `+`). `URLSearchParams.append` does
  this for you.
- "Key Terms are limited to 500 tokens per request; anything beyond that will return an
  error."
- Supported on Nova-3 and Flux. Nova-2 and earlier use the older `keywords` feature.
- The docs warn against separating terms with commas or semicolons — they are literal
  characters, not delimiters.

## Encoding / sample rate

> "Flux supports `linear16`, `linear32`, `mulaw`, `alaw`, `opus`, and `ogg-opus` for
> non-containerized/raw audio. Flux also supports containerized formats: `linear16` in WAV
> containers, `opus` in Ogg containers, and `opus` in WebM containers (omit the `encoding`
> parameter for containerized audio)."

> "If you are using the Encoding feature, the Sample Rate feature is also required."

The docs do not state valid sample rates per codec, and give no Flux-specific
recommendation on `/docs/sample-rate`. The quickstart examples use `linear16` at 16000.
**mu-law at 8000 is proven working in this repo** and is what Twilio delivers.

## Pricing (deepgram.com/pricing, 2026-08-20, "limited-time promotional rates")

| Model | Pay As You Go | Growth |
|---|---|---|
| Flux English | $0.0065/min (reg. $0.0077) | $0.0057/min (reg. $0.0065) |
| Flux Multilingual | $0.0078/min | $0.0068/min |
| Nova-3 Monolingual | $0.0048/min (reg. $0.0077) | $0.0042/min (reg. $0.0065) |
| Nova-3 Multilingual | $0.0058/min (reg. $0.0092) | $0.0050/min (reg. $0.0078) |

Minimum billing increments and connection minimums are **not stated** on the pricing page.

## Nova-3 → Flux migration deltas

| | Nova-3 | Flux |
|---|---|---|
| URL | `/v1/listen?model=nova-3` | `/v2/listen?model=flux-general-en` |
| Message type | `"Results"` | `"TurnInfo"` |
| Extra fields | — | `event`, `turn_index`, `end_of_turn_confidence`, word-level timestamps |
| Endpointing | manual (`endpointing`, `utterance_end_ms`, `vad_events`) | `eot_threshold`, `eot_timeout_ms`, `eager_eot_threshold` |
| Turn state | you build it | built-in state machine |

The migration page does not enumerate which Nova-3 parameters are removed; it says the
functionality is handled natively by Flux's turn detection. Treat any Nova-3 parameter as
unsupported on `/v2/listen` until the reference page lists it.
