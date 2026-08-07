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

- [ ] Confirm `output_format=ulaw_8000` genuinely returns μ-law 8kHz. This was *not*
      verified: elevenlabs.io/docs now 308-redirects to app.buildwithfern.com, which 404s
      on every path tried. One authenticated request settles it. **If it fails, the choice
      is wrong** — a transcoding hop is real work and would change the comparison.
- [ ] Pick the actual Nigerian voice and confirm it survives 8kHz compression.
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
Not seriously compared against alternatives; Nigerian number availability is the open
question, not the API.
