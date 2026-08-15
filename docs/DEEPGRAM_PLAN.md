<!-- Produced by a verified multi-agent research pass on 2026-08-07/08. Every claim is
     marked [V] verified in a primary source, [I] inference, or [U] undocumented.
     Nothing here has been proven against the live API yet — Probe A does that. -->

# Deepgram Flux — implementation plan

**Epistemic key used throughout:** `[V]` = verified in a primary Deepgram source (URL given). `[I]` = our inference or judgement, not a vendor statement. `[U]` = undocumented in either direction; must be settled by a probe or a call.

Three corrections carried in from verification, before anything else:

- **`Authorization: Token`, not `Bearer`.** `/Users/webcoded/Documents/Companies/Personal/ansa/apps/api/src/telephony/ws-listen-socket.ts:13` currently reads `` Authorization: `Bearer ${apiKey}` ``. Copying that file and forgetting the keyword is the single likeliest way to lose an hour. `Bearer` at Deepgram is valid only for short-lived JWTs from `/auth/grant`, which we are not using. [V] https://developers.deepgram.com/docs/authenticating
- **R4.2.4 is a TTS-output requirement.** `PRD.md` §4.2 reads "TTS output format MUST match telephony natively (μ-law 8kHz)". There is no R-number in §4.1 requiring native μ-law STT *input*. Stop citing R4.2.4 for transcriber input; it is a real goal with no requirement number. [V] `/Users/webcoded/Documents/Companies/Personal/ansa/PRD.md`
- **The `replace` doc is at `/docs/find-and-replace`;** `/docs/replace` 404s. Fix before it reaches STACK_DECISION.

---

## 1. The recommended configuration

**Model:** `flux-general-en` — the English-only Flux model, on `/v2/listen`. [V] https://developers.deepgram.com/docs/flux/quickstart ("Flux requires the `/v2/listen` endpoint — Using `/v1/listen` will not work with Flux.")

**Language setting: none. Send no language parameter at all.** `/v2/listen` has no `language` query parameter. `language_hint` (singular in the URL; `language_hints` plural inside `Configure`) exists only for `flux-general-multi`. `flux-general-en` exposes **no dialect knob whatsoever** — no `en-NG`, no accent hint, nothing between `en-GB` and `en-IN`. [V] https://developers.deepgram.com/docs/flux/language-prompting, https://developers.deepgram.com/docs/models-languages-overview

That absence is the plan's central fact: there is no configuration that makes Flux better at Nigerian speech. Everything on priority 6 is empirical.

### The URL, to paste

```
wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=mulaw&sample_rate=8000&eot_threshold=0.8&eot_timeout_ms=3000&keyterm=Ansa&keyterm=policy&keyterm=policy%20number&keyterm=premium&keyterm=naira&keyterm=claim&keyterm=renewal&keyterm=excess&keyterm=underwriter&keyterm=cover
```

### The auth header

```
Authorization: Token ${DEEPGRAM_API_KEY}
```

### Every parameter, and why that value

| Param | Value | Status |
|---|---|---|
| `model` | `flux-general-en` | [V] `ListenV2Model` enum is exactly `[flux-general-en, flux-general-multi]` (asyncapi.json). Multi buys ten languages, none African, and a `language_hint` we cannot usefully set. |
| `encoding` | `mulaw` | [V] `ListenV2Encoding` enum = `linear16, linear32, mulaw, alaw, opus, ogg-opus`. Required for raw headerless audio. |
| `sample_rate` | `8000` | [V] in the raw-audio matrix (`8000, 16000, 24000, 44100, 48000`) — https://developers.deepgram.com/docs/flux/quickstart and the 2025-10-16 changelog https://developers.deepgram.com/changelog/2025/10/16, which is the **only** page enumerating 8000 for Flux. Note the same table annotates it "**Required** (`16000` recommended)" — a documented steer away from our config. Deepgram also states "If your telephony audio is band-limited to 8 kHz, upsampling to a higher rate provides no benefit" [V] https://developers.deepgram.com/guides/deep-dives/audio-preprocessing-barge-in — so passing Twilio's bytes through is the right move, but we are running Flux at its least-demonstrated setting. **No Deepgram code example anywhere uses `mulaw` at `8000` on Flux.** |
| `eot_threshold` | `0.8` | [I] Interpolated between the documented Simple preset (`0.7`, also the default) and High-Reliability (`0.85`). Range 0.5–0.9. [V] https://developers.deepgram.com/docs/flux/configuration. Rationale: our own false-EOT history (server_vad 500ms chopped a 10.3s utterance) argues above default; but our `semantic_vad`/`auto` state is currently *good* (6 of 6 turns played, 0 spurious barge-ins) and 0.85 spends latency we may not need to. Move to 0.85 the first time a caller is chopped; to 0.7 if turns feel slow. |
| `eot_timeout_ms` | `3000` | [I] **Deliberately below the documented 5000 default and well below High-Reliability's 8000.** This is a silence backstop that fires regardless of confidence. STACK_DECISION already records that `eagerness: low` waiting 7.6s on a greeting was *worse* than being chopped — the caller repeated themselves to check the line was alive. An 8000ms backstop re-buys that failure. Range 500–60000. [V] same page. |
| `eager_eot_threshold` | **omit** | [V] No default; setting it is the sole gate on `EagerEndOfTurn` and `TurnResumed`. Deepgram pairs eager mode with "trimming that last 100-200ms of end-to-end latency at the cost of 50-70% more LLM calls" [V] https://developers.deepgram.com/docs/flux/voice-agent-eager-eot. At `llm_first_token` 763–1186ms on a Nigeria→US path, a 50-70% increase in concurrent LLM calls to buy ≤250ms is a bad trade, and R4.1.8 forbids shipping it until `TurnResumed` provably cancels LLM + TTS. Ship it off; enable it as a measured experiment later. |
| `keyterm` | repeated, one per term | [V] https://developers.deepgram.com/docs/keyterm. Multi-word phrases use `%20` or `+`. **Hard cap 500 tokens per request; beyond that the API errors.** Guidance: "the most important 20-50 terms". |
| `mip_opt_out` | **omit for now** | [V] present in the `/v2/listen` query list (asyncapi.json). [U] Its accepted value shape was not verified. Add it after the probe proves the base URL, and verify the value then — do not put an unverified param in the probe that must isolate the mulaw+8000 question. |

