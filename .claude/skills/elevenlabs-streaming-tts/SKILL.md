---
name: elevenlabs-streaming-tts
description: Use when integrating or debugging ElevenLabs text-to-speech in Ansa — streaming synthesis and barge-in cancellation, model choice (eleven_flash_v2_5, eleven_v3_conversational, the deprecated turbo models), output_format including ulaw_8000 for telephony, voice_settings and speaking rate, the voice catalogue and shared-voices library, or TTS latency and first-byte measurement.
---

# ElevenLabs TTS in Ansa

Every word the agent speaks comes from here: LLM output, tool results, fillers, the
greeting, error lines. All of it goes through `packages/normalizer` first — nothing reaches
TTS unnormalized.

All API facts re-verified against elevenlabs.io/docs on 2026-08-20. Items marked **(repo
observation)** come from this codebase's own probes.

## The files

| Path | What lives there |
|---|---|
| `packages/providers/tts/src/types.ts` | `TtsProvider`, `SynthesisRequest`, `SynthesisStream`, `VoiceCatalogue`, `Voice`. The contract. |
| `packages/providers/tts/src/elevenlabs/elevenlabs-tts.provider.ts` | Synthesis. HTTP streaming + `AbortController`. |
| `packages/providers/tts/src/elevenlabs/elevenlabs-voices.ts` | `VoiceCatalogue`: `knows()` and `list()`. Vendor shapes are local to this file. |
| `packages/providers/tts/src/audio-duration.ts` | `durationMs(bytes, format)` — how chunk offsets are stamped. |
| `apps/api/src/orchestrator/orchestrator.ts` | Consumes the stream, sends to the carrier, marks, cancels on barge-in. |
| `apps/api/src/telephony/prerender.ts` | Warm cache for the greeting and fillers. |

`xi-api-key`, `model_id`, `ulaw_8000` and every other vendor word stops inside
`packages/providers/tts/`. The orchestrator sees `SynthesisRequest`/`SynthesisStream`.

## Models — the default in this repo is deprecated

| Model id | Latency (vendor) | Languages | Real-time? |
|---|---|---|---|
| `eleven_flash_v2_5` | **~75ms †** | 32 | **Recommended** |
| `eleven_flash_v2` | ~75ms † | English only | **Recommended** |
| `eleven_v3_conversational` | **~280ms** | 70+ | **Recommended** — "most expressive model for realtime speech synthesis" |
| `eleven_multilingual_v2` | not stated | 29 | Not recommended |
| `eleven_v3` | not stated | 70+ | **Not recommended** for real-time |
| `eleven_turbo_v2_5`, `eleven_turbo_v2` | — | — | **Deprecated** |

† "Excluding application & network latency."

> "The `eleven_turbo_v2_5` and `eleven_turbo_v2` models are functionally equivalent to the
> `eleven_flash_v2_5` and `eleven_flash_v2` models respectively, except the latency on the
> Flash models is lower on average. We recommend using the Flash models over Turbo models
> in all use cases."

No sunset date is published.

**`DEFAULT_MODEL_ID` in `elevenlabs-tts.provider.ts` is `eleven_turbo_v2_5`.** It still
works, and it was the right pick when Slice 1 chose it, but ElevenLabs now says use Flash
in all cases. Changing it is a Gate A decision, not a drive-by edit: it changes how the
agent *sounds*, so it needs a rerun of the eval harness and a listen on a real call, not a
green typecheck. `eleven_v3_conversational` is the other candidate — 280ms against 75ms is
real money on a 2-second budget, and whether the expressiveness is worth it is a
measurement, not an argument.

Note the API's own default `model_id` is `eleven_multilingual_v2` — never rely on it.
Always send `model_id` explicitly.

## The request

`POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=ulaw_8000`
with header `xi-api-key`.

```ts
body: JSON.stringify({
  text: request.text,
  model_id: modelId,
  ...(request.speakingRate === undefined
    ? {}
    : { voice_settings: { speed: request.speakingRate } }),
}),
```

- **`ulaw_8000` returns raw mu-law 8kHz with no container** — `content-type: audio/ulaw`,
  13 003 bytes = 1.63s at 8000 B/s. Verified on the live API 2026-08-07 **(repo
  observation)**. This is exactly what Twilio wants, so there is no transcoding hop.
- The output_format docs even say so: "Note that the μ-law format (sometimes written
  mu-law, often approximated as u-law) is commonly used for Twilio audio inputs."
- `ulaw_8000` has **no subscription-tier gate**. (`mp3_44100_192` needs Creator; PCM/WAV at
  44.1kHz need Pro.)
- `toOutputFormat` throws on any format it cannot serve natively rather than falling back
  to something needing transcoding — a silent transcoding hop is exactly the cost R4.2.4
  exists to avoid.

Full format list, voice settings ranges and endpoint details:
[`references/elevenlabs-api.md`](references/elevenlabs-api.md).

