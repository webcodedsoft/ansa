# Stack decision

**Status: PROVISIONAL. Nothing here is measured.** Gate A replaces this file with two
ranked tables, Lagos round-trip figures, and the specific number that would make us switch.
Until then every entry is "quickest to integrate", not "best".

The provider abstraction is what makes this safe to defer. If a vendor type ever escapes
`packages/providers/*`, this file stops being a decision anyone can act on.

---

## TTS — ElevenLabs (provisional, Slice 1)

**Chosen for integration speed, not for naturalness.**

Four gates a candidate had to clear at Slice 1:

1. Streaming synthesis — non-streaming is disqualifying, not merely slow (R4.2.3)
2. Working cancellation — `cancel()` is on our interface and barge-in depends on it (R6.1)
3. Native μ-law 8kHz — anything else adds a transcoding hop (R4.2.4)
4. A Nigerian-accented voice available *today*, so the phone-line test (PRD §1.0) can
   happen on day one rather than after commissioning a voice actor

ElevenLabs is the only candidate believed to clear all four at once, and it has the
best-trodden Twilio media-streams path.

**Not chosen, and why:**

| Candidate | Why not now | Revisit at Gate A |
|---|---|---|
| Spitch | Plausibly the right long-term answer — Nigerian-native voices, Pidgin. But TASKS lists its streaming, TTFB and μ-law support under *verify before committing*, i.e. unknown. If it is batch-only that is disqualifying under R4.2.3, and finding out would have burned the slice. | Yes — strong contender on naturalness |
| Deepgram Aura | Streams, does μ-law 8kHz, excellent docs, fastest to integrate. Voices are American, so it fails the day-one Nigerian-voice test. | Only if Nigerian voices ship |

**Outstanding — must be closed before this is trusted:**

- [x] **Confirmed 2026-08-07: `output_format=ulaw_8000` returns raw μ-law 8kHz.**
      `content-type: audio/ulaw`, no container, 13,003 bytes = 1.63s at 8000 B/s, and the
      decoded waveform is speech (peak 23932/32767, rms 4396, 41% near-silent samples —
      noise-as-μ-law would be loud almost everywhere). No transcoding hop. R4.2.4 satisfied.
- [ ] **Time to first byte is marginal: 256–277ms measured, against a <300ms target
      (R4.2.3), and that is from a laptop in Nigeria to ElevenLabs' default region — not
      from a Lagos datacentre under load.** Little headroom. R9.1.8 makes this a Gate A
      measurement, and it may be what disqualifies the provider rather than accuracy.
- [ ] **Blocked: the account is on the free plan and cannot use Voice Library voices via
      the API** — `402 paid_plan_required`. The premade voices work, but none are Nigerian.
      Olabisi needs a paid subscription before a real call can use her.
- [x] Pick a Nigerian voice — `eOHsvebhdtt0XFeHVMQY`, from the Voice Library, chosen by
      Vera on 2026-08-07. Provisional, and set per-environment rather than in code, so
      swapping it is one variable.
- [ ] Confirm that voice survives 8kHz μ-law on a real line. It was chosen on browser
      playback, which flatters a voice: the telephony band-pass is roughly 300–3400Hz, so
      bass thins and sibilance hardens. Judge it on the phone before trusting it.
- [ ] Source a second voice. R4.2.2 wants male and female Nigerian options from day one of
      tenant onboarding, and a second voice gives the first something to be compared with.
- [ ] Check the library voice's commercial-use terms and whether its creator can withdraw
      it. A default voice that can vanish is a production risk, not a Slice 1 one.
- [ ] Measure time-to-first-byte against the <300ms target (R4.2.3), from Lagos (R9.1.8).

**Transport:** HTTP streaming with `AbortController` for cancellation. ElevenLabs also
offers a WebSocket API with lower TTFB and incremental *text* input; that becomes worth the
complexity in Slice 3 when LLM tokens stream in, and is a one-file change behind the
interface.

