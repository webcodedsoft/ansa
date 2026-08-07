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

### Transcription accuracy is now the largest gap (live probes, 2026-08-07)

Two probe calls after the conversation-quality pass. Every orchestration mechanism
behaved correctly and is visible in the log — non-zero `msHeard` on barge-in, echo
caught, backchannel handled, filler played, 9 of 9 turns played to completion,
`turn_to_audio` mostly 1248–1417ms. **What broke was transcription.**

| spoken | transcribed |
|---|---|
| "I'd like to know about my policy" | "I'd like to move one apology." |
| "…when my policy renews" | "…when my penalty is." |
| "this is on speaker, can you hear me?" | "I this is my new speaker, can I hear you?" |
| *(English)* | **"പലനി പിടിച്ച്"** — Malayalam script |

The last one matters most: `language: "en"` is set explicitly and the model still left
the language entirely. That is not a mishearing, it is a failure mode, and it happened
on ordinary Nigerian-accented speech over a normal line.

Downstream behaviour on this input was correct — the agent said it did not catch that
and asked the caller to repeat. The pipeline is sound and the input is not.

**This is the case Intron Sahara v2 exists for**, and it moves STT accuracy ahead of
latency as the thing Gate A most needs to settle.

**Refined the same evening, and the refinement matters.** A later call on the same voice
and the same line transcribed near-perfectly, including disfluencies:

> "Well, I'll use it for coding, right? You know, I asked about learning programming
> because I wanted to know how I use it to build up my knowledge." *(145 chars, one turn)*

The difference between that and "I'd like to move one apology" is **vocabulary, not
accent**. Every failure so far has been on an insurance term — "policy" became apology,
penalty, and course — while general English came through clean. So the problem is not
that the model cannot handle Nigerian speech; it is that it has no domain vocabulary and
**this provider offers no way to give it one**. The only mechanism available was the
`prompt` field, which recited its contents back as phantom caller turns.

That makes R4.1.3 (per-tenant keyterm boosting) a hard requirement of the provider
choice rather than a nice-to-have, and it is a structural gap here rather than something
tuning can close. Weight it accordingly at Gate A: a provider that accepts real
vocabulary boosting may beat one with better raw WER. It is also a second mark against
prompt/keyterm handling on this provider (the first being the hallucinated keyterm
prompt), so R4.1.3 vocabulary boosting remains unavailable here.

### Transcription model A/B, same voice and line (2026-08-07)

| | `gpt-4o-mini-transcribe` | `gpt-4o-transcribe` |
|---|---|---|
| "policy" | apology / penalty / course | **correct, twice in one sentence** |
| "policy number" | — | still "polling number" |
| `stt_final` | 443ms | 557ms (+114) |
| `turn_to_audio` | 1578ms | **1552ms** |

**`gpt-4o-transcribe` is now the default.** The mini variant was chosen on a synthetic
latency probe before any domain vocabulary was in play; mishearing "policy" is close to
fatal for an insurance agent, and the +114ms it costs on the STT stage disappears into
the variance of the other two. Latency was the wrong axis to optimise on here.

The compound "policy number" still fails, which is the same conclusion from a different
direction: the remaining errors are vocabulary, and **no model size fixes a word the
model has never been told to expect**. That is R4.1.3's job and this provider cannot do
it.

### Deepgram Flux — protocol PROVEN against the live API, 2026-08-08

Probe A, every assertion passed. Full script and reasoning in `docs/DEEPGRAM_PLAN.md`.

```
wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=mulaw&sample_rate=8000
  &eot_threshold=0.8&eot_timeout_ms=3000&keyterm=policy&keyterm=policy%20number&…
Authorization: Token <key>          # NOT Bearer — Bearer returns 401
```

| assertion | result |
|---|---|
| `Token` auth required, `Bearer` rejected | ✅ Bearer → 401 |
| composed URL connects (μ-law + 8000 + keyterms on Flux) | ✅ 101, `Connected` |
| μ-law 8kHz actually **decodes**, not merely accepted | ✅ "I would like to know about my policy." |
| per-word `confidence` varies (R4.1.5) | ✅ min 0.491, mean 0.993, max 1.000 |
| `end_of_turn_confidence` present and varies | ✅ n=22, 20 distinct, 0.002–0.860 |
| EU endpoint `api.eu.deepgram.com` usable with `flux-general-en` | ✅ same transcript |

