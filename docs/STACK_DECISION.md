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

- [ ] **Time from `speech_stopped` to final transcript looks far too slow.** All deltas
      arrived in a burst *after* the turn closed, roughly 4s later on a 9.4s utterance —
      against an 800ms end-to-end budget. It may scale down with realistic 2–3s turns.
      **Measure this with short utterances first thing in Slice 3; if it holds, it
      changes the architecture, not just the provider.**
- [ ] Re-test on real human speech. This was TTS audio: no disfluency, no restarts, no
      noise. PRD §9.1 warns a stack chosen on clean audio looks 10–20 points better than
      it performs.

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
