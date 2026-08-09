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

## Open at the end of 2026-08-08 — after the integration pass

**Six of the seven `WIRING.md` files are applied**, serially, one commit each, on the
order they were written in. `pnpm lint && pnpm typecheck && pnpm test` is green: 915 tests
across 10 packages. **None of it is proven — no call has been placed since.**

What landed, in order:

1. `orchestrator/CAPTURE_WIRING.md` — the escalation black hole is closed. Capture
   releases a turn it is not handling, so an escalated caller is answered by the model
   instead of hearing silence for the rest of the call. With it: the gate is gone (email,
   address, date, time and amount can reach capture at all now), confidence travels with
   the speech event, `entity_candidate` is redacted through `logSafe`, and a confirmed
   value is announced by its kind rather than by the shape of the string.
2. `conversation/WIRING.md` — the call keeps a record. One deviation, recorded in the
   commit: a confirmed value is routed by entity kind rather than by an `asName` regex,
   and kinds the store has no field for write nothing rather than being filed as a policy
   number.
3. `orchestrator/call-state/WIRING.md` — applied as written, no behaviour change, and
   `orchestrator.test.ts` passes with no expectation touched, which is the proof.
4. `prompts/WIRING.md` — the tenant's composed prompt reaches the model. `systemPrompt`
   is required rather than defaulted, and `orchestrator/system-prompt.ts` is deleted.
5. `handoff/WIRING.md` — five triggers and a call site. The departure line is heard, not
   merely sent, before the transfer tears down the media stream.
6. `viewer/WIRING.md` — nothing left to wire. Its seams were fixed by their owners, except
   `barged_in_at_ms`, which is below.
7. `packages/tools/WIRING.md` — **applied in full.** Step 0 landed first (the LLM
   interface has a tool surface and the OpenAI adapter reassembles streamed tool calls);
   steps 1-5 landed with the platform tool set. The blocker is resolved by shipping only
   the non-data tools — `end_call`, `transfer_to_human`, `business_hours` — and leaving
   the in-memory policy book in the tests where it belongs. See Slice 5 below.

**Also fixed, with the tests that were missing:** `barged_in_at_ms` (the turn was written
on the first acknowledged mark, so `stopSpeaking` had nothing left to stamp — it is now
written at the two real exits); `RECOVERY_LINE` is four lines picked by the same
never-twice-running picker the fillers use; the transcript watchdog is cancelled when the
caller starts again; and the echo guard no longer stamps the caller's turn start with our
own audio.

**The failing `packages/db` test is fixed** — a tenant id range per integration test file.
It was never a leak.

### What a human has to do next

1. **Place a call.** Nothing above is proven. In one call: give a name and confirm it,
   change the subject for two turns, then ask "do you know who you're speaking to?"; ask
   for a person and check the departure line is heard in full before the transfer; and read
   the new `call state` lines looking for a `-> UNDERSTANDING` that never leaves.
2. **Decide `HANDOFF_TO_NUMBER`.** With no destination configured, escalation apologises
   and hangs up rather than transferring — honest, and not a handoff.
3. **Apply migration `0012_business_hours.sql`** in the Supabase SQL editor as owner, and
   publish hours for the tenant with `tools/tenant/config.mjs`. Until then `business_hours`
   answers "I do not have the opening hours on file" on every call, which is honest and
   is not the feature. Both `DATABASE_URL` and `DIRECT_URL` are `ansa_app`, which cannot
   ALTER the table — the same wall migration 0003 hit.
4. **Place a call that uses a tool.** Nothing in the tool loop has been near a phone.

**Still open, unowned by this pass:**

- **Two agents never ran** — `turn-taking` and `latency-audio` — both need a recording.
- R6.7 sits in the "enforced in code" column of MULTI_TENANT_ARCHITECTURE.md and is not
  enforced anywhere. Nothing watches for "are you an AI".
- An identifier said with a pause is confirmed twice, in halves: the continuation wait is
  skipped during capture, correctly, so "my reference is A B four…" / "…one seven two"
  produces two readbacks and neither is the reference. (entity-capture with turn-taking)
- `pending` outlives a new agent turn. Theory rather than an observed bug, but a stale
  `pending` silently disables the thinking-gap filler on the following turn.

## How the remaining work is split

`docs/AGENT_PLAN.md` divides the conversation-quality brief across ten focused agents, one
per core feature, with what each owns, what already exists so it is not rebuilt, and the
order to run them.

Two things it settles up front: the product is NestJS and not Next.js whatever a brief
says, and most of the brief is already implemented — an agent told to "add barge-in" would
reimplement working code.

`stt-reliability` runs first and alone. If the harness shows the fault is the cascade
rather than a configuration, half the other charters change.

## The open decision — names, and the architecture behind them

Six rounds of call-fix-call on 2026-08-08 fixed a lot and did not fix this. Recorded here
so the next session starts from the decision instead of re-running the loop.

**"Adedeji Sikiru" has come back as:** Hill, Sequium, Security, Aditi, kekere, TK, Kim Woo,
"Epic mining is secured", "Ipet may nin si Tiyo". Spelling was the fallback and a call
falsified that too — a spelled J arrives as E. Deepgram and OpenAI fail the same way, both
with the language pinned to English.

**What the loop did fix**, and these were real: hallucinated languages (audio gate), the
agent interrupting itself with fillers, the readback confirming a rejection, turns split
mid-sentence, the agent greeting a greeting, outbound answering as "unknown", a call record
that stored only one side of the conversation. None of them were the names.

**The three honest options, none of which is more orchestration work:**

1. **Speech-to-speech.** OpenAI Realtime or Gemini Live consuming audio directly, so the
   model hears the accent instead of reading a mangled transcription of it. Removes the
   class of failure. Costs: less control over turn budgets, harder to keep R4.3.1 in code
   rather than prompt, higher price, partial orchestrator rewrite.
2. **Design around it.** Take references by DTMF, which already works and is unambiguous;
   look the name up from the reference; never ask a caller to say or spell it. Smaller,
   duller, would probably ship. It is what many production IVRs do.
3. **Accept it** for a first tenant whose calls do not turn on names.

Everything else in the product is further along than this one thing. It should be decided
deliberately rather than iterated at.

## Where this actually is — 2026-08-08

The checkboxes below this line are stale. They were written before the work and were not
kept up as slices moved, so this section is the authority and they are history. Verified
against the code and a live call on the date above, not from memory.

**Working, and proven on a phone call:**

- Inbound and outbound calls, bidirectional μ-law streaming, barge-in, marks-based
  playback truth.
- Multi-tenant: resolution at ingress for inbound and via stream parameter for outbound,
  RLS with FORCE on all 10 tables, per-tenant keyterms and config, versioned.
- Conversation loop: turn budgets by caller action, repair, backchannel, fillers, echo
  defence, watchdogs.
- `packages/normalizer` — 45 tests. Nigerian number/money/date speech, both directions.
- Readback with spelling and DTMF fallback, enforced in the dispatch path.
- Audio-level hallucination filter. Three providers invented fluent text from silence;
  this is what stopped it.