## `optimize_streaming_latency` is deprecated

The query parameter still exists on `/v1/text-to-speech/{voice_id}/stream` and is **marked
deprecated** in the API reference. There is no drop-in replacement parameter. What replaced
it is model choice plus transport:

1. Pick a Flash model (or `eleven_v3_conversational`).
2. Stream rather than convert-then-play (this repo already does).
3. If text arrives incrementally from an LLM, the WebSocket endpoint
   `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input` with `auto_mode`
   avoids the chunk-schedule stall. Ansa does **not** use it — it synthesises per completed
   sentence over HTTP — and adopting it would change cancellation semantics, so it is a
   deliberate decision, not an optimisation.
4. "Higher audio quality output formats can increase latency." `ulaw_8000` is already the
   cheapest.

Do not add `optimize_streaming_latency` to a new call site.

Vendor TTFB by region: 100–150ms in North America, Europe, Southeast Asia; 150–200ms in
South Asia and Northeast Asia. **Repo measurement from a laptop in Nigeria to ElevenLabs'
default region cleared the R4.2.3 bar**, so the regional figures are a floor, not a
promise.

## `speed`: omitting it is not the same as sending 1.0

```ts
...(request.speakingRate === undefined
  ? {}
  : { voice_settings: { speed: request.speakingRate } }),
```

The API reference gives `voice_settings.speed` a **default of 1**, and the prompting docs
give the range: "The default value is 1.0, which means that the speed is not adjusted.
Values below 1.0 will slow the voice down, to a minimum of **0.7**. Values above 1.0 will
speed up the voice, to a maximum of **1.2**."

So the field's *default* is 1.0. The difference the code comment is pointing at is one
level up: **sending a `voice_settings` object at all replaces the voice's own saved
settings for that request.** A voice cloned at its speaker's pace keeps that pace when
`voice_settings` is absent. Sending `{ speed: 1.0 }` is a deliberate instruction, not a
no-op — and it also means `stability`, `similarity_boost`, `style` and `use_speaker_boost`
are no longer coming from the voice's stored configuration for that call.

⚠ I could not find a page that states the omitted-object fallback in so many words; the
schema defaults and the code comment agree in effect. If you change how `voice_settings` is
sent, **test it on a real voice and listen**, do not reason it out.

`speakingRate` is not validated against 0.7–1.2 anywhere in this repo. A value outside the
range will be rejected by the API mid-call, and a rejected synthesis is silence on the
line. Worth a guard before it reaches the wire.

## Cancellation is the whole point

`SynthesisStream.cancel()` must guarantee no further `onAudio`. Barge-in depends on it
(R6.1) — without it the agent keeps talking over a caller who already interrupted.

```ts
cancel(): void {
  if (this.settled) return;
  this.cancelled = true;
  this.settled = true;
  this.controller.abort();      // stops the vendor billing for audio nobody hears
}
```

Three details that look incidental and are not:

1. **`AbortSignal.any([stream.signal, AbortSignal.timeout(5_000)])`.** A hung connection
   must fail loudly rather than hang the turn.
2. **An abort is a barge-in, not a fault.** `catch` returns early when `isCancelled` —
   nothing downstream should hear about it. Emitting an error there would log a fault on
   every successful interruption.
3. **`queueMicrotask(() => void run())`.** The caller registers `onAudio`/`onDone`/`onError`
   *synchronously after* `synthesize()` returns. Without the deferral, a failure raised
   before the first `await` — an unsupported format, say — is emitted to nobody and the
   turn goes silent with no error anywhere.

The reader loop also re-checks `isCancelled` between chunks and calls `reader.cancel()`,
because the abort races bytes already in the pipe.

## Offsets

```ts
stream.emitAudio({
  data: Buffer.from(value),
  offsetMs: Math.round(durationMs(bytes, request.format)),
});
bytes += value.length;
```

The offset is stamped **before** the chunk's own bytes are counted — it is where this chunk
*starts* inside the utterance. That number is how the orchestrator works out how much of a
turn the caller actually heard before interrupting. Getting the order wrong shifts every
barge-in measurement by one chunk.

## The voice catalogue — two populations, three states

`GET /v1/voices` returns what is *on the account*; every one is usable this second.
`GET /v1/shared-voices` is the public library — none of it usable until someone adds it, and
on a free plan `free_users_allowed` decides whether they may.

That is why `VoiceAvailability` has three values, not a free/paid flag:

- `usable` — on the account, safe to save
- `addable` — in the library, plan allows it, nobody has added it yet
- `beyond-plan` — in the library, this plan may not add it

A picker showing only the account would hide every Nigerian voice the product exists to
sound like. One showing both undifferentiated would let an operator save an id that
synthesises silence on the next call.

`knows()` is a single `GET /v1/voices/{id}` rather than listing and searching: the list
endpoint omits shared voices the account can nonetheless speak with, so a valid id would
come back "unknown" and the readiness check would tell an organisation their working voice
is broken. **404 is the only status that means "no such voice"** — 401 is our key, 429 is
our quota, and both throw rather than resolving `false`.