### Keyterm rules the adapter must enforce in code

Malformed keyterm syntax **fails silently** — the API accepts it, treats it as one literal term, and boosts nothing. Stated twice on /docs/keyterm, once in the `ListenV2Keyterm` AsyncAPI schema, once on /docs/keywords. [V]

- **Do:** `?keyterm=policy&keyterm=premium`, `?keyterm=policy%20number`
- **Never:** `keyterm=policy,premium` · `keyterm=policy;premium` · `keyterm=policy:0.15`
- **There is no intensity parameter.** Unlike legacy `keywords` (Nova-2 and older only, absent from `/v2/listen` entirely), `keyterm` accepts plain terms. If boosting underperforms at 8kHz, the only knobs are term selection and casing — not weight. [V]

### What Deepgram sends back

One socket, JSON text frames. `Connected` → `TurnInfo`(×N) → `ConfigureSuccess`/`ConfigureFailure` → `FatalError`. Every `TurnInfo` **requires** `transcript`, `words[]` (each word requires `word` and `confidence`), and `end_of_turn_confidence`, discriminated by `event` ∈ `Update | StartOfTurn | EagerEndOfTurn | TurnResumed | EndOfTurn`. [V] https://developers.deepgram.com/reference/speech-to-text/listen-flux

Three gotchas that will cost time if missed:

1. **`FatalError` carries `type: "Error"`, not `type: "FatalError"`.** Switch on the field value.
2. **The state diagram on /docs/flux/state is incomplete.** It has no `TurnOngoing → Initial : EndOfTurn` edge, implying `EndOfTurn` only follows `EagerEndOfTurn`. It does not — "By default, Flux only emits `Update`, `StartOfTurn`, and `EndOfTurn`" [V] https://developers.deepgram.com/docs/flux/nova-3-migration. Code against that sentence.
3. **There is no `audio_window` field.** It is `audio_window_start` and `audio_window_end`, two floats, **in seconds**, on an audio-relative clock. Our `TurnEvent.offsetMs` is milliseconds since the media stream opened. Different unit and [U] unverified origin.

---

## 2. The first empirical probe

Write it in the scratchpad, not the repo. It is throwaway measurement, it must not enter `pnpm lint`/`typecheck`, and its output belongs in `docs/STACK_DECISION.md` rather than in git as code. A single Node ESM file using `ws` (already a workspace dependency via `/Users/webcoded/Documents/Companies/Personal/ansa/tools/fake-carrier`), no monorepo imports, no SDK.

> **Never use `@deepgram/sdk`.** Open issue #451: the v5 JS SDK cannot send multiple `keyterm` values for Flux. We build the URL ourselves over raw `ws`, so it does not reach us — but it is a live example of an SDK not matching its own API contract, which is exactly today's lesson.

**Split it in two.** Probe A can run on any μ-law audio and answers the structural questions tonight. Probe B needs real caller audio and answers the only question that matters.

### Probe A — protocol acceptance (any μ-law 8kHz audio, even TTS)

The harness rule from STACK_DECISION applies and is non-negotiable: **stream in real time and stream silence.** A turn detector closes a turn when it *hears* silence; stopping the stream is not the same thing and yields nothing. Append ~2s of μ-law silence (`0xFF`) after the speech and keep sending it, paced by wall clock.

Assertions, in the order they should be checked:

| # | Assert | Why this one |
|---|---|---|
| A1 | With `Authorization: Bearer <key>`, the upgrade **fails** (non-101). With `Authorization: Token <key>`, it **succeeds (101)**. | Proves the keyword directly rather than trusting a doc, and inoculates against the `Bearer` already sitting in `ws-listen-socket.ts:13`. |
| A2 | On the **full composed URL** (model + `mulaw` + `8000` + N `keyterm`s + thresholds), the first server frame is `{"type":"Connected","request_id":…,"sequence_id":0}`. | **The load-bearing one.** Each value is individually documented; the *combination* appears on no Deepgram page. This is the exact shape of today's Intron wall. |
| A3 | Writing 640-byte chunks paced at 80ms, at least one `TurnInfo` with `event:"StartOfTurn"` arrives, followed by one with `event:"EndOfTurn"` and a **non-empty** `transcript`. | Proves μ-law/8000 is not merely accepted at connect but actually decoded. A socket that accepts the pair and returns empty transcripts is the worst outcome and is not distinguishable at A2. |
| A4 | Across one turn, `words[].confidence` takes **more than one distinct value**. Print min / mean / max. | Schema-required means *present*, not *meaningful*. A provider can satisfy a required double with a constant. This is the field we are switching for (R4.1.5); prove it varies before any threshold is written. |
| A5 | `end_of_turn_confidence` is present on every `TurnInfo` and varies. | Second, independent signal for clarify-vs-answer, and the measurable version of the false-EOT problem. |
| A6 | Log `languages` and `languages_hinted` on every `TurnInfo`. Assert nothing; record. | The documented instrument for the exact Malayalam/Māori failure mode gpt-4o-transcribe produced twice. If Flux ever drifts, this makes it visible instead of mysterious. |
| A7 | **Clock anchor.** For each `TurnInfo`, record together: `audio_window_start`, `audio_window_end`, bytes written so far ÷ 8, and wall-clock ms since the first byte. Assert `audio_window_end × 1000 ≈ bytesWritten / 8` within ±150ms. | Settles whether Deepgram's audio clock is anchored at stream open. R4.1.7 correlation and the echo-suppression exact-match in `orchestrator.ts:737` both depend on the answer. If it fails, we use our own byte counter and log theirs as a diagnostic. |
| A8 | **Malformed-keyterm control.** A run with `keyterm=policy,premium` connects successfully and returns transcripts matching the *no-keyterm* arm, not the keyterm arm. | Converts the documented silent-failure behaviour into evidence, and justifies the validation unit test in step 3. |
| A9 | **Idle timeout.** Separate short run: connect, send 1s of audio, then send nothing for 60s. Record time-to-close, close code, close reason. | `/v2/listen` defines no `KeepAlive` message and no page states whether it enforces an idle timeout, in either direction. Settle it before any hold path pauses the media stream. Note the caveat: a harness that pauses audio may see a drop that a continuous carrier stream never would. |
| A10 | **Chunk cadence A/B.** Same audio at 160-byte/20ms (Twilio passthrough) vs 640-byte/80ms. Measure last-audio-byte → `EndOfTurn`. | 80ms is "strongly recommended", not a validation rule. Whether coalescing four frames actually wins is a measurement, not a deduction. Our own `MAX_PENDING_BYTES = 24_000` ("Three seconds of μ-law") fixes 8000 B/s, so 80ms = 640 bytes exactly. |
| A11 | **EU endpoint.** Repeat A2/A3 against `wss://api.eu.deepgram.com/v2/listen` with `flux-general-en`. Record connect RTT vs US. | EU `/v2/listen` GA is documented [V] https://developers.deepgram.com/changelog/2025/12/3, but only `flux-general-multi` appears in a published EU Flux URL. "Lagos→Frankfurt is half the RTT" has **no citation at all** — it is the highest-value one-variable experiment available and currently pure hypothesis. |

### Probe B — the deciding measurement (real caller audio only)

**Do not run this on TTS audio.** STACK_DECISION already records that the clean-Nigerian-TTS A/B scored 5 of 6 and got "policy" right every time — the methodology cannot reproduce the failure and would flatter both arms equally.

Same script, same audio, **three arms, in one run**: no keyterms · our keyterm list · the malformed control. Diff the transcripts and report the difference on exactly the words that have failed: *policy, policy number, premium, naira, renewal*. Log per-word confidence for those tokens in each arm.

Audio source: a real inbound call's μ-law bytes. If Slice 2's `audio_segments` has none yet, tee the inbound stream to a file for one call — the fan-out point already exists at `media.gateway.ts:130` / `orchestrator.ts:288`.

**What Probe B cannot settle:** absolute WER. AfriSpeech-MultiBench's Nigerian figures (GPT-4o Transcribe 40.03, Intron-Sahara V2 12.83) are measured on **16 kHz mono** audio. They bound accent difficulty on clean wideband speech and are a **floor** for our 8kHz path. Do not adopt 12.83% as a Gate A exit criterion; use them only as relative calibration between arms measured on our own corpus.

---

## 3. The adapter design

### Deepgram serves **both** interfaces, from one socket

Every `TurnInfo` carries `transcript`, `words[]` with per-word `confidence`, and `end_of_turn_confidence` together, and `keyterm` (including mid-stream `Configure`) is on the same endpoint. Opening a second socket for turns would double the listen bill (R4.1.9) for data already sitting in the frame we are parsing.

The structure is exactly the one `/Users/webcoded/Documents/Companies/Personal/ansa/packages/providers/listen/openai/src/listen-session.ts` already uses and that CLAUDE.md endorses: **one connection, two interfaces, exposed as two independent streams.** Sharing a socket stays the provider's implementation detail; the orchestrator correlates by `offsetMs` and nothing in the type lets it assume otherwise (R4.1.7).