**This clears the risk that stopped Intron.** μ-law at 8000 on Flux is documented-legal but
appears in no Deepgram example anywhere; it works.

**Two capabilities we have never had.** Per-word confidence that genuinely varies makes
R4.1.5 actionable — a 0.491 word is the signal to ask rather than answer. And
`end_of_turn_confidence` turns the false-EOT problem, which has been anecdotal all
session, into something measurable.

**Three corrections to the plan, found by running it:**

1. **The audio clock does not align.** `audio_window_end` runs ~270–300ms behind our byte
   counter, consistently — outside the ±150ms tolerance. Use our own counter for
   `TurnEvent.offsetMs`; log theirs as a diagnostic only. R4.1.7 correlation and the
   echo-suppression exact match both depend on this.
2. **No chunk coalescing needed.** 160-byte/20ms Twilio passthrough produced an identical
   transcript to 640-byte/80ms. Forward the carrier's frames untouched; 80ms is a
   recommendation, not a requirement.
3. **Malformed keyterms fail silently, confirmed empirically.** `keyterm=policy,premium`
   connected and returned a transcript identical to the no-keyterm arm. A typo disables
   boosting forever and nothing complains — this needs a unit test, not a comment.

**Still unproven, and it is the only thing that matters:** whether keyterm boosting
rescues "policy" on *real* Nigerian-accented caller audio. The probe used TTS, which
STACK_DECISION already records as unable to reproduce the failure. **Probe B needs
recorded caller audio — `audio_segments`, Slice 2 — and remains the deciding measurement.**

### Deepgram Flux on a live call — it hears "policy" (2026-08-08)

First real call with `LISTEN_PROVIDER=deepgram`, keyterm boosting on, same voice and line
as every OpenAI call today.

| | OpenAI `gpt-4o-transcribe` | Deepgram Flux |
|---|---|---|
| "I'd like to know about my policy" | *"I'd like to move one apology."* | **correct** |
| "when it will expire" | *"why my policy was fired"* | **correct** |
| "my policy" (later turn) | *"my puppy"* | **correct** |
| `turn_to_audio` | 1551–1911ms | **1153ms avg, 813ms best** |
| noise/hallucination filtered | Malayalam, Māori, phantom turns | none needed |

Eight turns, complex disfluent sentences held together intact:
*"Okay. Can you do that for me? But, like, you had... you do not have this number."*

**Keyterm boosting is the difference.** Every failure this provider fixes is a term on the
list, and it is the capability neither of the other two candidates could offer — OpenAI
has none, and Intron's docs say none.

**It is also faster**, which was not expected. Flux returns the transcript in the same
frame as end-of-turn, so there is no post-turn transcription wait at all. `turn_to_audio`
touching 813ms is the first time the R5.5 target has been in reach this session.

**One bug this exposed, ours:** the adapter emitted the transcript before the turn event,
so `stt_final` measured each turn against the previous one and reported 12.7s for a stage
that takes none. Order corrected — turn event first.

**Still to measure:** the EU endpoint (`api.eu.deepgram.com`), which is a one-variable
experiment on the Nigeria round-trip and currently untested; and per-word confidence in
production, now that it is available for the first time (R4.1.5).

### Intron Sahara v2 — attempted and DROPPED 2026-08-07

**Not pursued.** Kept here so nobody spends another evening on it without knowing what
happened. Revisit only if their support answers the payload question below, or if
Deepgram fails on Nigerian accents badly enough to make a blocked API worth unblocking.

Streaming exists, so R4.1.4 is satisfied and TASKS' main worry is answered. Connection,
auth and session creation all work: `wss://infer.voice.intron.io/stt/v1/stream`, Bearer
token, `101` upgrade, `SESSION_CREATED`, and it accepts `sample_rate: 8000`.