- Outbound: origination, voicemail detection, full lifecycle callbacks, consent gate with
  per-organisation lawful basis.

**424 tests across 9 packages. Lint, typecheck and tests green.**

**Known broken, and the reason to be careful about the rest:**

- **Names are not transcribed.** "Adedeji Sikiru" came back as Hill, Sequium, Security,
  kekere, Aditi. Spelling was the fallback and a live call falsified it too: a spelled J
  arrives as E. This is the transcription ceiling, not an orchestration bug, and no
  amount of readback logic fixes a name the transcriber never heard.
- Latency ~1.1s against an 800ms budget, most of it Nigeria→US distance.
- The agent still cannot look anything up. It can now end the call, ask for a person and
  answer opening hours, and that is all — there is no knowledge base and no connector to
  a tenant's own systems, which is Slice 6. **Slice 6 built the connector on 2026-08-08:
  the route exists, in both transports, and no tenant has configured one, so this sentence
  is still true of every call placed today.**

**Next, in order:**

1. **Event log persistence (Slice 2).** Everything above is logged and nothing is stored.
   It blocks the R9.2 review loop, the call viewer, and the R7.5 audit trail that would
   let a call be traced to the consent basis in force when it was placed.
2. **Speech-to-speech spike.** The cascade throws the acoustics away and that is where
   names die. Measure it against the same calls before investing further in readback.
3. **Tool registry (Slice 5).** The end of "I can't check that", and the largest cause of
   calls feeling hollow.

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

**2026-08-07 — conversation quality pass (36 verified findings, 9 commits)**

Measured on a live call after the pass, against the same caller and phone as before:

| | before | after |
|---|---|---|
| `turn_to_audio` (the R5.5 number) | ~2500ms | **1578ms** avg, 1189 best |
| `llm_first_token` | 1038–1305ms | **763ms** |
| `tts_first_byte` | 362–510ms | **250–282ms** warm |
| spurious barge-ins | 5 → 2 → 1 | **0** |
| turns fully played | 0 → 1 → 3 of 4 | **6 of 6** |

- The greeting logs no `tts_first_byte` at all: it is rendered at boot and played from
  memory. Keep-alive shows up exactly where predicted — TTS 472ms on the first turn of a
  call, 250–282ms once the socket is warm.
- **The remaining problem is transcription accuracy, not the pipeline.** On that call the
  transcriber returned "So I would like to move to a closing, and now I am prospective
  assistance." and rendered "policy" as "course", and the caller had to repeat themselves.
  Everything downstream behaved correctly on nonsense input. `gpt-4o-mini-transcribe` was
  chosen for integration speed and explicitly not accuracy; **this is the case Gate A and
  Intron Sahara v2 exist for**, and it is now the single largest quality gap.
- Bugs fixed in the pass, each one confirmed against the code rather than guessed at: an
  unhandled WebSocket `error` would have killed the process and dropped every concurrent
  call; a lost listen socket left the agent permanently deaf; the agent answered its own
  echoed voice because the barge-in guard covered speech-start but not the transcript
  behind it; `respondTo` replaced a live turn with no teardown, so abandoned audio played
  over the new reply; marks existed only at sentence boundaries so a mid-sentence
  interruption erased a reply the caller had heard; history was written by the LLM
  finishing rather than by audio playing, so an interrupted turn vanished entirely;
  neither vendor request had a deadline, so a hung connection could never be recovered
  from; a caller noise during the think window cancelled the answer they were waiting for.
- Corrected an earlier conclusion of mine: the `llm_first_token` climb from 1081→1978ms was
  **not** history growth. n=7 on one call with no mechanism behind it. History windowing
  would have been effort aimed at a phantom. The real win was Node closing idle sockets
  after 4s.
- **Unmeasured and flagged:** the system prompt was rewritten (contractions, duration
  bound). CLAUDE.md requires an eval-harness rerun on any prompt change with number
  accuracy blocking merge, and `eval/` does not exist. The contraction instruction is the
  one most likely to interact with the naira and policy-number rules. Gate A must re-check.
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

### 2026-08-09 — deliberately partial, and why

**Gate A is NOT closed and nothing below should be read as done.** Two of its rules were
extracted and shipped early, in `eval/`, because both were broken *today* on the audio that
already exists:

1. **Ground truth is required and the match is exact.** The caller said Sikiru; six runs of
   six returned Chike. The trial that was meant to catch it asserted "a name-shaped token
   followed 'my name is'" — it passed 6/6 while being wrong 6/6, because ground truth was
   known and unused. `eval/verdict.py` takes a truth string or refuses to produce a number.
   Names and identifiers are exact match, never WER: "Chike" against "Sikiru" is ~60%
   character overlap, and the metric that calls that partial credit is the metric that hid
   this for a day.
2. **Three trials, or no verdict.** Four provider comparisons here were each decided from a
   single run and each reversed by the next; one enabled and reverted `OPENAI_SEND_PCM` the
   same day. Fewer than three trials, trials that disagree, or a configuration whose
   settings were not written down all produce a refusal rather than a number.

**Everything else waits on audio.** We have five recordings of **one speaker**; Gate A wants
8–10, mixed line quality, human-labelled turn boundaries, and consensus adjudication
(R9.1.4) which needs at least two candidates over a shared corpus. Building the corpus
format, the category breakdown and the WER machinery now would produce code exercised by
nothing until that audio arrives. Deferred, not dropped — the reasoning and the full
outstanding list are in `eval/README.md`.

**Labelled today:** the caller's name on `CAa280584f…ulaw`. **Not labelled:** the policy
number on that same recording, every prose transcript, and the other four recordings
entirely. Nothing was derived from a transcriber's output — label that recording from any
of the six available runs and the corpus would assert the caller is called Chike.

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
      hides. **Partial — the exact-match half ships, the WER half does not.**
      `eval/verdict.py` scores names and identifiers by exact match against written-down
      ground truth, refuses when there is none, and refuses to summarise fewer than three
      trials or trials that disagree. `python3 eval/selftest.py` — 54 checks, offline, no
      key and no audio. Per-category WER is deliberately absent: no hand transcript of any
      recording exists, so there is nothing to compute it against.

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

- [x] Tool registry with mandatory risk tier field, validated at registration (R5.3).
      *`packages/tools/src/registry.ts`. Validated against the runtime shape, not only the
      type, because the tools that matter arrive as tenant configuration.*
- [x] Tool dispatch in the orchestrator, results summarized before TTS (R5.4.3).
      *One dispatch path. `summarise` is required and its output is checked — a summary
      that starts with `{` is refused rather than spoken.*
- [x] **Holding speech scheduler** (R5.4.2): filler audio starts the instant a tool is
      dispatched. *The existing filler scheduler, in its progress register. `start` fires
      inside `dispatch()` before the adapter is invoked, and the orchestrator test asserts
      that order rather than the fact.*