**And the composition stays available.** Because both halves are separately typed, `TRANSCRIBER_PROVIDER=deepgram` + `TURN_PROVIDER=openai` is a config value, not a rewrite. That is the whole reason the two interfaces were split, and section 5 is why it matters.

### New and changed packages

**New — `/Users/webcoded/Documents/Companies/Personal/ansa/packages/providers/listen/session/` → `@ansa/listen-session`.**

Today `orchestrator.ts:2` imports `OpenAiListenSession` from `@ansa/openai-listen`. That is a vendor name inside orchestration code. Extract the shape, verbatim, minus the vendor:

```ts
export interface ListenSession {
  readonly transcripts: TranscriberSession;
  readonly turns: TurnSession;
  write(chunk: AudioChunk): void;
  onFailure(listener: (reason: string) => void): void;
  onVendorError(listener: (message: string) => void): void;
  close(): void;
}
```

Also moves here, because both vendor packages need it:

```ts
export interface ListenSocket {
  onOpen(listener: () => void): void;
  onMessage(listener: (data: string) => void): void;   // servers send JSON text both sides
  onClose(listener: (reason: string) => void): void;
  onError(listener: (error: Error) => void): void;
  send(data: string | Buffer): void;                    // WIDENED
  close(): void;
}
```

`send` widens from `send(data: string)` (currently `listen-session.ts:16`) because Deepgram's media path is **raw binary WebSocket frames — the μ-law bytes unwrapped, no base64, no JSON envelope, no per-chunk header** [V]. `ws` sends a Buffer as a binary frame by default, so `/Users/webcoded/Documents/Companies/Personal/ansa/apps/api/src/telephony/ws-listen-socket.ts` needs no runtime change, only the signature. `Configure`/`CloseStream` JSON and binary media then share one socket.

And a pure composer, which is where CLAUDE.md's "audio fan-out in one place" gets enforced:

```ts
export const composeListen = (parts: {
  readonly transcriber: ListenSession;
  readonly turnDetector: ListenSession;
}): ListenSession => { /* one write() fans to both; either failure fails the whole */ };
```

**New — `/Users/webcoded/Documents/Companies/Personal/ansa/packages/providers/listen/deepgram/` → `@ansa/deepgram-listen`.** Mirrors the openai package's file split, which exists so the wire format is testable without a network:

- `src/protocol.ts` — pure. `buildListenUrl(options)`, `authHeaders(apiKey)`, `parseFrame(raw)`, `encodeConfigure(...)`. No I/O, highest test density in the package.
- `src/listen-session.ts` — `openDeepgramListenSession(socket, options): ListenSession`. Socket injected; the package never names `ws`.
- `src/index.ts` — exports.

### Event mapping

| Deepgram frame | Our callback | Notes |
|---|---|---|
| `Connected` | ready | All configuration is in the URL, so there is **no `session.update` round trip** — audio can flow the moment `Connected` lands. Keep the pending-buffer + `MAX_PENDING_BYTES = 24_000` and the 6s ready timeout from the openai adapter: a bad query parameter may reject at upgrade rather than emit `Connected`, and a session that never becomes ready is an agent that is silently deaf. |
| `Update` | `onInterim` | Flux has **no separate interim stream**; `Update` *is* interim, ~every 0.25s of transcribed audio. Coarser than OpenAI's delta cadence. The first `Update` of a turn may carry `transcript: ""` and `words: []` — **tolerate it, do not emit it as a transcript reset.** |
| `StartOfTurn` | `onSpeechStart` **and** `onInterim` | Carries a populated transcript already. Record `offsetMs` keyed by `turn_index`. |
| `EagerEndOfTurn` | `onEagerEndOfTurn` | Never fires while `eager_eot_threshold` is omitted. Wire it anyway; the callback exists. |
| `TurnResumed` | `onTurnResumed` | Same. |
| `EndOfTurn` | `onEndOfTurn` **then** `onFinal` | **Order is load-bearing.** `orchestrator.ts:524` sets `mark("stt_final")` and `mark("turn_to_audio")` in `onEndOfTurn`; `orchestrator.ts:637` calls `measure("stt_final")` on the transcript. Emit final first and you get `latency mark missing` warnings and a lost `turn_to_audio`. |
| `ConfigureFailure` | `onVendorError` | "A failed `Configure` does NOT affect the stream; the connection continues with the previous configuration unchanged." [V] Non-fatal by documentation. |
| `type: "Error"` (FatalError) | `onFailure` | Fatal. Carry `code` and `description` into the reason string. Note this differs from the openai adapter, where `error` is routinely recoverable — Deepgram's is documented as fatal, so do not copy that leniency across. |

### The one structural consequence worth predicting

With OpenAI, `speech_stopped` and the transcript are separate events **480–1200ms apart**, and `stt_final` measures that gap at 420–650ms. With Flux, **the transcript is already in the `EndOfTurn` frame.** `stt_final` collapses to ~0ms and roughly half a second leaves every turn for free.

