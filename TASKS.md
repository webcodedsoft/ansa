# Ansa — Build Order

**Read this first, every session. Update it before you stop working.**

Companion to `PRD.md`. Requirement IDs (R4.1.1 etc.) refer to it.

---

## The rule that governs this file

**A slice is done when a phone call proves it.** Not when the code compiles, not when the
tests pass. Every slice below ends with something you can demonstrate by dialling a
number.

**Inbound only, until inbound is right.** Outbound calling, dialer campaigns and callbacks
are not in this file. They are not hard to add; they are a distraction from the thing that
has to be excellent first. The gate for starting outbound work is Slice 7a passing — 20
unscripted calls, measured task success, zero wrong-number confirmations. Not "inbound
mostly works."

**Two languages, one boundary.** The product is **TypeScript / NestJS** — `apps/` and
`packages/`. `eval/` is Python measurement tooling that runs by hand, never imports from
the monorepo, and is never imported by it. If a build session is writing Python, it is in
the wrong place; if a Gate A session is writing NestJS, same. There is no third case.

The previous build was lost. The lesson taken from it is not "back up your code" (though:
git remote on day one). It is that the stack was chosen before the hardest problem was
measured — which is why Gate A exists, and why it must close before Slice 4.

---

## Slice 1 — One call, one sentence

**Start here.** This is day one.

**Goal:** A phone number that answers, says one Nigerian-accented sentence, and hangs up.
Proves telephony, media streaming and TTS end to end.

**On providers:** pick whichever candidate is quickest to integrate and mark it
*provisional* in `docs/STACK_DECISION.md`. You are not committing — Gate A commits. The
abstraction is what makes this safe, so the rule in CLAUDE.md is load-bearing here: no
vendor types outside `packages/providers/*`. Break it and Gate A stops being a decision
you can act on.

- [ ] Git repo + remote, pushed. Do this literally first.
      *Repo initialised, committing locally. Remote deliberately deferred by Vera —
      still the open risk this checkbox exists for.*
- [x] Turborepo + pnpm monorepo. `apps/api` (NestJS), `packages/shared`, `packages/config`.
      *Also `packages/providers/{telephony,tts,listen/transcriber,listen/turn}`. Interfaces
      only, no implementations. `pnpm build && pnpm typecheck && pnpm lint` all green.*
- [x] Twilio number provisioned, webhook wired, ngrok for local dev.
      *`+18148592625` (US). Two real calls answered on 2026-08-07 from `+2348138178550`.
      Twilio sells no Nigerian numbers — see the session log below.*
- [x] Bidirectional media stream over WebSocket, μ-law 8kHz, audio flowing both ways.
      *Inbound proven: 120 × 160-byte μ-law frames received and counted. Outbound
      `send`/`mark`/`clear` implemented but not yet exercised — nothing generates audio
      until step 3.*
- [x] TTS provider interface + chosen implementation behind it (R4.1.1 principle applied
      to TTS too). No vendor types outside the adapter.
      *ElevenLabs, provisional, recorded in `docs/STACK_DECISION.md`. Unit-tested against
      an injected fetch; it has never called the live API. `ulaw_8000` is still unconfirmed
      — see the outstanding list in that file.*
- [ ] Agent answers, speaks one sentence in the chosen Nigerian voice, ends the call.
      Make it the real greeting — "Thank you for calling Ansa" — so the phone-line name
      test (PRD §1.0) happens on day one rather than after the logo is designed.
      *Answers, speaks and ends the call — proven on two real phone calls. But the voice
      is a premade American one, because the free ElevenLabs plan cannot use library voices
      via the API. **This box stays open until Olabisi speaks down a real line.***
- [ ] Add "Ansa" to the default keyterm vocabulary. Callers will say the brand name back
      and the STT must not mangle it. *Waiting on Slice 3 — there is no STT to configure.*
- [x] Structured logging with `call_id` on every line.
      *JSON to stdout, `child({ callId })` bound at stream start. Every call-scoped line
      in the runs above carries it.*

**Done when:** you call the number from your phone and hear a Nigerian voice.

**Session log**

- *2026-08-07 — Step 1 of 4 (scaffold) complete.* Monorepo up on Node 24 / pnpm 11.5.2 /
  turbo 2.10.8 / NestJS 11. TypeScript pinned to **5.9.3, not 7.x**: TS 7 is current
  `latest` on npm but `typescript-eslint@8.66` peers cap at `<6.1.0`, so taking TS 7 means
  giving up linting. Revisit when typescript-eslint ships TS 7 support.