- [x] Timeout handling — soft 1.5s, hard 3s, never silent (R5.4.1).
- [x] Escalation on three failed comprehension attempts (R6.4). *Was already done in the
      handoff pass; tool failures now count into the same watch, at two rather than three.*
- [ ] Implement: `end_call`, `search_knowledge_base`, `transfer_to_human`,
      `create_ticket`, `schedule_callback`, `send_sms`, `send_whatsapp`, `verify_caller`.
      **Three of eight, deliberately.** `end_call`, `transfer_to_human` and
      `business_hours` ship — none of them reads tenant data. The other five all answer
      from, or write to, a system that does not exist, and `createInMemoryPolicyBook` is a
      fake that stays in the tests. An agent answering confidently from records nobody
      wrote is worse than one that says it cannot check.
- [ ] Warm transfer with context payload to the human agent. *The whisper already carries
      the summary (handoff pass). Unproven on a call.*
- [ ] Business-hours logic in WAT; out-of-hours → ticket or callback per tenant config
      (R6.5). **Half.** The hours half is done: `business_hours` reads
      `tenants.business_open_hour/close_hour/business_days`, versioned, in WAT via the one
      definition in `packages/shared/src/clock.ts`. Migration `0012_business_hours.sql`
      **must be run as owner in the Supabase SQL editor** — until it is, every tenant's
      hours read null and the agent says it does not know them, which is honest and
      useless. The out-of-hours half needs `create_ticket` or `schedule_callback`, which
      are exactly the tools held back above; today a tenant's own `instructions` layer is
      the only place to say what should happen instead.

**Done when:** you call, ask something the agent can't answer, and get transferred with
context — or get a ticket, out of hours.

**Session log**

- *2026-08-08 — the tool loop is wired and no phone call has tested it.* 977 tests, lint
  and typecheck green. `packages/tools/WIRING.md` steps 1-5 applied, with four deviations
  recorded in its header.
- **What is registered on a real call:** `end_call` (read), `transfer_to_human`
  (irreversible), `business_hours` (read). Nothing else. `tenantId: null` — an unregistered
  number — disables tool calling for the whole call: no registry is built, no dispatcher
  exists, and the model is offered no tools at all.
- **`end_call` hangs up on the mark, not on the tool's return.** The tool records the
  intent; `finishIfComplete` acts on it once the carrier says the caller has heard the
  goodbye. Hanging up when the tool returns would truncate the last words of every call
  the agent ever ends — the same lesson as the greeting in Slice 1, and the reason
  `mark()` exists. A caller who starts speaking again cancels it.
- **`transfer_to_human` is irreversible tier and the tier IS the implementation.** "Never
  executes, transfers to a human" looks like a contradiction for a tool that transfers to
  a human; it is not. The adapter is a tripwire that throws, and the dispatcher's
  irreversible branch returns a `transfer` outcome that the orchestrator routes into
  `apps/api/src/handoff/`. Registering it lower would mean a second transfer path beside
  the module that already owns the departure line, the whisper and the carrier call.
- One new escalation kind, `needs-a-person`, because `tool-failed` says "I cannot reach
  that from here" and nothing was unreachable — the assistant is simply not allowed to do
  it, and a caller can hear the difference.
- The prompt's task layer now lists what is registered, per tenant. It previously told
  every model on every call that it could not look anything up, which would have argued
  the model out of using tools it was being offered. `UNKNOWN_TENANT` keeps the empty
  wording, and that is correct rather than an oversight.
- **What a call has to prove**, in this order: ask for opening hours and hear a real
  answer (needs 0012 applied and hours published); ask for a person and check the
  departure line is heard in full before the transfer; say goodbye and check the last
  word is not clipped; and listen for the progress filler landing during the tool call
  rather than after it.
- **Not fixed, found while wiring.** An `end_call` followed by an LLM failure speaks a
  recovery line and then hangs up, which is an odd last thing to hear. `record.event`
  writes tool calls to `call_events` rather than to the `tool_invocations` table, which
  exists and is still empty. And there is no `search_knowledge_base`, so "I can't check
  that" is still the answer to most real questions — Slice 6 is what ends that.

---

## Slice 6 — External tools

**Goal:** The agent can reach into a tenant's own systems. This is what makes it a
product rather than a demo.

**Two routes, one dispatch path (R5.2.0).** Build the registry and dispatch path first,
then both adapters against it. If a security control or latency rule ends up in one route
and not the other, the abstraction is wrong — fix it before moving on.

**The internal/external split is not a split in mechanism.** The organisation hosts the
endpoint and we are the client — that is how a tenant supplies a "tool", and it would be
how they supplied a webhook for one of the platform tools too. The real axis is
platform-owned (`packages/tools/src/internal/`: `end_call`, `transfer_to_human`,
`business_hours` — they act on the call itself and have no endpoint behind them) versus
tenant-supplied (`packages/tools/src/connector/`). Registration does not care which,
beyond the shadowing rule that already stops a tenant redefining a platform tool.

- [x] Per-tenant encrypted credential vault (R5.2.1). Credentials never in logs, never in
      LLM context.
      *`connector/vault.ts`. AES-256-GCM, tenant id and ref as AAD so a ciphertext copied
      into another tenant's row will not open. The plaintext lives in a closure; the only
      thing that leaves is a `Credential` whose `toJSON`, `toString` and inspect symbol all
      return `[redacted]`. Header schemes only — query-string API keys are refused because
      the URL is logged by everyone.*
- [x] **Route A — HTTP connector adapter:** endpoint, JSON schema, auth reference, risk
      tier, timeout. This is the default path; most tenants will never touch MCP.
- [x] **Route B — MCP adapter:** connect to a tenant-supplied MCP server, discover its
      tool list, register into the same registry with tiers assigned at registration.
      *JSON-RPC over Streamable HTTP, spoken directly, no new dependency. A discovered
      tool with no tier in the tenant's config is logged and NOT registered — a server
      cannot mark its own homework.*
- [x] Prove the abstraction: the same mock backend exposed both ways behaves identically
      through the pipeline — same tiers, same timeouts, same logging, same holding
      speech.
      *`connector/equivalence.test.ts`: one loopback server, one backend, two tenants one
      route each, every outcome field compared except the route label. Plus the structural
      form — a walk of the repo asserting `dispatch.ts` is the only caller of
      `adapter.execute`.*
- [x] Egress allowlist + SSRF guards: block private ranges, link-local, metadata
      endpoints, unlisted redirect targets (R5.2.2).
      *Allowlist, then an address filter over every DNS answer, then pinning — the socket
      may only reach addresses that passed. `node:http` rather than `fetch` precisely
      because fetch re-resolves after the check, which is the rebinding window.*
- [x] Per-tool circuit breaker and retry policy; one tenant's broken endpoint cannot
      affect another (R5.2.3). *Keyed per tenant AND per tool, in the dispatch path.
      Retry is reads only.*
- [x] Risk tier enforcement in the dispatch path: `write` requires spoken confirmation +
      readback; `irreversible` transfers to a human and cannot execute (R5.3).
      *Already true from Slice 5; verified against both new routes rather than re-added.*