That is the second-strongest reason to switch after keyterms, and it is structural rather than geographic — it survives the Nigeria→US round trip. [I] Two warnings: do not read `stt_final ≈ 0` in the logs as instrumentation breakage, and do not compare the two providers on `stt_final` at all. `turn_to_audio` is the only honest cross-provider number.

### Offsets — how `offsetMs` is derived

Ship with **our own byte counter** as the source of truth: `streamOffsetMs = bytesWritten / 8`, definitionally anchored at stream open, exactly as `listen-session.ts:100` does today. Log `audio_window_start`/`end` alongside as a diagnostic until probe A7 proves the anchor. [U]

Better than the OpenAI path in one respect: **`turn_index` gives an exact correlation key.** On `StartOfTurn` for turn *N*, record the offset; on `EndOfTurn` for the same *N*, stamp the final `Transcript.offsetMs` with that recorded value. The OpenAI adapter approximates this with a mutable `segmentStartMs` (`listen-session.ts:95`); Flux makes it exact. This is not cosmetic — `orchestrator.ts:737` does `echoSegments.delete(transcript.offsetMs)` as an **exact** match to suppress the agent answering its own echoed voice. Fall back to `streamOffsetMs()` if an `EndOfTurn` arrives with no observed `StartOfTurn`.

### Keyterm validation — a unit test, not a convention

`buildListenUrl` throws at construction on any term containing `,`, `;`, a newline, or a `:` followed by digits, and warns above 50 terms / throws above the 500-token cap. Because the documented failure is *silent*, a typo otherwise produces zero boosting and no error anywhere. Use `URLSearchParams` with repeated `append` — it encodes space as `+`, which the docs explicitly permit.

Unit test asserts: N terms produce N `keyterm=` pairs; a phrase encodes with `+` or `%20`; no emitted keyterm value contains a comma, semicolon, or `:weight`; the URL contains no `language` parameter; `eager_eot_threshold` is absent unless explicitly configured; and if both are set, `eager_eot_threshold <= eot_threshold` (Deepgram errors otherwise [V]).

### Mid-stream `Configure` — document it, do not build it yet

Flux uniquely supports updating keyterms mid-stream without reconnecting; Nova-3 keyterms are fixed for the session [V] https://developers.deepgram.com/docs/flux/configure, corroborated at https://developers.deepgram.com/docs/voice-agent-update-listen. Per-organization vocabulary is not this slice's problem, and CLAUDE.md forbids pre-generalising. Record three constraints for when it lands:

1. **`Configure` keyterms REPLACE, they do not merge.** A per-organization swap must resend the base insurance vocabulary or "policy" is silently dropped. The adapter owns the full list, always.
2. `Configure`'s field is `keyterms` (plural, **array of strings only**); the query param is `keyterm` (singular, string or array). Same trap as `language_hint`/`language_hints`.
3. "Already-transcribed audio is NOT reprocessed" — a swap must land **before** the prompt that elicits the vocabulary, not after the mishearing.

### Wiring in `media.gateway.ts`

`media.gateway.ts:158` currently names the vendor directly. It stops doing that entirely:

```ts
const listen = this.openListen(stream.format);
```

`openListen` is injected as `LISTEN_FACTORY` (section 4). Everything else in `observe()` is unchanged: `runConversation` still receives one `ListenSession`, `orchestrator.ts:288` remains the single audio fan-out point, and the keyterm list moves out of the inline literal at `media.gateway.ts:169` into config so the A/B is an env change rather than an edit.

All functions are expressions, per CLAUDE.md. No `ws` import, no Deepgram type, and no Deepgram URL outside `packages/providers/listen/deepgram/`.

---

## 4. The switch

**Two variables, not one** — because the interesting comparison is not "OpenAI vs Deepgram" but the three compositions CLAUDE.md predicted:

```
TRANSCRIBER_PROVIDER = openai | deepgram     # default: openai until a call says otherwise
TURN_PROVIDER        = openai | deepgram     # default: openai
DEEPGRAM_API_KEY     = …                     # optional at load; required at boot iff selected
DEEPGRAM_MODEL       = flux-general-en
DEEPGRAM_BASE_URL    = wss://api.deepgram.com    # swap to api.eu.deepgram.com for the A/B
DEEPGRAM_EOT_THRESHOLD    = 0.8
DEEPGRAM_EOT_TIMEOUT_MS   = 3000
DEEPGRAM_EAGER_EOT_THRESHOLD =              # empty = eager off. Never default this on.
LISTEN_KEYTERMS      = Ansa,policy,policy number,premium,naira,claim,renewal
```

`LISTEN_KEYTERMS` is comma-separated **in the env var** and split before the URL is built — the comma never reaches a `keyterm=` value. Assert that in the unit test; it is the likeliest route to accidentally reproducing the documented silent failure.

In `/Users/webcoded/Documents/Companies/Personal/ansa/apps/api/src/config/env.ts`, add these via the existing `required`/`optional` helpers, and follow the file's convention of carrying the *measurement* in the comment (as `transcriptionModel` does today). `DEEPGRAM_API_KEY` uses `optional()` at load and is validated **in the factory at boot** when Deepgram is selected — failing at boot beats failing mid-call, and a missing key must not stop someone who is running the OpenAI arm.