- CLAUDE.md rule 2 is enforced by lint, not by review: `@ansa/config` exports a
  `noVendorSdks` block banning `twilio`, `@deepgram/*`, `elevenlabs`, `@anthropic-ai/*`,
  `spitch`, `intron` outside `packages/providers/*`. Verified both directions — the import
  errors in `apps/api` and passes in `packages/providers/telephony`. Add new vendors to
  `VENDOR_SDK_PATTERNS` as they are adopted.
- Not yet done and not claimed: TTS implementation (step 3), media stream (step 2),
  the "Ansa" keyterm default, and call_id on log lines — the logger has `child()` for it
  but nothing emits a call_id until there are calls.
- Watch out: the Console Ninja VS Code extension injects a non-JSON banner into the API's
  stdout when run from the editor. Harmless, but it breaks "every log line is structured"
  if you are reading logs from the IDE terminal.

- *2026-08-07 — Step 2 of 4 (webhook + media stream) complete.* `POST /telephony/voice`
  returns `<Connect><Stream>` TwiML; the media socket at `/telephony/media` receives μ-law
  8kHz frames. Verified against a scripted fake carrier: 200 + TwiML, socket opens, 120 ×
  160-byte frames counted (19,200 bytes), stop frame closes the stream cleanly.
- Webhook signature verification is on by default and was tested in all four states:
  unsigned → 403, malformed signature → 403, signed with the wrong token → 403, correctly
  signed → 200. `TWILIO_VERIFY_SIGNATURES=false` exists for local work and must never be
  false in front of a public tunnel. Copy `.env.example` to `.env` to configure.
- Two defects the fake carrier caught that unit tests would not have:
  1. Nest answers POST with **201**; the carrier requires **200** or it drops the call.
     Fixed with `@HttpCode(HttpStatus.OK)`.
  2. `incremental: true` plus `nest build`'s `deleteOutDir` silently stopped emitting
     `health.controller.js` — tsc writes `.tsbuildinfo` outside `outDir`, so after dist
     was wiped it still believed the file was emitted. Incremental is now off repo-wide;
     turbo caches builds anyway. **If a file goes missing from `dist`, look here first.**
- `<Connect><Stream>` is deliberate — `<Start><Stream>` only forks audio to us and cannot
  play anything back, which would make step 4 impossible. The TwiML also ends after
  `</Connect>` on purpose: with no next verb, closing the socket hangs up the call, so
  `hangUp()` needs no REST credentials.
- Not done: nothing sends audio yet, and no `mark` has round-tripped. Step 3 (TTS) is
  what makes the outbound half real.
- `tools/fake-carrier` impersonates the carrier end to end — webhook, TwiML, media socket,
  μ-law frames — so the call path can be exercised without ngrok, a number, or telephony
  minutes. It counts outbound media frames and marks, which is how step 4 will prove the
  greeting actually reached the caller rather than merely being queued. See its README.
  It does **not** replace the real call: a slice is done when a phone proves it.
  `tools/*` is now a pnpm workspace root.

- *2026-08-07 — Step 3 of 4 (TTS) complete in code, unverified against the live API.*
  ElevenLabs adapter behind `TtsProvider`: HTTP streaming, `cancel()` backed by an
  `AbortController`, chunks stamped with their offset inside the utterance. No new
  dependency — global `fetch`. Nine tests against an injected fetch; 37 in the repo.
- Defect the tests caught: errors raised *before* the first `await` — an unsupported audio
  format, say — were emitted before the caller could register `onError`, so they vanished
  and the turn would have gone silent with nothing logged. Synthesis now starts in a
  microtask. **Any listener-registered-after-return API in this repo has this hazard.**
- `toOutputFormat` throws on an unsupported format instead of falling back. A silent
  fallback would reintroduce exactly the transcoding hop R4.2.4 exists to avoid.
- **Blocking step 4:** `ELEVENLABS_API_KEY`, and a voice id. `output_format=ulaw_8000` is
  still unconfirmed — elevenlabs.io/docs 308-redirects to app.buildwithfern.com which 404s,
  so it could not be checked from docs. One authenticated request settles it and that is
  the first thing to run when the key lands. If μ-law is not native, the provider choice
  is wrong and should be revisited rather than papered over with a transcoder.

- *2026-08-07 — Functions are expressions, not declarations.* 35 conversions across 13
  files, enforced by `func-style: expression` + `prefer-arrow-callback` in `@ansa/config`.
  Class methods exempt (NestJS needs classes). Consequence: `const` does not hoist, so
  helpers must sit above their first use.
- *2026-08-07 — Step 4 of 4 (greeting) wired, proven against a stub, not against a phone.*
  `speakGreeting` synthesises "Thank you for calling Ansa.", streams chunks to the carrier,
  places a mark, and hangs up **when the mark comes back** — not when synthesis finishes,
  because queued audio has not been heard and hanging up early truncates the greeting.