- [x] Parallel dispatch for independent tool calls (R5.4.4). *Landed in Slice 5 —
      `Promise.all` over the model's requested calls, with the tier gate per tool.*
- [ ] Full tool invocation logging with per-tenant PII redaction (R5.2.4). **Half, and
      the half that is missing moved.** Every invocation is logged with redacted
      arguments, latency and outcome, and `redact.ts` matches credential-shaped keys.

      The per-tenant capability now exists — Slice 6a built `redaction.ts`, which reaches
      free text and is configured per tenant — but **the dispatcher does not use it**. Its
      log line still goes through the global key rule, because reaching the tenant's policy
      from `dispatch.ts` means plumbing it through the dispatcher and that is a change to
      the tool path rather than to this one. Outbound payloads, which are the case that
      actually mattered, do use it.

      The other gap is unchanged: `record.event` still writes tool calls to `call_events`
      rather than to the `tool_invocations` table, which exists and is still empty.
- [x] Security test suite: SSRF attempts, credential leakage into transcripts, cross-
      tenant tool access. **Not in CI, because there is no CI.** *63 egress tests, the
      vault's tenant-binding tests, credential-absence-from-logs on both routes, and
      cross-tenant resolution. Same standing gap as the RLS suite from Slice 2.*
- [x] **A lookup will not run on an identifier nobody confirmed.** Not in the original
      list, and it is the most important thing here. A tool declares
      `identifiers: { reference: "policyNumber" }`; the dispatcher refuses unless
      `confirmedFact` says yes and the model's value matches the confirmed one. The
      transcriber returns a stable wrong name for a Nigerian caller — a lookup on it does
      not fail, it returns the wrong customer.

**Done when:** a mock "tenant CRM" is queried live during a call via **both** routes, the
answer is spoken correctly in each, and the security tests pass against both.
**Not done.** No phone call has been near any of it, and nothing reaches a real call until
a tenant publishes a `tool_config`.

**Session log**

- *2026-08-08 — the connector layer is built and tested and has never met a real endpoint.*
  1,101 tests across 10 packages; lint, typecheck and tests green. Seven commits.
- **What a human has to do before any of this is real**, in order:
  1. **Apply migration `0013_tenant_tools.sql`** in the Supabase SQL editor as owner. Same
     wall as 0003 and 0012: both `DATABASE_URL` and `DIRECT_URL` are `ansa_app`, which
     cannot ALTER the table. Until it is applied, `tool_config` reads as absent, which the
     loader treats as "no tools configured" — so the call path is unchanged rather than
     broken.
  2. **Set `TOOL_CREDENTIAL_KEY`** (`openssl rand -base64 32`) in `.env`. Optional: unset
     means any tool needing a credential is not registered, and the agent says it cannot
     check rather than making an anonymous request to somebody's API.
  3. **Point it at a real endpoint.** `TENANT_ID=… node tools/tenant/config.mjs publish
     config.json "…"` with a `tools` block, and `… config.mjs credential <ref> bearer <token>`
     to seal the secret. Then place a call and ask the thing the endpoint answers.
- **What only a real endpoint can settle**, and none of it is testable from here: whether a
  tenant's TLS chain validates through the pinned-address path (the loopback tests are
  plaintext); whether real-world latency fits inside the 3s hard ceiling from Lagos on top
  of an already 1.1s turn; whether tenants' JSON is shallow enough for dotted-path speech
  templates; and whether a real MCP server's Streamable HTTP matches the two response
  shapes implemented.
- **Deliberately not built:** any data tool of ours. `createInMemoryPolicyBook` remains a
  test fixture. The route now exists for a tenant to supply the real thing, which is what
  Slice 6 was for.
- **Found while wiring, not mine, fixed anyway.** The RLS suite's hardcoded table count
  (`expect(rows).toHaveLength(10)`) had been red since `tenant_prompt_versions` landed in
  0011 without it being updated. The number never tested what its comment claimed — the
  query returns every table in `public`, so an unprotected one fails the per-table loop
  whatever the count says. What it actually tracked was how many migrations a human had
  applied by hand. Replaced with a named list of the eight core tables, which keeps the
  other thing it was quietly doing: proving the query returned anything at all.
- Two smaller things landed with the dispatch work and are worth knowing: `definition.timeoutMs`
  was validated at registration and then ignored by the dispatcher since Slice 5, so a
  tenant asking for a tighter ceiling got the platform's; and a read that fails is now
  retried once inside the same deadline, while a write never is.

---

## Slice 6a — Event webhooks: pushing data back to the organisation

**Built, not proven.** Every box below is code with tests behind it and none of it has
been near a phone call, because it cannot be: what is missing is an endpoint belonging to
a real organisation. Requested during Slice 6 — call ended → the call record; transferred
to a human → the conversation so far.

It was built as an event path and not as a tool, which was the tempting mistake:

| | tool call | event webhook |
|---|---|---|
| who decides | the model, mid-call | the platform, at a lifecycle point |
| shape | request → response the agent speaks | fire-and-forget delivery |
| timing | on the latency budget, holding speech, 3s hard ceiling | after the fact, must never touch the call |
| failure | agent apologises and recovers | retry with backoff, at-least-once |
| risk tiers | central | meaningless — nothing is being done to the caller |

**Nothing below the seam was rebuilt.** The Slice 6 transport, egress guard, vault and
breaker are the ones used; `breaker.ts`'s `(tenantId, subject)` key was written for this
and needed no change. There is still exactly one outbound HTTP client in this product.

- [x] **Per-tenant PII redaction that reaches free text (R5.2.4).**
      `packages/tools/src/redaction.ts`, pure, exhaustively tested.

      **The default inverted during the slice and the reasoning is the part to keep.**
      The first version withheld anything it could not reliably redact and made the
      tenant opt in to receiving it. That is wrong: the organisation is the data
      controller, the caller is *their* customer, and the payload is a record of a
      conversation their own agent had. Withholding their own data on a judgement we made
      about their compliance posture is not our call, and it would break the obvious uses
      — a CRM that needs the policy number, a ticketing system that needs the callback
      number. **Nothing is redacted unless a tenant configures it.**

      When they do configure it, two sources of signal and they are not equal.
      `captured-identifier` uses what `call-facts.ts` recorded — including every form the
      transcriber offered, not only the settled value, because the other spellings are
      still sitting in the transcript. That is knowledge. `email`, `card-number` (Luhn),
      `digit-sequence` and `spoken-digit-sequence` are shape, which generalises but infers.

      **What it provably cannot catch is documented where a tenant configuring it will
      read it** (`docs/EVENT_WEBHOOKS.md`), not expressed by withholding: a name in prose,
      a date of birth (a date has a shape; a date *of birth* does not), an address, and
      any health or financial disclosure. `digit-sequence` over-masks amounts and years,
      which is the trade for a rule that cannot know what a number means.

      One thing is not a tenant setting and never will be: credential-shaped keys are
      removed unconditionally. That is not caller PII and not the tenant's data to receive.

      Two bugs worth remembering. The captured-identifier matcher filtered on `[A-Za-z0-9]`
      and so built a pattern that could not match the value it came from whenever the name
      carried a diacritic — Yorùbá, Norwegian, Spanish all silently survived redaction.
      Unicode property escapes, and lookarounds rather than `\b`, which JavaScript defines
      over ASCII. And the first card fixtures were hand-written and not Luhn-valid, so the
      test proved the regex and not the check.