In `tokens.ts`, one new symbol: `LISTEN_FACTORY`. In `telephony.module.ts`, one new provider — the only place a listen vendor is named, exactly as the file's header comment already promises for the carrier:

```ts
{
  provide: LISTEN_FACTORY,
  inject: [APP_CONFIG, LOGGER],
  useFactory: (config: AppConfig, log: Logger) => {
    const openOpenAi = (format: AudioFormat): ListenSession => /* … */;
    const openDeepgram = (format: AudioFormat): ListenSession => /* … */;

    // Same vendor both sides: one socket, one bill. Different vendors: two sockets,
    // audio fanned out by composeListen, and the STT bill doubles (R4.1.9).
    if (config.transcriberProvider === config.turnProvider) { /* single */ }
    log.warn("split listen composition — STT cost is doubled", { … });
    /* composeListen({ transcriber, turnDetector }) */
  },
}
```

Log the composition and the connect URL **with the key redacted** at every call open. When something is wrong on call three, you want the exact URL in the log rather than reconstructed from env vars.

Cost, for the R4.1.9 line items: Flux English PAYG **$0.0065/min** + Keyterm Prompting add-on **$0.0013/min** = **$0.0078/min ≈ $0.47/hr**. Track base and add-on as **separate** lines — `$0.0078` is coincidentally identical to the Flux *Multilingual* base rate, which will confuse anyone reading a blended number later. Streaming concurrency: up to 150 WSS connections on standard. [V] https://deepgram.com/pricing — re-check before Gate A and confirm against the first invoice; pricing pages are the most volatile source cited here.

---

## 5. What to keep from the OpenAI path

**Keep `@ansa/openai-listen` entire — package, tests, and its place in the switch.** Gate A needs both arms and cannot re-litigate a deleted one.

**`semantic_vad` / `eagerness: auto` is a measured success and must not be discarded reflexively.** The recorded table: 3 of 4 turns fully played, 1 spurious barge-in, worst wait 1.5s — rising to 6 of 6 turns and **0** spurious barge-ins after the quality pass. That is a genuinely good state, and it is the state Deepgram's turn detection has to beat, not merely match.

The specific risk that would keep it: **`StartOfTurn` is a model-integrated turn-start, not a raw energy VAD.** Its own example payload already carries two transcribed words. `onSpeechStart` — which drives barge-in and whose latency bounds how fast the agent can stop talking — will therefore fire *later* than an energy VAD. Deepgram publishes ~260ms p50 for *end*-of-turn and **no figure at all** for `StartOfTurn`. If barge-in gets worse, `TURN_PROVIDER=openai` with `TRANSCRIBER_PROVIDER=deepgram` is the answer, and section 4 makes that an env change.

Also keep, all of it earned on live calls rather than reasoned into existence:

- **The 400ms barge-in echo guard and exact-offset `echoSegments` matching.** The caller's handset returns our own voice; before the guard, *every* agent turn was barged-in at `charsHeard: 0`. Deepgram's different detector may want a different value — re-measure the number, keep the mechanism.
- **The `onFailure` / `onVendorError` split, the ready timeout, and the bounded pending-audio buffer.** Each maps to a specific live-call disaster: a lost socket leaving the agent permanently deaf; a config rejection logged as a warning while the whole call ran deaf; a never-ready socket growing without bound.
- **`hearing.ts`'s correction map and non-speech filter.** Do not delete them the moment keyterms work. If keyterms succeed, the map firing **zero times across two clean calls** is the success signal — that is the evidence, and you need it before removing anything.
- **`gpt-4o-transcribe` as a reachable fallback.** A Deepgram outage must degrade into worse transcription, never into silence.
- **The harness rule:** carriers stream silence continuously and so must any test harness. Stopping the stream yields no transcript at all. This applies verbatim to the Deepgram probe.
- **The retreat that is *not* available:** do not fall back to Nova-3 for turn detection. Deepgram's own comparison marks Start of Turn, Speech Resumed, End of Turn and Eager End of Turn all 🚫 for Nova-3, and `utterance_end_ms` has a documented **hard minimum of 1,000ms** on hosted Deepgram — the floor alone exceeds the entire 800ms R5.5 budget. Nova-3 is a words-only fallback on a *different* endpoint (`/v1/listen`), paired with something else for turns.

---

## 6. Ordered steps

Each step leaves `pnpm build && pnpm typecheck && pnpm lint && pnpm test` green and names what proves it.

**Step 0 — Probe A, then Probe B.** No repo change. **Proof:** A2 returns `Connected` on the composed URL and A3 returns a non-empty transcript. *If A2 or A3 fails, stop — this plan is void and the finding goes straight into STACK_DECISION alongside Intron.* Paste raw frames into the scratchpad; step 4 uses them as golden fixtures.