- Failure paths, all covered by tests: synthesis error → hang up (never an open silent
  line); mark never returned → 15s timeout → hang up; caller hung up first → do not hang
  up again; hang up at most once. 9 tests on the greeting, 46 in the repo.
- **`ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` are now required at boot** — an agent
  that cannot speak has nothing to offer a caller, so it fails at startup rather than
  mid-call. `ELEVENLABS_BASE_URL` overrides the host to point at a stub.
- The fake carrier now **echoes marks back** the way the real one does. Without that the
  agent can never learn the caller heard anything, and every call would hit the timeout.
- Proven end to end against a stub ElevenLabs: `output_format=ulaw_8000` requested, correct
  text and voice sent, 8,000 bytes of μ-law returned as 20 media frames, mark echoed,
  hangup on mark at 273ms. **The real API has still never been called.**
- Open: the adapter forwards TTS chunks at whatever size the provider emits (400 bytes in
  the stub). Real Twilio prefers ~160-byte/20ms frames. It accepts larger and buffers, but
  chunk size affects how fast `clear()` can cut audio off, so revisit at barge-in.
- Slice 1's remaining work is not code: a number, credentials, ngrok, a paid ElevenLabs
  plan, and a phone call.

- *2026-08-07 — **Twilio has no Nigerian numbers.*** `AvailablePhoneNumbers/NG/*` returns
  404 (the "country not sold" response, not "out of stock"). Of 54 purchasable countries on
  the account, the only African ones are **South Africa, Tunisia, Namibia**. See
  `docs/STACK_DECISION.md` for routes out. **Blocks Slice 7**, not Slices 2–6.
- The account's one number is `+18148592625`, a **US** number, webhook now pointed at
  `<ngrok>/telephony/voice` (was a dead tunnel from the lost build). It closes Slice 1's
  pipeline half. The Nigerian-line half — real carriers, real line quality, real latency —
  stays open and cannot be closed with Twilio alone.
- Latency watch, third sighting: TTS time-to-first-byte was **629ms through ngrok** versus
  256–277ms hitting ElevenLabs directly, against a <300ms target. ngrok inflates it, so this
  is not the production number — but latency has now looked tight from every angle measured,
  and R9.1.8's Lagos measurement is looking like the decisive Gate A test rather than WER.

- *2026-08-07 — **First real phone calls.*** Two inbound calls from `+2348138178550` to
  `+18148592625`, both answered, both spoke the greeting, both hung up cleanly. Slice 1's
  pipeline half is proven end to end on real telephony.
- **The mark round-tripped on a real carrier**, which no stub could establish. Call 1:
  synthesis done at 982ms, mark back at 2740ms — a 1.76s gap that is the audio genuinely
  playing out to the caller. Call 2: 562ms → 2385ms, a 1.82s gap. Both match the ~1.6s
  greeting. This is the direct evidence that hanging up on `onDone` would have truncated
  the greeting, and that waiting for the mark is what prevents it.
- Inbound audio arrived as expected: μ-law 8kHz, 143–158 frames of 160 bytes per call.
- **Latency, with real numbers at last: TTS time-to-first-byte was 959ms on the first call
  and 468ms on the second, against a <300ms target (R4.2.3).** Three to one over budget on
  the cold call. The path was contorted — Nigerian mobile → international → Twilio US →
  ngrok → laptop in Nigeria → ElevenLabs — so this is not the production number. But every
  measurement taken from every angle has now come in over budget, and R9.1.8 should be
  treated as a live risk to the provider choice rather than a formality.
- The first call being roughly twice the second suggests a cold-start cost worth isolating:
  TLS handshake to ElevenLabs, ngrok tunnel warm-up, or model load. Connection reuse across
  calls is worth measuring in Slice 3.
- **Slice 1 remains open.** "Done when: you call the number and hear a Nigerian voice." The
  voice was American. Two things are still needed: a paid ElevenLabs plan for Olabisi, and
  eventually a Nigerian number that Nigerian callers can actually dial.

- *2026-08-07 — **Olabisi heard on a real call. Nigerian, unclipped — and "Ansa" arrives as
  "Anza".*** Vera called and confirmed all three: the voice reads as Nigerian through the
  band-pass, nothing is clipped at either end, and the brand name is altered.
- **Diagnosed by A/B: the model is right, the channel is wrong.** The same utterance at
  `pcm_24000` is a correct "Ansa"; at `ulaw_8000` it is "Anza". /s/ carries its energy above
  4kHz, the telephone passband ends near 3.4kHz, and between a nasal and a vowel the ear
  fills the stripped fricative with the voiced neighbour. **No respelling can fix this** —
  respelling changes what the model says, and the model was already correct.