- [x] Delivery with retry and backoff, at-least-once, off the call path entirely.
      An outbox table (migration 0014) rather than an in-memory queue, because
      at-least-once has to survive a deploy. The call path writes one row and forgets it;
      `apps/api/src/events/delivery.sweeper.ts` claims due rows on a timer. **There is no
      code path from a receiver's outage back to a conversation** — not a careful async
      function, an absence of a path.

- [x] Signed payloads. HMAC-SHA256 over `v1.<timestamp>.<event id>.<body>`, with the
      timestamp and event id *inside* the signed string so the replay window is not
      editable and a body cannot be moved onto another delivery. The attempt number is
      outside it, so a retry sends identical bytes and dedupe on the event id works.
      `verifySignature` is the receiver's side, kept so the claim is proved by a test.
      The vault gained a `signing` kind and `resolveSigner` — still no `reveal()`, the
      secret stays in the closure and a digest comes out, and a value sealed for auth
      cannot sign.

- [x] A delivery log the tenant can be shown. `/viewer/deliveries`, with the exact bytes
      sent on every row: the question is not "did a request happen" but "what did you
      send me", and a status code answers the first only. Settled rows purge at 30 days;
      a delivery still retrying is never purged.

- [ ] **Proven against a real endpoint.** Nobody has configured a receiver, so no delivery
      has ever been attempted against a server we do not own. Specifically unproven:
      whether a real receiver's TLS and redirect behaviour survives the address-pinned
      transport, whether the backoff feels right against a real outage, and whether the
      signature paragraph in the docs is enough for somebody to implement verification
      from without asking us a question.

**Design decisions that will look arbitrary later:**

- The payload is built and serialised **once**, when the event fires, and the bytes are
  stored. Rebuilding per attempt is the obvious design and is wrong three ways: the
  signature covers the body; a payload derived from the call record would change if a
  transcript were corrected between attempts; and the redaction that applied is the config
  version in force *then*.
- Hooked in as a **tee on the recorder** (`apps/api/src/events/publisher.ts`), the same
  shape as `handoff/journal.ts`. Neither the orchestrator nor `handoff.ts` learns that
  webhooks exist, which is the claim of the slice made structural.
- The event layer lives in `packages/tools/src/events/`, which is a slight misnomer. It is
  there because it shares the whole connector layer and a new package would have bought
  nothing; the header comment in `events/config.ts` says loudly that these are not tools.

## Slice 7 — Tenant configuration and a second tenant

**Goal:** A second tenant exists and behaves completely differently, with no code changes.

**The proof was run, and it took code changes — which is the finding.** A second
organisation was onboarded through configuration alone (`Swiftrail Couriers`, a courier
firm, on its own number) and four things of the first tenant's turned up on its calls.
None of them was an RLS failure: no row crossed a boundary. They were a default, a
hardcoded constant, an environment variable and a shared vocabulary list.

- [x] Versioned tenant config (R7.5): persona, voice, greeting, keyterms, business hours,
      registered tools, event receivers, and now escalation. Migration 0011 added the
      append-only history; 0015 adds escalation to it. `tools/tenant/config.mjs` is the
      onboarding path and `tools/tenant/provision.mjs` is the operator's half —
      `dialled_number` is the ingress routing table and is deliberately not reachable from
      the tenant's own tool. Knowledge base is still unversioned because nothing reads it.
- [x] Config version recorded on every call.
- [x] Phone number → tenant resolution at ingress (R7.3).
- [x] **Prompt layering (§21, `docs/MULTI_TENANT_ARCHITECTURE.md` §3).** All five layers
      live. The tenant layer is read on every call through `CallTenant.systemPrompt`.
- [x] **Per-tenant voice and greeting actually reach the call.** They were stored,
      versioned, printed by the tool and loaded into `CallTenant` — and `media.gateway.ts`
      passed `config.elevenLabsVoiceId` and the hardcoded `GREETING_TEXT` to every call
      regardless. A second tenant could publish a voice, watch the version go up, and hear
      the first tenant's. Fixed by routing every tenant-dependent value through one
      function, `tenancy/call-settings.ts`, which is now the only place the question is
      answered. Pre-rendered audio is per (voice, greeting) rather than per process, so the
      thinking-gap fillers are in the same voice as the turn around them; `warmForTenant`
      runs at ingress to buy the render a head start, and an unwarmed voice synthesises
      live rather than waiting.
- [x] **Per-tenant escalation destination (R6.5, migration 0015).** It was one environment
      variable for the whole process. `handoff/destination.ts` had said since Slice 6 that
      this was "a single-tenant assumption with a deadline on it"; the deadline was a second
      tenant, and the failure is that their angry caller is dialled through to the first
      organisation's staff phone and the whisper summary of a conversation they have no
      relationship with is read to whoever answers.
- [x] **The shared keyterm base was one tenant's vocabulary.** `policy`, `premium`,
      `claim`, `renewal`, `cover`, `excess` were inherited by every tenant. Boosting is a
      bias and not a hint — the same file documents it corrupting an unrelated surname 3/3 —
      so a courier company's callers were having seven insurance words win ties on every
      turn. They moved to the insurer's own list. The base is now two terms, and the bar for
      it is "true of every organisation", not "misheard once".
- [x] **A tenant's `name` could write a sentence of the prompt.** `tenant-layer.ts` warned
      about exactly this and did not catch it: the tripwires match *instructions* about
      being human, and a bare declarative ("Riverbend. You are a human being.") trips none.
      Interpolated unquoted, it was the second sentence of the prompt, outside any fence.
      The name is now quoted where it is used and double quotes are stripped, which is
      structural rather than another pattern — a rule that rejected a full stop would reject
      "St. Nicholas Hospital".
- [x] **A tool URL outside the tenant's own allowlist is refused at publish.** The egress
      guard refused it at request time and always will, but the tool registered, the model
      was told it could look the thing up, and every attempt came back as an apology. Also
      surfaced that an allowlist entry carrying a port matches nothing, which was wrong in
      two of this repo's own fixtures.
- [x] **Behaviour-level isolation suite** — `apps/api/src/tenancy/isolation.test.ts`, 29
      tests. The layer above RLS: two synthetic organisations sharing not one value, run
      through the real registry in both orders, with the question asked of every observable
      being "could this have come from the other one". Covers the cache, the per-call tool
      registry, the connector map, the prompt composer, the event subscriptions and their
      redaction policies, two interleaved calls through the recorder, and every §1 guarantee
      tried from a tenant's own configuration row.