**Step 1 — Extract `@ansa/listen-session`.** Move `ListenSession` (renamed from `OpenAiListenSession`) and `ListenSocket` (with `send: string | Buffer`) out of the openai package; add `composeListen`. `@ansa/openai-listen` re-exports nothing vendor-neutral; `orchestrator.ts:2` and `media.gateway.ts:6` import from the new package. **Test:** all existing openai session tests pass unchanged; new unit tests that `composeListen` fans one `write` to both sessions and that a failure in either propagates once. **Observation:** one live call on the OpenAI arm, behaviour byte-identical — same `turn_to_audio`, same barge-in counts.

**Step 2 — Make the socket factory vendor-agnostic.** `ws-listen-socket.ts` becomes `openWebSocket({ url, headers })`; each vendor package exports its own `buildUrl` and `authHeaders`. This removes the last vendor URL from `apps/api`. **Test:** existing tests green. **Observation:** same live call, identical. (Steps 1–2 are refactors on the working path — do them while the working path is the one running, so a regression is unambiguous.)

**Step 3 — `@ansa/deepgram-listen`, `protocol.ts` only.** Pure URL builder, auth header, frame parser, `encodeConfigure`. Nothing wired. **Test:** the keyterm validation suite from section 3, plus parser tests over the golden frames from step 0 covering every `event` value, the `type:"Error"` discriminator, an `Update` with `transcript: ""`, and an unknown `event` returning null (a vendor adding an event type must never take a call down — the openai parser's rule, kept). **Observation:** none needed; nothing runs.

**Step 4 — `listen-session.ts` for Deepgram.** Session against a fake socket replaying the step-0 frames. **Test:** `onEndOfTurn` fires strictly before `onFinal` for one frame; `Transcript.offsetMs` on `EndOfTurn` equals the offset emitted at `StartOfTurn` for the same `turn_index`; audio written before `Connected` is buffered and flushed, and is dropped oldest-first past `MAX_PENDING_BYTES`; `ConfigureFailure` → `onVendorError` and does not fail the session; `type:"Error"` → `onFailure` exactly once; no `Connected` within 6s → `onFailure`. Still not wired. **Observation:** none.

**Step 5 — Config and the DI switch, defaults unchanged.** `env.ts`, `tokens.ts`, `telephony.module.ts`, `media.gateway.ts`. Defaults stay `openai`/`openai`. **Test:** a config test that a missing `DEEPGRAM_API_KEY` throws **only** when Deepgram is selected; that the split composition is chosen when the two vars differ. **Observation:** boot with defaults, live call identical; boot with `TRANSCRIBER_PROVIDER=deepgram` and see the redacted connect URL logged — then stop, do not call yet.

**Step 6 — The first Deepgram call.** `TRANSCRIBER_PROVIDER=deepgram TURN_PROVIDER=deepgram`. Run probes C1, C2, C4, A1, A3, B1 and E2 from `/Users/webcoded/Documents/Companies/Personal/ansa/docs/CALL_PROBES.md`. **Observation:** section 7 in full. This is the step where the slice is or is not done — nothing before it counts.

**Step 7 — Composition A/B and the decision.** Three calls: deepgram/deepgram, deepgram/openai, openai/openai, same caller, same phone, same script. Then set the defaults in `env.ts` with the measurement in the comment, and rewrite the STT section of `docs/STACK_DECISION.md` — including the negative findings, which are the valuable half. Tick the Slice 3 boxes in `TASKS.md` that this actually closes (R4.1.3, R4.1.5) and leave the ones it does not.

---

## 7. What only a real phone call can settle

1. **Whether keyterms rescue the words that have been failing.** "policy" has come back as apology, penalty, polling, course and puppy. Keyterm boosting raises the prior on domain terms over a degraded channel; it does not teach the model an accent, and STACK_DECISION already walked back "it is vocabulary, not accent". Clean audio scored 5 of 6 on the *current* provider — it cannot reproduce the failure and cannot answer this.
2. **Nigerian-accent accuracy at all.** There is **no published evidence, vendor or independent**, on Deepgram's performance on African-accented English. AfriSpeech-MultiBench evaluates 19 systems and Deepgram is not among them. Deepgram's 6.84% streaming median WER is a nine-domain global average with no per-accent breakdown. "English (all accents)" in the model catalogue and "Same Nova 3 transcription quality" on the migration page are unbenchmarked marketing strings and must not enter STACK_DECISION as evidence.
3. **Whether `words[].confidence` varies *usefully*** — whether low confidence actually correlates with the words that were wrong. Probe A4 proves variance; only a real call proves the correlation that a clarify threshold depends on. Keep `Transcript.confidence` nullable until it does.
4. **Barge-in cut-off latency.** `StartOfTurn` is model-integrated and arrives with words already transcribed. Watch `barge-in` for non-zero `msHeard` and whether audio stops within a beat (probes A1, A2).
5. **The false-EOT rate at `eot_threshold=0.8` against a real thinking pause** (probe A3: *"I'd like to…"* / two-second pause / *"…when my policy renews."*). One `caller said` line, not two.
6. **Whether `eot_timeout_ms` behaves on a noisy line.** It is a *silence* timer that resets on new speech. A caller on a Lagos street may never produce the silence that arms it, in which case the backstop is not a backstop. Probe E1.
7. **Echo interaction.** Does `StartOfTurn` fire on our own returned audio inside the 400ms guard? Different detector; the guard value may need re-measuring. Probe E2 — `ignored echoed agent audio` firing is the defence working.
8. **`turn_to_audio` from Nigeria**, and whether the predicted `stt_final` collapse actually materialises. Current baseline: 1189–1578ms against an 800ms target.
9. **Language abandonment.** Log `languages` on every `TurnInfo` for the whole call. This is the direct instrument for the failure mode that produced Malayalam and Māori twice with `language: "en"` set explicitly.
10. **Whether 8kHz μ-law degrades EOT precision.** No Deepgram page states EOT performance at 8kHz, and no example runs Flux there. A silent precision loss on a 300–3400Hz band-limited line is far likelier than an outright rejection, and it is invisible in a probe.
11. **Socket stability across a real multi-minute call** with continuous carrier audio. Probe A9 pauses the stream; a real call never does, so A9 answers a different question.
12. **EU endpoint RTT from Nigeria on a live call**, not from a laptop probe under different conditions.

---

## 8. Honest risks

**What would make Deepgram worse than what we have:**

- **Priority 6 has zero documentary support.** We are switching on *capability* (keyterms, word confidence, model-native turns), not on measured accuracy for our callers. It is entirely possible Flux transcribes Nigerian-accented 8kHz speech worse than `gpt-4o-transcribe`, whose Nigerian WER on *clean 16kHz* audio is already 40.03%. Keyterms cannot rescue a worse base model. **This is the single largest risk and it has no mitigation short of Probe B.**
- **We are running Flux at its least-tuned setting.** No `nova-3-phonecall`, no `flux-phonecall` — the only models Deepgram describes as "Optimized for low-bandwidth audio phone calls" are Nova-2 and older, which cannot use keyterms at all. Flux is a general model, and its own quickstart recommends 16000 Hz.
- **Turn detection could regress from a measured-good state.** 6 of 6 turns played and 0 spurious barge-ins is not a baseline to give up casually. Mitigated by keeping `TURN_PROVIDER` switchable — but only if we actually measure it instead of assuming model-native beats semantic_vad.
- **No keyterm intensity knob.** If boosting is too weak at 8kHz there is no dial to turn. Term selection and casing are the only levers, and casing behaviour is [U].
- **Silent failure is the documented behaviour for malformed keyterms.** Our validation catches syntax. It cannot catch a term that is simply the *wrong* term — that failure is invisible in every log.
- **The 500-token cap** will bind once per-organization product names plus Nigerian place and person names arrive. Whether a mid-stream `Configure` resets or accumulates against that budget is [U].
- **`/v2` has no `KeepAlive` message and no documented idle timeout, in either direction.** If one exists, a future hold path that pauses media drops the socket with no documented remedy. `/v2` also publishes no close-code table (`/v1` does).
- **`mulaw` + `8000` on Flux is documented-legal and demonstrated nowhere.** Deepgram's one working mulaw/8000 Twilio example is on the **Voice Agent API** (`/v1/agent/converse`) with `nova-3` — a different endpoint and a different model. It is not corroboration. Probe A2 exists precisely because this is the Intron shape.

**Latency, given we are calling from Nigeria — read this before expecting a win:**

Deepgram's default endpoint is US-hosted, exactly like the three providers we already pay a Nigeria→US round trip to, serially. **This switch does not address the dominant cost.** The published ~260ms p50 end-of-turn is measured on Deepgram's own infrastructure with no stated client location and our path will not reproduce it.

The win that *is* real is structural rather than geographic: end-of-turn and transcript arrive in the **same frame**, which removes the 420–650ms `stt_final` stage from every turn regardless of distance. Against a current 1189–1578ms `turn_to_audio` that lands us near 1.0–1.4s — better, still over the 800ms R5.5 target, and still dominated by `llm_first_token` at 763–1186ms, which this change does not touch at all.

The only lever inside Deepgram is the EU endpoint. Regions are EU and AU; **no African point of presence** — though note that is inferred from an endpoint list, never stated by Deepgram. "Lagos→Frankfurt is roughly half the RTT of Lagos→US-East" has **no citation whatsoever** and is a hypothesis, not a fact. It is also the cheapest one-variable experiment available (`DEEPGRAM_BASE_URL`), so run it as a measured A/B and do not design around it beforehand. Self-hosting Flux is a real option and an expensive one: Ampere+ GPU (T4 explicitly unsupported), a separate instance from every other Deepgram model including Nova-3, container `release-251015` or later.

**Cost:** ~$0.47/hr of call audio with keyterms. A split composition doubles the listen bill (R4.1.9) — visible by design, and the reason the same-vendor path uses one socket.

**Process risk:** Gate A must close before Slice 4, because from Slice 4 onward the normalizer rules, confidence thresholds, readback aggressiveness and keyterm strategy are all tuned against one provider's error profile. A half-switch — Deepgram wired but never measured on a real Nigerian caller — is the worst outcome available, worse than not switching, because it spends the switching cost without buying the evidence.