`list()` throws when the *account* read fails and sets `libraryUnread: true` when only the
*library* read fails. Those are different-sized failures: the first means we know nothing,
the second means every voice shown is still correct and only "what else could I have" is
missing. A short list without the flag reads as "this is all there is", which is a
different statement and a wrong one.

### Current endpoint status

- `GET /v1/voices/{voice_id}` — **still v1**, still current. Its `with_settings` query param
  is deprecated and ignored.
- `GET /v1/shared-voices` — current. `page_size` default 30, **max 100** (the repo asks for
  100, which is the ceiling). Confirmed fields include `free_users_allowed`,
  `is_added_by_user`, `preview_url`, `use_case`, `descriptive`.
- `GET /v1/user/subscription` — current, not deprecated. `tier` values include `free`,
  `starter`, `creator`, `pro`, `growing_business`, `trial`, `enterprise` and dated grant
  tiers. The repo only tests `tier === "free"`, which is the right test for the question it
  asks.
- `GET /v1/voices` (list all) — **there is now a `GET /v2/voices`** with server-side
  `search`, `voice_type`, `category`, `gender`, `age`, `accent`, `language`, `sort` and
  cursor pagination (`has_more`, `next_page_token`, `total_count`), `page_size` max 100. No
  deprecation notice sits on v1, but v2 is what the docs present as the list endpoint. If
  the console's voice list ever needs filtering or more than one page, migrate to v2 rather
  than paginating v1.

## The idiom

Arrow consts (`func-style: expression`). `ElevenLabsSynthesisStream` is a class because it
carries mutable per-stream state and an `AbortController`; the factory around it is an
arrow const.

Vendor response shapes (`AccountVoiceBody`, `SharedVoiceBody`) are **declared locally and do
not leave the file**. What leaves is `Voice` — the same contract any other vendor would have
to satisfy. Keep it that way; a `preview_url` leaking into the console's types is CLAUDE.md
rule 2 broken.

Every field on `Voice`/`VoiceLabels` is nullable because it is somebody else's metadata. A
missing accent is a gap in the library, not an error, and a list that refused to show a
voice without one would hide working voices.

## Things that are not what you'd guess

1. **`eleven_turbo_v2_5` — this repo's default — is deprecated.** Flash is the vendor's
   recommendation in all cases.
2. **`optimize_streaming_latency` is deprecated with no replacement parameter.** Model +
   transport is the answer now.
3. **The API's default `model_id` is `eleven_multilingual_v2`**, which is explicitly *not*
   recommended for real-time. Always send `model_id`.
4. **`speed` clamps at 0.7–1.2.** Outside that, the request fails and the turn goes silent.
   Nothing in this repo guards it.
5. **Sending `voice_settings` at all overrides the voice's saved settings** for the fields
   you send and, per the schema defaults, the ones you do not. Send it deliberately.
6. **`ulaw_8000` is raw, headerless mu-law** — no WAV header, no container. If you ever see
   a 44-byte prefix of clicks at the start of a turn, you asked for `wav_8000`.
7. **A wrong voice id publishes happily and fails on the first call.** That is what
   `VoiceCatalogue.knows()` exists to catch one screen earlier — see
   `docs/ONBOARDING_RUNBOOK.md`.
8. **`/v1/shared-voices` is a separate population from `/v1/voices`**, and an id present in
   one is not necessarily speakable by the other.
9. **ElevenLabs is not viable for STT here.** `/v1/speech-to-text` requires a complete file
   or buffered audio — batch STT is disqualifying (R4.1.4), not merely slow.
10. **The WebSocket TTS endpoint exists** (`/v1/text-to-speech/{voice_id}/stream-input`) with
    `auto_mode` and a `chunk_length_schedule` defaulting to `[120, 160, 250, 290]`. Without
    `auto_mode`, "If you set a chunk schedule of 125 characters but only 50 arrive, the
    model stalls until additional characters come in" — a stall the caller hears as
    silence. This is the trap that makes HTTP-per-sentence the safer default here.

## Debugging

- Turn goes silent with no error → check the `queueMicrotask` deferral is intact and that
  listeners are registered synchronously after `synthesize()`.
- Agent talks over a barge-in → `cancel()` is not reaching the `AbortController`, or the
  orchestrator cleared the carrier buffer before cancelling synthesis. Order in
  `stopSpeaking` is: cancel LLM, cancel synthesis, empty queue, then `stream.clear()`.
- Clicks or static → format mismatch. `ulaw_8000` in, `audio/x-mulaw` 8000 out to Twilio, no
  transcode in between.
- 401 → header is `xi-api-key`, not `Authorization`.
- Every voice shows as "addable" on a paid account → `planIsFree` is reading the wrong
  field; `free_users_allowed` is only a gate on a free plan.