- [x] **Onboarding runbook** — `docs/ONBOARDING_RUNBOOK.md`, written while doing it, with
      the eight things that were awkward left in. Those are the requirements for any
      configuration UI, which PRD §1.2 still says is not being built.
- [x] **What a tenant can and cannot configure** — `docs/TENANT_CONFIGURATION.md`,
      generated by `tenancy/config-surface.ts` from the guarantee list, the redaction
      categories, the event types, the text limits and the timeouts, with a test that fails
      when the document and the code disagree.
- [ ] Per-tenant rate limits and quotas (R7.4).
- [ ] Knowledge base ingestion + retrieval, scoped per tenant.
- [ ] Onboard one real design partner. Insurance is a fine first customer; it is no
      longer the product.

**Not done, and known:**

- **No phone call has proved any of it.** The second tenant is on a carrier test number,
  its voice id is a public shared voice nobody has checked against the account, and its
  tool and webhook hosts are `.example`. Two numbers ringing two different agents is
  Slice 7's actual "done when" and it is not met.
- **`voice_id` is unvalidated on publish.** A wrong one synthesises nothing, retries once
  and hangs up — the right failure, discovered by a caller. One HTTP request at publish
  would catch it.
- **`ansa_app` can still create a tenant and claim a free number.** No code path does, and
  the adversarial RLS suite needs the grant for its own fixtures, but column-level grants
  should close it before anyone outside the team holds those credentials.
- **The gateway's own wiring is asserted through `callSettings`, not through the gateway.**
  Testing `MediaGateway` end to end needs a seam in front of the listen provider, which
  currently opens a real socket to OpenAI. Both paths go through `callSettings` and that has
  its own tests; the gap is named rather than hidden, in `isolation.test.ts`.

**Done when:** two tenants run on two numbers with different voices, tools and escalation
rules, from config alone. **Configuration and code: yes. On a phone: not yet.**

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

- [x] **The application boots.** `apps/api/src/boot.test.ts`. Nothing in this repo had ever
      built the Nest container except the real process — every test constructs its
      collaborators by hand — so the missing `TENANT_REGISTRY` export shipped through two
      slices with lint, typecheck and 1,246 tests green. It resolves `AppModule` in both
      supported configurations (no `DATABASE_URL`, and a `DATABASE_URL` that refuses
      connections), plus a real database when the environment has one, and reaches for the
      three providers that live across the module boundary that broke. A canary beside it
      rebuilds the defect and asserts the container refuses, so a pass means something.

      Booting it explained the silence. Nest's default on a resolution error is
      `process.abort()`, taken before `bootstrap()`'s promise settles, so main.ts's own
      `catch` had never run once. `abortOnError: false` now, and that handler exits 1 with
      the reason in the structured log.

- [x] **Failure drills.** `apps/api/src/scenarios/failure.test.ts`, 20 of them, through the
      existing scenario harness rather than a third one. Listen socket dies (idle,
      mid-sentence, and mid-continuation); model hangs forever, errors before a token, and
      errors mid-sentence; TTS fails on the first byte and mid-stream, once and twice, with
      and without more to say; a tenant's endpoint accepts and never answers, through the
      real dispatcher at the real 3s ceiling; the database rejects every write mid-call;
      the carrier drops the socket, including while a tool is in flight.

      Two degraded into silence and are fixed:
      - A turn held for a continuation kept its timer through a listen failure, so a second
        after the goodbye the call opened a new turn and billed an LLM request on a line it
        had already asked the carrier to hang up.
      - A sentence that failed synthesis twice mid-word left the caller with a fragment and
        recorded `turn_complete` — indistinguishable, to every metric and to the review
        queue, from a turn that played out. It stays a fragment deliberately (the only
        provider that could apologise has just failed twice) but it is named now.

      `listen_failed`, `tts_failed`, `tts_sentence_dropped` and `recovery_line` are new
      event kinds. None of those four failures reached the event log at all before.

- [x] **Cost tracking per call.** `apps/api/src/viewer/cost.ts`, pure arithmetic over the
      same `CallRecord[]` `scoreCalls` reads. Telephony seconds, listen seconds **per
      provider** (R4.1.9 — a composite call opens two connections and both are metered, and
      `call configuration` now records which two), TTS characters including a retry after a
      failure, LLM turns and prompt characters.

      Rates come from the environment and there are no defaults: usage is a fact, price is
      a contract with a vendor. Unset shows units and no money, which is honest; it never
      shows zero. **The model is not priced at all** — the vendor bills tokens,
      `CompletionStream` does not report them, and a per-character figure would be
      invention. Closing that needs usage on the completion stream.

- [x] **Alerting thresholds.** `apps/api/src/viewer/alerts.ts`, reading `QualityMetrics` —
      no second metrics path. p50/p95 response latency (PRD §5.5: 800ms / 1.5s), silence
      recovered (PRD §10: under 1% of turns, measured per turn rather than per call
      deliberately), transfer rate (PRD §10: at most half), tool failure rate. `scoreCalls`
      gained `recoveryRate` and `toolFailureRate` to serve them, and both are on the
      metrics page. Nothing fires below 20 calls. The tool-failure threshold is the only
      one not from the PRD and says so where it is defined.

      **Displayed, not delivered.** It renders at the top of `/viewer/metrics`; nothing
      pages anyone. Wiring it to a channel is the next step and was not taken.

- [ ] Load test: 50 concurrent calls, latency targets held (R5.5). **Not started.** Needs
      a load generator against a real carrier or a fake one that can hold 50 media sockets,
      and the number it would produce is meaningless without the real providers behind it.
- [ ] Eval harness rerun in CI; number-accuracy regression blocks merge (R9.3).
- [ ] NDPR review: call recording consent, retention, redaction, data residency.
      **Not started**, deliberately: it is a legal review, not an engineering task, and
      half of one is worse than none.
- [ ] Emotional-distress classifier and low-friction human path (R6.6). **Not started.**

---

## Slice 4 — numbers and names (in progress)

- [x] **Per-tenant keyterms.** Resolved at ingress via `app.tenant_for_number`
      (SECURITY DEFINER, returns only an id — RLS cannot answer "which tenant?" when the
      tenant is the question). Travels to the media socket as a TwiML `<Parameter>`.
      Tenant terms merge on top of the base, never replace it.
      **Blocked on:** migration `0003_tenant_config.sql` must be run in the Supabase SQL
      editor as owner — both DATABASE_URL and DIRECT_URL are `ansa_app`, which cannot
      ALTER the table. Until then every number answers on base vocabulary, by design.
- [x] **`packages/normalizer`.** 27 tests. Nigerian "oh" for zero, 0813 817 8550
      grouping, British "and", naira written as ₦ and as bare N, kobo only when present,
      quantity-vs-sequence heuristic, dates day-first, markdown, Ansa respelling.
      Wired into the speech path: `greeting.ts` re-exports it, orchestrator and prerender
      already injected it.
- [ ] **Mandatory readback (R4.3.1/R4.3.2).** The other half, and the actual blocker.
      Saying a number correctly is not confirming it. Must be in the dispatch path, not
      the prompt, and must have no confidence threshold that skips it — confidence is not
      correctness on 8kHz audio.