**Audio cannot be sent.** Every payload shape their documentation describes is rejected
with the same generic `INPUT_ERROR: "Invalid base64 audio payload"` — raw PCM16 base64,
WAV-wrapped per chunk, unpadded base64, data-URI prefixed, and the whole clip as a
single WAV. Four encodings, one error, so the message is probably misleading about the
real cause. **Next step is voice@intron.io, not more guessing.**

Documented gaps found on the way, all Gate A input:

- **PCM16 only** — no μ-law, so a transcoding hop is required (a cost under R4.2.4).
- **No turn detection at all** — the caller sends `COMMIT`. This forces CLAUDE.md's
  predicted composition: Intron transcribes, another provider detects turns, audio
  fanned out to both, and double STT cost (R4.1.9 exists for this).
- **No phrase boosting**, per their docs — which undercuts the main strategic argument
  for Intron. Note though that `SESSION_CREATED` returns a `use_prompt_id` config field
  the docs do not mention; worth asking about, since R4.1.3 may be available after all.

### The A/B was run on the wrong audio, and the earlier conclusion was too strong

The comparison used TTS audio in a Nigerian voice at 8kHz μ-law. On it,
`gpt-4o-transcribe` scored **5 of 6 exact and got "policy" right every time**, including
the naira amount and the premium question — the exact phrases that fail on live calls.

Two consequences.

**The methodology cannot answer the question.** Clean audio does not reproduce the
failure, so it would have flattered both providers equally. PRD §9.1 says this outright:
a stack chosen on clean read-aloud looks 10–20 points better than it performs. **A real
provider comparison needs recorded caller audio** — `audio_segments` in Slice 2, and the
Gate A corpus proper.

**"It is vocabulary, not accent" was too strong.** Same vocabulary, clean audio, near
perfect. The variable is not the words alone but the words surviving a degraded channel:
domain terms fail first because they are low-probability, and what degrades them is real
accented speech over a real line. Keyterm boosting still matters — it raises exactly
those probabilities — but it is a mitigation for channel degradation, not a fix for a
vocabulary the model lacks.

### The transcriber leaves the language, and it cannot be filtered out

Twice on live calls, from ordinary Nigerian-accented English with `language: "en"` set
explicitly:

- `"പലനി പിടിച്ച്"` — Malayalam
- `"Iwi arotakehia e te kāwanatanga."` — Māori

The first is caught by a non-Latin script check. **The second is not, and deliberately
is not.** The heuristic that would catch it — reject text containing no common English
function words — also rejects Nigerian Pidgin ("Abeg, wetin dey happen?"), which this
product exists to serve and which is a named Gate A criterion. Trading a real
requirement for a cosmetic one is the wrong trade, and the asymmetry stands: nonsense
costs one turn, ignoring a Nigerian caller is the premise failing.

Left unfiltered, it reaches the LLM, which says it did not catch that and asks the
caller to repeat. That is the correct behaviour and it is what happens today.

**For Gate A this is a scoring category, not a bug to fix downstream.** A transcriber
that abandons the requested language on accented input is failing at something WER does
not measure — the output is not a wrong word, it is not the language. Ask each candidate
for it directly.

### Correcting mishearings after the fact does not converge

Tried, measured, and reported as a partial dead end so nobody rebuilds it.

Across live calls "policy" has been transcribed as **apology, penalty, polling, course**
and **puppy**. A correction map was built for the unambiguous multi-word cases
("polling number" → "policy number") and it is worth keeping, but on the very next call
it fired zero times because the new mistake was not in it. Every call invents another.

The list is open-ended, so enumerating it cannot converge. Worse, single-word entries are
actively unsafe: "apology", "penalty" and "police" are real words a caller may mean, and
rewriting them on sight is worse than the mishearing. And nothing may be written back
into the raw transcript, which is the eval corpus and the review loop's ground truth
(R9.2.3–4).

What is left in our control is a prompt hint — the model has context and disambiguates
better than a regex — but that repairs meaning after decoding, not the decoding itself.

**This is the argument for R4.1.3 as a provider requirement rather than a feature.**
Keyterm boosting changes what the transcriber is listening for; correction only edits
what it already got wrong. A provider that accepts a vocabulary list containing "policy",
"premium", "naira" and a tenant's product names is worth more here than one with better
raw WER, and this provider offers no mechanism for it.

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
