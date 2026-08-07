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

## STT / turn detection — not chosen

Gate A decides. Candidates: Intron Sahara v2, Deepgram Flux, Spitch. The listen layer is
already split into `@ansa/transcriber` and `@ansa/turn-detector` so the winner may be two
different vendors (R4.1.6).

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