- [ ] **DTMF fallback (R4.3.3)** after two failed captures.
- [ ] Prove it on a phone call. Not done until then.

## The multi-tenant shape

`docs/MULTI_TENANT_ARCHITECTURE.md` records the design for the platform Ansa is meant to
become: a strong opinionated base, thin per-tenant configuration injected from the database.

Two principles from it bear on every slice below:

- **Guarantees live in code, not in the prompt.** A tenant's instructions must never be
  able to switch off readback, a risk tier, or AI disclosure. Prompts can be talked out of
  things; dispatch paths cannot. In a multi-tenant system that stops being a quality
  argument and becomes a safety boundary.
- **Edge cases are captured, not imagined.** Every failure worth fixing today came from
  dialling the number, not from foresight. That makes the review loop (R9.2) the actual
  moat, and the event log its prerequisite rather than housekeeping.

## Slice 9 — The tenant dashboard API

**Goal:** an organisation configures itself, without us. PRD §1.2 lists a self-serve
builder as a v1 non-goal; that was changed deliberately on 2026-08-09, not drifted into.

**Decisions, made and not to be relitigated:**

- **Audience:** tenant organisations, self-service.
- **Auth:** our own session layer, reusing `withTenant`. Not Supabase Auth, not a
  third-party provider. One isolation mechanism across the whole product — the same
  transaction the call path already uses.
- **Shape:** REST with OpenAPI, client generated from the spec, spec generated from code.

**The constraint that outranks the rest.** `withTenant` was chosen knowing its weakness:
it depends on every route remembering to use it. So a handler must not be able to obtain
an unscoped connection at all — a route that omits the guard fails closed rather than
querying as nobody. Slice 7 is the argument for taking this seriously: four leaks, none
of them RLS, all in the layer above it, including one that would have dialled a caller to
another organisation's staff and read them a summary of a conversation they had no
relationship with.

| # | Endpoint area | Depends on |
|---|---|---|
| 1 | Auth, organisations, teams, invitations, the scoping guard | — |
| 2 | Agent configuration: persona, greeting, voice, keyterms, hours, consent | 1 |
| 3 | Tools and event webhooks: registration, tiers, credentials, redaction | 1 |
| 4 | Calls, transcripts, corrections, metrics | 1 |
| 5 | Numbers and onboarding readiness | 1 |

### 1 · Auth, organisations, memberships, invitations, the scoping guard — done

*2026-08-09. The pipeline every other row in that table inherits. `apps/api/src/api/`,
migration `0016_api_accounts.sql`, conventions in `apps/api/src/api/README.md`.*

- [x] `users`, `memberships`, `sessions`, `invitations`. RLS enabled, **forced** and one
      policy each — checked against `pg_class` for all 17 tables. No `organisations`
      table: an organisation is a `tenants` row, and a parallel one would be a second
      answer to "who is this customer". `users` has no `tenant_id`, so it isolates on a
      membership join instead: inside an organisation's scope you see exactly its people.
- [x] Sessions revocable, invitations expiring and single-use — the second enforced in one
      `update … where accepted_at is null` rather than a read followed by a write.
      Passwords on `node:crypto` scrypt, parameters stored with the hash.
- [x] Deny-by-default `APP_GUARD`, capability map, request-scoped `TenantContext.tx()`,
      schema validation, RFC 9457 errors, keyset pagination, rate limits on public routes.
- [x] OpenAPI generated from the same `@Endpoint` decorators the guard and interceptor
      read. `apps/api/openapi.json` committed; a test fails when it is stale. Client
      generator in `apps/api/src/api/openapi/client.ts`.
- [x] Worked references: `auth.controller.ts` (public + authenticated + write),
      `calls.controller.ts` (capability-gated paginated read of a call-path table).
- [x] `routes.test.ts` — structural, no database. `isolation.test.ts` — 14 adversarial
      tests over real HTTP against real Postgres.
- [ ] Not built, deliberately: mail (the invitation token is returned once and passed on
      by hand), password reset, a session list, self-serve organisation creation.
      `tools/tenant/owner.mjs` invites the first owner, as the operator.

**How a route is stopped from leaving its tenant.** The session token is
`ansa_s.<tenant>.<secret>`. The tenant in it is an unverified claim, and it is safe to act
on before verifying because the request opens a scope for the *claimed* tenant and looks
the session up inside it under RLS — a token naming someone else's organisation finds no
row. The forgery destroys the credential rather than redirecting it, and nothing compares
the claim to anything, so there is no comparison to forget. Above that: `TenantContext.tx()`
has no tenant parameter, every query function takes a `TenantScope` rather than
`(db, tenantId)`, `TenantGateway` is the only holder of a database handle, and a route
under `/api/v1` with no `@Endpoint` is refused rather than guessed at.

**Session log**

- **A real isolation defect, found by the adversarial test and invisible to review.**
  TypeORM's Postgres driver returns `[rows, affectedCount]` for `update` and `delete`, and
  the plain rows for everything else — so
  `(await scope.query("update … returning id")).length > 0` is **always true**. "Change a
  member of another organisation" answered 200 while changing nothing: RLS matched zero
  rows exactly as designed and the code above it could not tell. Fixed by adding
  `scope.mutate()` to `TenantScope`, which unwraps it. **Any other `update … returning`
  going through `scope.query` in this repo has the same bug.**
- Authentication cannot run inside a tenant scope, because which tenant is the answer
  rather than the question. Instead of a general unscoped connection the API layer would
  then be one careless line from using, the whole pre-authentication surface is three
  `security definer` functions with fixed bodies (`0016`).
- The eslint rule that would express "only `api/tenancy` may hold a database handle" could
  not be added: this repo's hooks refuse edits to `eslint.config.mjs`. A source scan in
  `routes.test.ts` stands in and fails the same build. **Convert it to lint if that hook is
  ever relaxed.**
- Observed once, not reproduced in two further runs: `@ansa/db`'s suite failed with an
  `audio_segments_tenant_id_fkey` violation while the new API suite ran alongside it. Its
  three files share one database and delete tenants in `afterAll`; the extra load changed
  their interleaving. Pre-existing, worth pinning down before there is CI.


### 4 · Calls, transcripts, corrections, metrics — done

*2026-08-09. `apps/api/src/api/calls/`, query layer in `packages/db/src/call-page.ts`,
`call-records.ts` and `corrections.ts`.*

- [x] `GET /calls` with filters that match what a reviewer opens the list to do:
      `from`/`to` (inclusive/exclusive), `endReason`, `caller`, `dialled`,
      `minDurationSeconds`, and `reviewed`, which is the review queue's backlog and its
      done pile. Keyset pagination unchanged; `PAGE_PROPS` is now spread into the filtered
      query so `limit`'s ceiling is written once.
- [x] `GET /calls/{callId}` — turns with barge-in offsets, final transcripts with
      confidence and provider, the event timeline in offset order, and `configVersion`.
      Declared after `GET /calls/metrics`, because Nest matches in declaration order.