**Model:** `eleven_turbo_v2_5`, the low-latency model. Also provisional.

---

## STT / turn detection — OpenAI realtime (provisional, Slice 3)

**Chosen for integration speed. Gate A still decides.** Candidates there remain Intron
Sahara v2, Deepgram Flux and Spitch; Intron is still the likely accuracy winner on
Nigerian speech.

Verified against the live GA API on 2026-08-07 (`wss://api.openai.com/v1/realtime?intent=transcription`):

- **Native 8kHz μ-law** — `format: {type: "audio/pcmu"}` accepted, no transcoding hop.
- **Streaming interim results** (24 deltas), clearing R4.1.4.
- **Turn events** — `speech_started` / `speech_stopped`, so one provider can serve both
  `Transcriber` and `TurnDetector`. They stay separate interfaces regardless (R4.1.6).
- **Transcription quality on a Nigerian voice at 8kHz was exact**, including the two
  things that matter most: the brand name, and both number strings.
  - said: "…calling Ansa about my policy number A B four one seven, and my number is
    zero eight one three eight one seven eight five five zero."
  - heard: "…calling Ansa about my policy number AB417, and my number is 08138178550."

**ElevenLabs was ruled out for STT.** `/v1/speech-to-text` requires a complete file or
URL — batch transcription, which R4.1.4 makes disqualifying. Their model catalogue lists
only TTS and speech-to-speech models.

**Deepgram was passed over** for the provisional pick: TASKS itself describes Flux as
English-only and American-centric, and debugging a conversation loop through a
transcriber that mangles the developer's own accent is a bad position to build from.

**Outstanding:**

- [x] **Measured 2026-08-07: STT alone exceeds the entire end-to-end budget.**
      End of speech to usable transcript, over three realistic turns (1.8–3.2s audio):

      | model | avg | worst |
      |---|---|---|
      | `gpt-4o-transcribe` | 1131ms | 1146ms |
      | `gpt-4o-mini-transcribe` | 1009ms | 1061ms |

      R5.5 allows **800ms p50 for the whole hop** — STT *plus* LLM first token *plus*
      TTS first byte. STT alone is 1.3× that. A realistic turn lands near 1.8–2.1s once
      the other stages are added.

      It does **not** scale with utterance length: the portion after the VAD closes the
      turn is flat at 400–780ms from 1.8s to 10.3s of audio. Roughly half the total is
      the `silence_duration_ms: 500` VAD floor, which is tunable — but see below.
- [x] **False end-of-turn observed on the first test.** At `silence_duration_ms: 500` the
      VAD split a 10.3s utterance mid-sentence, committing a turn at a natural thinking
      pause. That is R9.1.6's false-EOT failure — the agent interrupting a caller who had
      not finished. **Lowering the threshold to buy back latency makes this worse.** The
      tradeoff is now measured rather than assumed, and it is the same tradeoff whichever
      provider wins Gate A.
- [ ] **Architectural consequence, to decide before tuning anything.** 800ms p50 is not
      reachable by waiting for a final transcript. The options, in rough order of
      appeal: start the LLM on the *interim* transcript at speech-stop rather than the
      final; lower `silence_duration_ms` and accept a measured false-EOT rate; use a
      provider with model-native eager end-of-turn (Deepgram Flux has one, this does
      not); or accept a slower turn. Instrument first — every stage now writes to the
      `latencies` table — then decide against real numbers.
- [x] **`gpt-live-transcribe` is unusable for telephony.** It rejects μ-law outright:
      *"Expected mono PCM16 at 24kHz"*. Would require a transcoding hop, which R4.2.4
      treats as a cost. Dropped.
- [ ] Re-test on real human speech. This was TTS audio: no disfluency, no restarts, no
      noise. PRD §9.1 warns a stack chosen on clean audio looks 10–20 points better than
      it performs.