- This is PRD §1.0's phone-line test half-failing, and §1.0 calls a name our own pipeline
  mishears disqualifying. The name is not yet cleared (CAC, trademark, domains all still
  open), so changing it is still nearly free — cheaper now than after a logo exists.
- Whatever is decided, **the keyterm vocabulary needs both "Ansa" and "Anza"** (R4.1.3).
  The agent introduces itself down the same degraded channel, so callers will say back what
  they heard. That is a Slice 3 action, and the second half of §1.0's test — does the STT
  transcribe it correctly — cannot be run until then.
- Pronunciation belongs in `packages/normalizer` when it lands in Slice 4, not in a prompt
  and not in the greeting constant. CLAUDE.md: nothing reaches TTS unnormalized, static
  greetings included.

- *2026-08-07 — ElevenLabs verified against the live API.* `output_format=ulaw_8000`
  returns genuine raw μ-law 8kHz: `content-type: audio/ulaw`, no container, and a decoded
  waveform that is speech rather than noise. **R4.2.4 satisfied, no transcoding hop.**
- Voice chosen is `eOHsvebhdtt0XFeHVMQY` = **Olabisi — Warm and Relatable**, labelled
  `accent=nigerian locale=en-NG use_case=conversational gender=female age=young`. The right
  shape: Nigerian and conversational rather than narration.
- **Blocker: the ElevenLabs account is free-tier and cannot use Voice Library voices via
  the API** (`402 paid_plan_required`). The 22 premade voices work but none are Nigerian,
  so the μ-law check was run against a premade voice. A real call with Olabisi needs a paid
  plan. Nothing in the code changes — only the plan.
- **Watch: time to first byte is 256–277ms against a <300ms target (R4.2.3)**, measured
  laptop-to-ElevenLabs, not from a Lagos datacentre under load. Almost no headroom. This is
  an early signal that latency, not accuracy, may be what decides the provider at Gate A.
- Verification lesson worth keeping: magic-number sniffing cannot tell μ-law from MP3,
  because μ-law encodes near-silence as `0xff`/`0x7f` and those are exactly MP3 sync words.
  The first two verifier runs produced a false "SUSPECT". What actually settles it is
  decoding as μ-law and checking the waveform statistics.

---

## Slice 2 — The event log and the call viewer

**Goal:** Before the pipeline gets complicated, make it observable. Building this now is
the difference between debugging in an hour and debugging in a week.

- [x] Supabase/Postgres schema v1 with `tenant_id` on **every** table from the start (R7.1).
      *8 tables, applied to Supabase (Postgres 17.6). `tenants` isolates on its own PK.*
- [x] Postgres RLS policies enforcing isolation at the data layer (R7.2). Write the
      adversarial test that proves tenant A cannot read tenant B's calls — this test
      lives forever and runs in CI.
      *11 adversarial tests in `packages/db/src/rls.test.ts`, all passing. **Not yet
      wired into CI** — there is no CI pipeline yet.*
- [ ] Call event log tables: calls, turns, transcripts, tool_invocations, latencies,
      audio_segments (R8).
- [ ] Audio segment storage with per-tenant retention config.
- [ ] Internal call viewer (R8.1): plain server-rendered page, one call, turn by turn,
      with audio playback, transcripts, confidences, latencies. Ugly is fine. Useful is
      mandatory.

**Done when:** the Slice 1 call is fully reconstructable in the viewer.

**Session log**

- *2026-08-07 — Schema v1 and RLS applied to Supabase.* 8 tables, `tenant_id` on all seven
  that are not the tenant itself. No `direction` column anywhere; `audio_segments.source`
  is the audio track, a different concept. `carrier_call_id` is named for the concept, not
  the vendor.