- [x] `POST /calls/{callId}/transcripts/{transcriptId}/corrections`. **Submitting the
      transcriber's own words back is a verdict**, not a no-op: it stamps `corrected_at`
      and answers `changed: false`. Without it "reviewed" and "wrong" are one set and no
      accuracy rate exists. New capability `calls:write`, admin and owner only.
- [x] `GET /calls/metrics` reuses `readCallRecords` and the viewer's `scoreCalls`. One
      arithmetic, two surfaces. Rates are strings — the schema layer has no decimal, and
      an integer percentage loses the difference between a 0.4% transfer rate and a 0%
      one — and null where the denominator was zero.
- [x] `calls.test.ts`: 17 tests, two organisations, real HTTP against real Postgres. The
      load-bearing ones are cross-tenant correction, a transcript id from another call on
      the path, a member refused the verdict, and the timeline not leaking the policy
      number that the `caller said` event's detail holds.
- [ ] **No audio, deliberately.** Reasoning in `apps/api/src/api/README.md`. It is a
      caller's voice reading identifiers aloud and it needs expiring, single-use,
      unguessable URLs plus a record of who listened to whom — a slice, not a field.

**`call_events.detail` is projected, not published.** The column holds whatever the
orchestrator wrote: the caller's sentence, the entity they read out, a tenant id. The
timeline exposes nine named scalars (`stage`, `ms`, `seq`, `attempt`, `reason`, `subject`,
`outcome`, `tool`, `chars`) and drops the rest, in the query layer rather than in the
response schema — a projection that runs through the validator turns one unexpected value
into a 500 for the whole call. Speech reaches the client through `transcripts`, which is
the field a reviewer corrects, and nowhere else.

**Session log**

- Response schemas no longer carry `maxLength` on text that came out of the database. The
  interceptor projects through them, so a bound there is not a guard — it is a way to turn
  one unusually long turn into a 500 that blames us. Bounds belong on input.
- `recordTranscriptCorrection` and `loadCallRecords` grew scope-taking halves
  (`applyTranscriptCorrection`, `readCallRecords`) rather than copies. The viewer and the
  dashboard now record a verdict and score a call through one body each.
- `@ansa/db`'s suite failed once mid-session with rows another agent's run had deleted,
  and passed in isolation immediately after. Same shared-database interleaving already
  noted under area 1; still worth pinning down before there is CI.

### 3 · Tools and event webhooks: registration, tiers, credentials, redaction — done

*2026-08-09. `apps/api/src/api/tools/` — three controllers, a store, a vault wrapper and
one file (`refusals.ts`) whose whole job is to reach `@ansa/tools`' existing refusals.*

- [x] `GET`/`PUT /tools` — the organisation's HTTP connectors and MCP servers, whole
      document, `expectedVersion` in and a new `config_version` out. `GET`/`PUT
      /event-subscriptions` the same for receivers and redaction.
- [x] **Every dangerous configuration is refused by the code the call path runs, not by a
      copy of it.** `PUT` builds the candidate document, runs `parseConnectorConfig`, then
      registers every tool into a throwaway `createToolRegistry()` that already holds
      `CALL_CONTROL_DEFINITIONS`. That is what refuses a missing tier, a write tool with no
      readback, a speech template with no holes, a timeout over `HARD_TIMEOUT_MS`, a tenant
      tool named `transfer_to_human`, and a URL outside the tenant's own `allowedHosts`.
      Delete `refusals.ts` and every one of them still holds on the phone call.
- [x] Two publication-time additions, both using the guard's own exported functions rather
      than a second opinion: an `allowedHosts` entry or a URL that is a literal blocked
      address (`isBlockedAddress`), and a plaintext `http://` URL without
      `allowPlaintextHttp`. Both would otherwise register and fail every caller.
- [x] `GET`/`PUT`/`DELETE /credentials/{ref}`. **Write-only.** The response carries the
      name, the two dates, whether the configuration points at it, and whether it is an
      `auth` or a `signing` value — never the value, in any form, including masked.
      `DELETE` is 409 while a configuration still names it, read off the raw JSON so it
      keeps working on a document that does not validate.
- [x] A configuration naming a credential that is missing, unopenable, or the *other kind*
      is refused at publish. A signing secret used as a bearer token used to surface as a
      delivery failing at 3am.
- [x] 44 tests, no database: the refusals, the credential kinds (including a ciphertext
      moved between tenants, which the AAD stops opening), and a `GET`→`PUT` round trip that
      pins nested JSON Schema, identifier maps and per-receiver redaction inheritance.
- [ ] Not proven, and it needs a real tenant endpoint: that a tool published here answers a
      caller. Everything below the seam is Slice 6's and already dialled; what is untested
      end to end is dashboard → column → `prepareConnectors` → phone call.

**Redaction still defaults to nothing, and the API does not lean on it.** The organisation
is the data controller and the payload records a conversation their own agent had.
`GET` reports a receiver's rules only when the tenant wrote them — reporting the resolved
value would freeze inheritance on the next save, and a receiver added afterwards would
quietly stop picking up the default. Credential-shaped keys are stripped unconditionally
and are not a field here in either direction.

**Session log**

- **`parameters` is a JSON string on the wire, and that is a decision.** It is handed to the
  model untouched and nothing in this product interprets it, so describing it as a fixed set
  of fields would make `GET` then `PUT` silently destroy a schema `tools/tenant/config.mjs`
  wrote. The round-trip test is the thing that keeps a whole-document `PUT` safe to build a
  screen on.
- Publishing means reading the other twelve config columns and handing them straight back,
  because `app.publish_tenant_config` rewrites everything it takes. `store.ts` does that in
  one transaction. **The agent-configuration endpoints need the same function**, and there
  are now two copies of it — merge them into `@ansa/db` before a third appears.
- `routes.test.ts`'s source scan caught two files passing a tenant id positionally. Both
  were crypto arguments rather than query arguments — a registry key and an AES-GCM
  authentication tag — and the fix was to borrow `registry.ts`'s own name, `owner`, rather
  than loosen a heuristic that is right to be blunt.

**Suggested, not requested** — recorded so they are not mistaken for scope:

- **6 · Test-call button.** Configure, press, your phone rings. The gap between "I changed
  a prompt" and "I know if it is better" is where every defect this project has found was
  hiding.
- **7 · A correction queue rather than a call browser.** The event log already flags
  discarded hallucinations, escalations and repeated confirmations. Rank by those instead
  of making someone read calls hunting.
- **8 · Config diff and rollback.** `config_version` is on every call and the version
  table is append-only, so the data exists. Answers "it was working yesterday", which
  matters more for a voice agent because the regression is heard, not seen.
- **9 · Tool sandbox.** Fire a registered endpoint with test arguments and see the raw
  response, the summary, and what the agent would say — before a caller hears it.

**Known constraint on 5:** Twilio does not sell Nigerian numbers. "Claim a number" is the
first thing a Nigerian organisation needs and the one thing we cannot currently give them.

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