### Turn detection: measured on live calls, 2026-08-07

Three configurations, same caller, same phone:

| | `server_vad` 500ms | `semantic_vad` low | `semantic_vad` auto |
|---|---|---|---|
| agent turns fully played | 0 | 1 | **3 of 4** |
| barge-ins (mostly spurious) | 5 | 2 | **1** |
| worst wait before committing | — | **7.6s** | 1.5s |
| caller transcripts | all fragments | fragments | mostly complete |

**`semantic_vad` with `eagerness: auto` is the setting.** It decides from what was said
rather than from a stopwatch, so it commits promptly on a finished sentence and holds
through a trailing clause. `server_vad` at any fixed value was wrong for someone.

**`eagerness: low` was a mistake worth remembering.** The reasoning — interrupting is
worse than waiting — sounded right and was wrong: it waited 7.6 seconds on a plain
greeting and the caller repeated themselves to check the line was alive. Lower is not
safer, it is differently wrong.

### Latency: the finding that outranks provider choice

Per-turn, measured on live calls from Nigeria:

| stage | avg |
|---|---|
| `stt_final` | 481–639ms |
| **`llm_first_token`** | **1038–1186ms** |
| `tts_first_byte` | 362–444ms |
| **caller stops → agent speaks** | **~2.0–2.2s** (target 800ms p50) |

`gpt-4o-mini` does not need 1.2s to produce a first token. **Most of every stage is
network round-trip from Nigeria to US-hosted APIs, paid three times, serially.**

This reframes Gate A. Swapping any one provider for another US-hosted one moves this
very little. What would move it: providers with African or European points of presence,
fewer serial hops (a speech-to-speech model collapses three round trips into one), or
hosting our own inference closer to callers. **R9.1.8 — measure round-trip from Lagos —
is not a formality; on this evidence it is the criterion most likely to decide the
stack, ahead of accuracy.**

**Note for any test harness:** VAD closes a turn only when it *hears* silence. Stopping
the audio stream is not the same thing and yields no transcript at all. Carriers stream
silence continuously; harnesses must too.

## Telephony — Twilio (provisional, Slice 1)

Media Streams over WebSocket, μ-law 8kHz, `<Connect><Stream>` for bidirectional audio.
The API is not the problem. Numbers are.

### Twilio cannot give us a Nigerian number

Checked against the live account on 2026-08-07: `AvailablePhoneNumbers/NG/{Local,Mobile,
TollFree}` all return **404** — the response Twilio gives for a country it does not sell,
not for one that is out of stock. Of the **54 countries purchasable on this account, the
only African ones are South Africa, Tunisia and Namibia.** Nigeria is absent.

**Why this is a product problem, not a logistics one.** PRD §1 puts the moat on being
Nigeria-first, and §1.1 argues we win because incumbents are indifferent to local
realities. A Nigerian company cannot publish a US number as its customer service line, and
its customers will not dial one. Inbound telephony in Nigeria is therefore not a detail to
sort out during onboarding — it is a precondition for having a product at all.

**What this does not block.** Slice 1's pipeline half closes fine on the US number
`+18148592625`: telephony, media streaming and TTS end to end. What stays open is the
Nigerian-line half — real Nigerian carriers, real line conditions, real latency.

**Routes worth investigating, none chosen:**

1. A Nigerian SIP trunk from a local carrier, reached over Twilio SIP interconnect. Keeps
   the Twilio adapter and changes only where calls originate.
2. A Nigerian CPaaS with inbound voice (Africa's Talking and similar). Means a second
   `TelephonyProvider` implementation — which is the work the adapter boundary exists to
   make cheap, and the first real test of whether that boundary holds.
3. NCC regulatory route: a Nigerian entity, local presence, numbers assigned directly.
   Slowest, and probably where this ends up for production.

**This must close before Slice 7** (first real design-partner tenant). It does not block
Slices 2–6, all of which are exercised over any working number.