- **The adversarial test immediately caught a real isolation failure, and it is one that
  is invisible to inspection.** Supabase's default `postgres` role has **`rolbypassrls =
  true`** — an attribute *separate from superuser* that defeats `FORCE ROW LEVEL SECURITY`
  entirely. Every policy existed, `pg_policies` listed them, `relforcerowsecurity` read
  true, and tenant A read tenant B's calls anyway. **Had the app shipped on Supabase's
  default connection string, every tenant would have seen every other tenant's data.**
- Fix: the app connects as **`ansa_app`** (`rolbypassrls = false`); `postgres` is used only
  for migrations. `.env` now carries `DATABASE_URL`/`DIRECT_URL` for the app and
  `MIGRATION_DIRECT_URL` for schema changes. **Never point `DATABASE_URL` at `postgres`.**
- Migration `0002` now *asserts* `ansa_app` lacks BYPASSRLS and raises if it does, so the
  regression cannot land silently a second time.
- Lesson worth generalising: checking that a policy *exists* proves nothing. The only
  evidence that counts is trying to cross the boundary and failing. That is why R7.2 asks
  for an adversarial test rather than a schema review.
- On TypeORM (Vera's call, overriding my Kysely recommendation): every tenant-scoped query
  must run inside a transaction that has done `set_config('app.tenant_id', …, true)`. A
  bare `dataSource.getRepository()` has no tenant context and — because
  `app.current_tenant()` returns NULL when unset — sees **zero rows**. It fails closed,
  which is the safe direction, but it will look like "the database is empty" rather than
  like a bug. A `withTenant()` helper is the next thing to build.
- Timeouts: `packages/db` uses a 60s vitest timeout. These are network round trips to
  us-east-2 from Nigeria and the 5s default fails on latency, not correctness.

---

## Slice 3 — The conversation loop

**Goal:** A real back-and-forth conversation. No tools yet.

- [ ] `Transcriber` interface + chosen implementation, streaming with interim results and
      word-level confidence (R4.1.4–5).
- [ ] `TurnDetector` interface + chosen implementation, emitting speech-start,
      end-of-turn, eager-end-of-turn and turn-resumed (R4.1.6). Separate package from the
      transcriber even if the same vendor serves both today.
- [ ] Audio fan-out in one place: the same stream feeds every listen provider. Not
      scattered through the pipeline.
- [ ] Orchestrator correlates turn events and transcripts by timestamp, never assuming one
      connection (R4.1.7).
- [ ] If using eager EOT: turn-resumed cancels **all** in-flight speculative work — LLM
      request, tool dispatch, TTS synthesis (R4.1.8). Speculation without reliable
      cancellation is worse than none.
- [ ] Per-provider cost tracking on the listen layer (R4.1.9).

**Session log — 2026-08-07**

- The conversation loop works on real calls: greeting, listen, transcribe, think, speak,
  barge-in, repeat. Four live calls drove four rounds of fixes.
- **Bugs the first live call found that no test would have.** Keyterms passed as a
  transcription `prompt` came back as phantom caller turns ("Expect these terms: Ansa,
  policy, premium, naira." ×5) and the agent answered its own configuration. Every agent
  turn was barged-in at `charsHeard: 0` by its own audio echoing through the caller's
  handset. Each sentence overwrote the previous synthesis so two audio streams
  interleaved. `tts_first_byte` measured against a mark that was never set.
- **Turn detection is `semantic_vad` / `eagerness: auto`**, chosen on measurements — see
  the table in `docs/STACK_DECISION.md`. `server_vad` at any fixed silence value was
  wrong for someone, and `eagerness: low` waited 7.6s on a greeting.
- **The dominant latency is distance, not the stack.** ~2.0s per turn against 800ms,
  with `llm_first_token` the largest stage at ~1.1s. All three stages pay a Nigeria→US
  round trip, serially. No configuration fixes this and swapping to another US-hosted
  provider barely will.
- Still open in this slice: latencies are logged but not yet written to the `latencies`
  table; no fallback VAD behind `TurnDetector`; no per-provider cost tracking; the
  echo guard is a fixed 400ms floor rather than real echo cancellation.
- [ ] Fallback path: our own VAD/endpointing behind the same `TurnDetector` interface, so
      a vendor outage degrades rather than stops the service.
- [ ] LLM provider interface + Claude implementation.
- [ ] Orchestrator: turn management, conversation state, context assembly.
- [ ] **Barge-in** (R6.1): caller interrupts → TTS stops within 150ms → unplayed output
      discarded from context. Build it now; it cannot be retrofitted.
- [ ] Short-turn enforcement (R6.3).
- [ ] Latency instrumentation on every stage, written to the event log.
- [ ] Every stage's events flowing into the viewer from Slice 2.

**Done when:** you can hold a 2-minute natural conversation, interrupt it mid-sentence,
and see every stage's latency in the viewer.

---

## Gate A — Prove the stack on real conversation

**Goal:** Know, with numbers, which STT and TTS providers handle a real Nigerian caller
having a real conversation on a real phone line. **Two working days.**

**This is a gate, not a slice.** It has no application code and produces no callable
feature, so it does not block starting the build — the provider abstraction (CLAUDE.md)
is what buys you the right to defer it. But it MUST close before Slice 4, because from
Slice 4 onward you are tuning against a specific provider's error profile: normalizer
rules, confidence thresholds, readback aggressiveness, keyterm strategy. Switching after
that means redoing all of it.

Run it in parallel with Slices 1–3 if you can. Recording the corpus is calendar work
(recruiting speakers, scheduling calls), not keyboard work, so it overlaps well with
building.

Scripted read-aloud is not enough on its own. It measures accent handling and misses
everything that actually breaks a live system: hesitation, self-correction, restarts,
fillers, talking over the agent, trailing off, code-switching mid-sentence. A stack chosen
on clean read-aloud will look 10–20 points better than it performs.

- [ ] Git repo + remote, pushed. Do this literally first.

**Tier 1 — number strings (half a day, still worth it)**
- [ ] ~30 scripted lines: policy numbers, phone numbers, naira amounts, reference codes.
      Real callers *do* read these aloud, so scripted capture is representative here.
- [ ] Recorded over a real phone call. The script is the ground truth — no transcription.

**Tier 2 — real conversation (the tier that decides the stack)**
- [ ] Source ≥30 minutes of genuine two-sided conversational audio, in this order of
      preference:
      1. **Anonymized recordings from a real Nigerian call centre.** Ask a design
         partner — you have insurance contacts. Real callers, real intents, real
         frustration. Needs consent + NDPR review, and is worth the ask.
      2. **Wizard-of-Oz calls.** A human plays the agent following a service persona;
         the caller believes they're calling a real company. Authentic caller behaviour
         with no agent built yet. Use `TEST_PROTOCOL.md`.
      3. Role-play where both sides know it's a test. Weakest, still beats read-aloud.
- [ ] 8–10 speakers, mixed language backgrounds, mixed line quality, at least two on poor
      connections and two in noisy environments.
- [ ] Label every caller turn: `number_string`, `intent_statement`, `disfluent`,
      `interruption`, `pidgin_mix`, `noisy`, `emotional`.
- [ ] **Ground truth by consensus adjudication (R9.1.4):** run all candidates, accept
      segments where all agree, hand-transcribe only the disagreements. Roughly a third
      of the manual work, and it doesn't bias truth toward any candidate. Never seed
      ground truth from one provider's output.
- [ ] Scoring script: WER per category for prose, **exact match** for number strings.
      Report `disfluent` and `interruption` separately — that gap is what read-aloud
      hides. *(Harness exists: `eval/`. Run `python3 selftest.py` first to see the
      metrics working on synthetic data, then replace with real recordings.)*

**Turn-taking scoring (separate from transcription — R9.1.6)**

WER measures the transcriber and says nothing about the turn detector, and the two may
come from different vendors. Score both or you'll pick a provider blind on half the job.

- [ ] Human-label true turn boundaries on the Tier 2 audio (end of speech per caller turn,
      plus every genuine interruption point).
- [ ] Measure per turn-detection candidate:
      - end-of-turn latency p50/p95 from true end of speech
      - **false EOT rate** — would have cut the caller off mid-thought
      - **missed EOT rate** — would have sat in silence
      - speech-start latency (bounds barge-in responsiveness)
      - eager-EOT fire-and-retract rate, where supported
- [ ] Produce **two rankings**: best transcriber, best turn detector. The winner may be one
      provider or two (R4.1.6).

**Latency from Lagos (R9.1.8)**

- [ ] Measure real round-trip to every candidate **from Lagos**, not from vendor
      benchmarks. Against an 800ms budget, hosting region can disqualify a provider on its
      own regardless of accuracy. Check this early — it may shorten the list before you do
      the scoring work.

**Candidates (narrowed from five to three)**

- [ ] Intron Sahara v2 — strongest reported accuracy on African numbers, names, noise and
      overlapping speakers; trained partly on call-centre audio; Pidgin supported.
- [ ] Deepgram Flux — model-native end-of-turn detection, eager EOT, keyterm prompting,
      built for high-interruption call-centre use; English-only and American-centric.
- [ ] Spitch — Nigerian TTS/STT including Pidgin, clean SDK and docs.
- [ ] Dropped: Whisper (batch, too slow), N-ATLAS (unclear API maturity). Revisit only if
      all three above fail.

**Verify before committing (not answerable from marketing)**

- [ ] Intron: WebSocket streaming, native 8kHz μ-law, interim results, word-level
      confidence, keyterm boosting, concurrency limits, pricing.
- [ ] Spitch TTS: streaming, time-to-first-byte, μ-law output.
- [ ] All: hosting region and concurrency ceilings.
- [ ] Benchmark STT: Intron (Sahara v2), Spitch, Deepgram Nova, Whisper-family, N-ATLAS.
      Same audio, same script, same conditions.
- [ ] Benchmark with and without keyterm/vocabulary boosting (R4.1.3).
- [ ] Evaluate TTS candidates on Nigerian-accent naturalness: ElevenLabs professional
      clone, Spitch, Deepgram. Get 5 Nigerian listeners to rank blind.
- [ ] Measure TTS time-to-first-byte and confirm μ-law 8kHz native output (R4.2.4).
- [ ] Write `docs/STACK_DECISION.md`: the numbers, the choice, the runner-up, and what
      would make you switch.

**Done when:** `docs/STACK_DECISION.md` contains two ranked tables — transcription accuracy
per category, and turn-detection behaviour — plus Lagos round-trip figures, the chosen
composition, and the specific number that would make you switch. **Blocks everything
below.**

> **Why this isn't replaced by post-call review.** The review loop (Slice 4a) is better
> than this corpus in every way except one: it needs production calls, which need a
> shipped stack, which needs the provider already chosen. It optimizes *within* a stack.
> This slice *picks* the stack. Wizard-of-Oz exists precisely to get real conversational
> audio before an agent exists — and the transcription work is the same work either way.
> Two days now, or a retune with real customers on the line later.

---

---

## Slice 4 — The number normalizer

**Goal:** The thing that makes it feel Nigerian rather than translated.

- [ ] Outbound normalizer as a standalone, pure, unit-tested package
      (`packages/normalizer`). Nigerian phone grouping, naira amounts, dates, times in
      WAT, reference-number spelling with phonetic clarification (R4.3).
- [ ] Comprehensive test suite. This package should have the highest coverage in the repo.
- [ ] Wire it between LLM output and TTS. **Nothing** reaches TTS unnormalized.
- [ ] Inbound: number capture from speech + mandatory readback confirmation (R4.3.1–2).
- [ ] DTMF keypad fallback after two failed attempts (R4.3.3).
- [ ] Add number-capture scenarios to the eval harness and track first-try accuracy
      against the ≥90% target.

**Done when:** you can read a policy number and a naira amount to the agent over the
phone, it reads them back correctly the way a Nigerian would say them, and the eval
harness scores it.

---

## Slice 4a — The post-call review loop

**Goal:** Every call that goes badly teaches the system something. Built here, once
there's a real conversation and a normalizer to feed, and it runs forever after.

- [ ] Automatic post-call quality scan (R9.2.1): low-confidence turns, repeated
      clarifications, failed number captures, DTMF fallbacks, silences over 2s,
      escalations, abrupt hangups, tool timeouts.
- [ ] Severity scoring and a **review queue** in the internal call viewer (R9.2.2).
- [ ] Transcript correction UI: play the audio, fix the text, save (R9.2.3). Keep it
      ugly and fast — you'll use it daily.
- [ ] Corrected turns promoted into the eval corpus with category labels (R9.2.4). The
      corpus from Slice 0 now grows on its own.
- [ ] Correction feeds wired (R9.2.5): per-tenant keyterm vocabulary, normalizer test
      cases, prompt-adjustment candidates, missing-FAQ candidates.
- [ ] Trend tracking so provider and prompt changes can be attributed to real movement
      (R9.2.6).

**Done when:** you make three deliberately awkward calls, all three surface in the review
queue, and correcting them adds new entries to the eval corpus.

---

## Slice 5 — Internal tools

**Goal:** The agent can do platform-owned things.

- [ ] Tool registry with mandatory risk tier field, validated at registration (R5.3).
- [ ] Tool dispatch in the orchestrator, results summarized before TTS (R5.4.3).
- [ ] **Holding speech scheduler** (R5.4.2): filler audio starts the instant a tool is
      dispatched. Build this with the first tool, not after the tenth.
- [ ] Timeout handling — soft 1.5s, hard 3s, never silent (R5.4.1).
- [ ] Implement: `end_call`, `search_knowledge_base`, `transfer_to_human`,
      `create_ticket`, `schedule_callback`, `send_sms`, `send_whatsapp`, `verify_caller`.
- [ ] Warm transfer with context payload to the human agent.
- [ ] Business-hours logic in WAT; out-of-hours → ticket or callback per tenant config
      (R6.5).
- [ ] Escalation on three failed comprehension attempts (R6.4).

**Done when:** you call, ask something the agent can't answer, and get transferred with
context — or get a ticket, out of hours.

---

## Slice 6 — External tools

**Goal:** The agent can reach into a tenant's own systems. This is what makes it a
product rather than a demo.

**Two routes, one dispatch path (R5.2.0).** Build the registry and dispatch path first,
then both adapters against it. If a security control or latency rule ends up in one route
and not the other, the abstraction is wrong — fix it before moving on.

- [ ] Per-tenant encrypted credential vault (R5.2.1). Credentials never in logs, never in
      LLM context.
- [ ] **Route A — HTTP connector adapter:** endpoint, JSON schema, auth reference, risk
      tier, timeout. This is the default path; most tenants will never touch MCP.
- [ ] **Route B — MCP adapter:** connect to a tenant-supplied MCP server, discover its
      tool list, register into the same registry with tiers assigned at registration.
- [ ] Prove the abstraction: the same mock backend exposed both ways behaves identically
      through the pipeline — same tiers, same timeouts, same logging, same holding
      speech.
- [ ] Egress allowlist + SSRF guards: block private ranges, link-local, metadata
      endpoints, unlisted redirect targets (R5.2.2).
- [ ] Per-tool circuit breaker and retry policy; one tenant's broken endpoint cannot
      affect another (R5.2.3).
- [ ] Risk tier enforcement in the dispatch path: `write` requires spoken confirmation +
      readback; `irreversible` transfers to a human and cannot execute (R5.3).
- [ ] Parallel dispatch for independent tool calls (R5.4.4).
- [ ] Full tool invocation logging with per-tenant PII redaction (R5.2.4).
- [ ] Security test suite: SSRF attempts, credential leakage into transcripts, cross-
      tenant tool access. Runs in CI.

**Done when:** a mock "tenant CRM" is queried live during a call via **both** routes, the
answer is spoken correctly in each, and the security tests pass against both.

---

## Slice 7 — Tenant configuration and first real tenant

**Goal:** A second tenant exists and behaves completely differently, with no code changes.

- [ ] Versioned tenant config (R7.5): persona, voice, greeting, knowledge base,
      registered tools, escalation rules, business hours, keyterm vocabulary.
- [ ] Config version recorded on every call.
- [ ] Phone number → tenant resolution at ingress (R7.3).
- [ ] Per-tenant rate limits and quotas (R7.4).
- [ ] Knowledge base ingestion + retrieval, scoped per tenant.
- [ ] Onboarding runbook — the manual process we follow for tenants 1 through 10.
- [ ] Onboard one real design partner. Insurance is a fine first customer; it is no
      longer the product.

**Done when:** two tenants run on two numbers with different voices, tools and escalation
rules, from config alone.

---

## Slice 7a — Live conversation test

**Goal:** Real people, unscripted, on their own phones, before a single customer call
reaches this. Slice 0 tested the *providers* on real conversation. This tests the *system*.

- [ ] ≥20 unscripted calls from people not working on the build (R9.3.1). Give them a
      goal ("find out when your policy renews"), not a script.
- [ ] Include at least one poor connection, one noisy environment, one caller who
      interrupts constantly, one who goes off-topic, one who is angry.
- [ ] Score on **task success, not WER** (R9.3.2): did they get what they called for,
      without repeating themselves more than once, without an unnecessary transfer.
- [ ] Every call through the review loop; corrections into the corpus (R9.3.3).
- [ ] **Launch blocker:** any wrong-number-confirmed-correct event (R9.3.4). The agent
      reading back a wrong policy number and the caller saying "yes" is the failure that
      loses a customer's customer.

**Done when:** 20 calls done, task success measured, zero wrong-number confirmations.

---

## Slice 8 — Hardening before anyone depends on it

- [ ] Load test: 50 concurrent calls, latency targets held (R5.5).
- [ ] Failure drills: STT provider down, LLM timeout, TTS failure, tenant endpoint
      hanging. Every one degrades gracefully with speech, never silence.
- [ ] Eval harness rerun in CI; number-accuracy regression blocks merge (R9.3).
- [ ] Alerting on p95 latency, silence events, transfer rate, tool failure rate.
- [ ] NDPR review: call recording consent, retention, redaction, data residency.
- [ ] Emotional-distress classifier and low-friction human path (R6.6).
- [ ] Cost tracking per call: STT + LLM + TTS + telephony minutes. You need this before
      pricing.

---

## Not now

**Outbound calling is the big one, and it has a named gate.** Do not start it until Slice
7a passes: 20 unscripted calls, task success measured, zero wrong-number confirmations.
Outbound is technically easy from here — the same pipeline, dialling instead of answering
— which is exactly why it will tempt you before inbound is actually good. An outbound
agent that mishears is worse than an inbound one: you chose to call them.

Also kept here so they stop being tempting: tenant admin UI, self-serve onboarding and
connector setup, billing, analytics dashboards, WhatsApp channel, inbound webhooks from
tenant systems, Yoruba/Hausa/Igbo, cross-call memory, agent shadowing, mobile.

All Phase 2 or 3. Every one of them is more fun to build than Slice 0. That is exactly
why they are listed here.

---

## Session discipline

- Update this file before you stop working. Check boxes, note what broke.
- One slice at a time. Do not start the next until the current one's "done when" is true.
- Push to remote at the end of every session.
