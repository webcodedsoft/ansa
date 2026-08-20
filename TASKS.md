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

- [x] Automatic post-call quality scan (R9.2.1): low-confidence turns, repeated
      clarifications, failed number captures, DTMF fallbacks, silences over 2s,
      escalations, abrupt hangups, tool timeouts.
      *`apps/api/src/viewer/review.ts`. Twelve signals, every one an event the pipeline
      already writes, scored over the same `CallRecord[]` that `scoreCalls` and `priceUsage`
      read. No new telemetry path.*
- [x] Severity scoring and a **review queue** in the internal call viewer (R9.2.2).
      *`/viewer/review`, and `GET /api/v1/calls/review-queue` for the dashboard. Weights
      are a chosen ordering with the argument written next to each one, capped per signal
      so a long call cannot outrank a bad one.*
- [x] Transcript correction UI: play the audio, fix the text, save (R9.2.3). Keep it
      ugly and fast — you'll use it daily. **Text only — there is still no audio.** The
      form and both write paths landed in Slice 6a/7; the reason a reviewer cannot hear
      the turn is in the comment above `CallsController.correct` and it is a slice of its
      own (expiring URLs, an access log of who listened to whose voice).
- [x] Corrected turns promoted into the eval corpus with category labels (R9.2.4). The
      corpus from Slice 0 now grows on its own.
      *`/viewer/{callId}/claim.json` writes `eval/verdict.py`'s own claim format, with the
      configuration read off the call's `call configuration` event.
      `apps/api/src/viewer/claims.test.ts` runs the real `verdict.py` over the output.*
- [x] Correction feeds wired (R9.2.5): per-tenant keyterm vocabulary, normalizer test
      cases, prompt-adjustment candidates, missing-FAQ candidates. **Two of four, and
      suggested rather than applied** — `/viewer/suggestions`. Prompt-adjustment and
      missing-FAQ candidates are not built: the first needs a recurring *conversational*
      failure pattern and a corrected transcript is evidence about listening, and the
      second needs `search_knowledge_base`, which Slice 6 has not shipped.
- [x] Trend tracking so provider and prompt changes can be attributed to real movement
      (R9.2.6). *`viewer/trends.ts`, grouping `scoreCalls` by `calls.config_version`.
      On the metrics page and at `GET /api/v1/calls/trends`.*

**Done when:** you make three deliberately awkward calls, all three surface in the review
queue, and correcting them adds new entries to the eval corpus. **Not yet true — the loop
is built and no phone call has run through it** (rule 1). Nothing in this slice needs a
migration; the columns and the event kinds were all already there.

**Session log**

- *2026-08-09 — the review loop is joined and no call has been reviewed on it.* The parts
  existed and nothing connected them: `corrected_text` had two writers and no reader beyond
  a JSONL nothing parsed, the event log had every signal a scan wants, `verdict.py` had a
  format, and `config_version` was on every call.
- **Found while wiring, and the reason the scan would have read zero.**
  `packages/db/src/call-records.ts` selected six event kinds. `metrics.ts` counts
  `recovery_line` and `tool_call`; `cost.ts` prices `call configuration`, `tts_start`,
  `llm_start` and `agent said`. **None of those six kinds was selected**, so the viewer's
  silence rate, tool failure rate and the entire cost table have been reading zero against a
  database full of the events they are defined over — while every scenario test passed,
  because the harness hands `scoreCalls` its events directly and never goes through that
  query. A filter that drops the row a metric is made of does not fail; it agrees with you.
  The list now carries a rule about who its consumers are.
- **Confidence is now read for unreviewed turns too.** The old query took reviewed
  transcripts only, which made "the transcriber was unsure of this turn" invisible to a
  queue whose entire job is the backlog. One statement, with the text still gated on
  `corrected_at` so an unreviewed turn contributes a number and no speech.
- **`suggestions` has no button and will not get one.** `tenancy/defaults.ts` records the
  measurement — a domain-word list with no personal name in it deterministically turned
  "Sikiru" into "Akiro", three runs each way. Boosting is a bias, not a hint, so a pipeline
  that promoted corrections into keyterms would take the evidence that a word is misheard
  and use it to damage the words next to it, fastest for whoever corrects most.
- **A generated claim mostly refuses, on purpose.** One production call is one trial and
  `verdict.py` exits 2 rather than concluding; prose turns arrive `unlabelled` because the
  truth for a turn is not the truth for an item inside it and there is nowhere to mark a
  span; a configuration key the pipeline never recorded is emitted null and refused. All
  three are that tool's own rules pointed at production rather than exceptions to them.
- **What a call has to prove**, in this order: make three awkward calls — one where you
  read a reference badly enough to reach the keypad, one where you interrupt constantly,
  one where you say nothing after the greeting — and check all three are in
  `/viewer/review` above the ordinary ones. Then correct a turn on the first, open its
  `claim.json`, and check the identifier came out as an `expected` item rather than as
  prose. **The confidence threshold (0.6) and every weight are guesses until that
  happens**; they are one object, `DEFAULT_REVIEW_WEIGHTS`, so tuning them is one edit.

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

### 6 · Test call, config diff and rollback, tool sandbox — done

*2026-08-09. Suggestions 6, 8 and 9 above, built. `apps/api/src/api/testcall/`, plus
`config/diff.ts` and `tools/sandbox.ts` in the two areas they extend.*

- [x] `POST /test-calls` — rings a number from the organisation's own dialled number and
      answers 202 with the carrier's word for it. **Through `outbound/place.ts`**, which is
      the one door and the one consent gate; nothing in `src/api` calls `provider.placeCall`
      and a source scan in `testcall.test.ts` keeps it that way.
- [x] **Consent is not waived for a test, and there is no flag that waives it.** No consent
      on record, a suppression, or 21:00 WAT is a 422 carrying `consent.ts`'s own sentence.
      A verified-own-number flow is described in the controller as what it would have to be
      — a consent row with its own basis, written when the proof happened — rather than as
      an exemption, because a gate with one exemption is a gate with an exemption-shaped
      hole and the hole would be the one with a button on it.
- [x] `GET /config/diff?from=&to=` — leaves, not objects: `businessHours.closesAtHour`
      rather than two JSON blobs to compare by eye, and keyterms as a set because
      reordering them changes nothing on a call.
- [x] `POST /config/versions/{version}/rollback` — **publishes the old content as a new
      version**. Nothing rewrites history, so a call that recorded version 4 can still be
      explained (R7.5), and the restored content goes through the same
      `publicationProblems` a hand-written publication does: a version that was valid
      yesterday and trips a guarantee added since is refused with the field named, rather
      than quietly restored and silently dropped from the prompt on every call.
- [x] `POST /tools/{name}/test` — the raw response, the summary, and the normalized speech
      (R5.4.3). Through `packages/tools`' one dispatch path, so the tiers hold: a `write`
      tool answers with its readback and does not fire, an `irreversible` one transfers,
      and a tool that identifies a person refuses until the caller's detail is asserted.
      The raw side arrives through a new `onResult` observer on the dispatcher — the call
      path does not pass one, and an observer that throws cannot turn a tool call that
      worked into one that failed.
- [x] 27 tests, no database: the diff, the tiers a sandbox run meets, the carrier
      environment, and the two source scans.
- [ ] Not proven, and it needs a real tenant endpoint and a real phone: the `ok` branch of
      the sandbox, and a test call ringing. The egress guard refuses loopback deliberately,
      so a server on this machine is not a substitute and a fake transport would be testing
      a fake. What sits under both is dialled: `connector/http.test.ts` for the request and
      response, `dispatch.test.ts` for the observer, `consent.test.ts` for the verdict.

**Session log**

- **The sandbox needed the raw result and the dispatcher had nowhere to put it.** The
  alternatives were a decorating adapter — which is a second thing invoking `execute` and
  the test that keeps one call site is right to be blunt about it — or a `raw` field on the
  outcome, which would put a caller's own record in an object the orchestrator logs. An
  opt-in observer is neither, and it is absent on every call.
- **A test call's `from` is the organisation's own number, not an environment variable.**
  A platform-wide number would put an unfamiliar caller id on the screen of somebody
  testing whether their own line works, and the carrier account already owns theirs.
- `ApiModule` deliberately does not import `TelephonyModule`, because `AppConfig` throws
  without a TTS key and the API's integration test boots the module with nothing but a
  database. So the three carrier variables are read in `origination.ts` and their absence
  is a 503 on one endpoint rather than a process that will not start.
- **`openapi.json` was regenerated in a scratch worktree at HEAD** with only these changes
  copied in. Regenerating in place would have committed another agent's uncommitted routes
  into the spec, and `openapi.test.ts` would then have failed on the commit that did it.

## Slice 10 — The dashboard itself (`apps/web`)

Next.js 16 in the monorepo, consuming the Slice 9 API. Built so that testing a change stops
requiring a second person to read server logs: change a setting, press a button, answer the
phone, read the call turn by turn.

- [x] Next.js app at `apps/web`, port 3100, Tailwind v4, zod, zustand, lucide, clsx
- [x] Sign in, including the organisation picker when an address belongs to several
- [x] Sign up — create an organisation and the account that owns it (`POST /auth/sign-ups`,
      migration 0017, `app.create_organisation`)
- [x] Accept an invitation, which had no screen at all and made the dashboard unenterable
- [x] Agent screen — identity, behaviour, vocabulary, hours, escalation, publish
- [x] Calls screen — list with cursor pagination, and the test-call button
- [x] Call review — turns and transcripts merged by offset, corrections, event timeline
- [x] `pnpm lint`, `pnpm typecheck`, `next build` and the wiring check all green

### What this settled, and what it cost

**Every request is server-side, and that was not a preference.** The API enables no CORS, so
a browser cannot reach it at all. The session token therefore lives in an httpOnly cookie,
Server Components read and Server Actions write, and there is no `NEXT_PUBLIC_` variable
anywhere. A relay route handler would have put the token where page scripts can read it.

**The generated client had never compiled.** `apps/api/src/api/openapi/client.ts` has existed
and been tested since Slice 9, but nothing consumed its output until now. Two defects fell
out on first use: it emitted `test-calls:` and `event-subscriptions:` as object keys, which
are syntax errors, and it typed path parameters as `string` when the configuration version
endpoints take an integer. Both fixed in the generator; the frontend building is now the
check. The client is committed for the same reason `openapi.json` is.

**The publish form carries every field, deliberately.** `POST /config/versions` rewrites the
whole document — business hours and escalation are on the agent screen not because the
testing loop needs them but because a form that could not see them would clear them, and the
version history would record the loss as intentional.

**Toasts exist because of `revalidatePath`.** A publish revalidates the page, the form
re-renders, and an inline success message goes with it. The zustand store lives outside that
subtree so the confirmation survives the refresh that proves it worked. Failures stay inline,
next to the field that caused them.

**There was no way into the product.** `owner.mjs` mints an invitation and prints a token, and
nothing could redeem it — the dashboard had a sign-in page and no screen behind it. Worse, a
person arriving without an operator had no path at all. Both doors now exist, and both go
through a definer function because `ansa_app` has no INSERT on `users` and `tenants` is behind
an RLS policy keyed to the current tenant. Loosening either was the alternative and both are
load-bearing.

**Sign-up authenticates before it creates.** An address that already has an account may start
a second organisation, so the password is verified first and a wrong one is refused with the
same 401 a failed sign-in gets. Without that check anyone could type a stranger's address and
attach that account to an organisation they own; the stranger gains no exposure but finds an
organisation they never joined in their list. Proven three ways against the running API: new
address creates, existing address with the right password creates and reports
`createdUser: false`, existing address with the wrong password gets 401 and writes nothing.

**Structure.** Each feature owns `*.schema.ts` (zod, and the API body it becomes),
`*.service.ts` (the only place that feature talks to the API) and `*.actions.ts` (parse, call,
report), plus its own components. Pages read services; nothing outside a feature's service
builds a client for it.

### Deliberately not built

Members, invitations, credentials, numbers, event subscriptions and the tools registry all
have complete endpoints and no screen. None is in the configure-call-read loop, and each is
a surface that would be built twice if built before somebody needs it.

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

## Multi-agent (2026-08-15)

`tenants` was the agent: one row held the organisation *and* its persona, voice, greeting,
vocabulary, hours, escalation and number. An organisation now runs many agents, and a
number reaches exactly one.

**Done, and proven against the dev database.**

- [x] `0018_agents.sql` — `agents` table, `agent_tools` selection, `tenant_prompt_versions`
      re-keyed to `(agent_id, version)`, `calls.agent_id`. Backfilled 33 tenants to 33
      agents; all 4 versions and all 111 calls carry an agent. Ingress
      (`app.tenant_config_for_number`) still answers in one round trip and now returns
      `agent_id` and `enabled_tools`.
- [x] `0019_tenant_numbers.sql` — closes a hole 0018 opened. Moving `dialled_number` onto
      a table organisations write would have let one claim a line it does not control,
      which is exactly what `numbers.controller.ts` was written to prevent. Ownership now
      lives in operator-written `tenant_numbers` (ansa_app has SELECT only); agents hold
      the routing, joined by a composite FK. **The first draft of the
      `tenant_number_routing` view leaked every organisation's numbers** — a Postgres view
      runs as its owner, so RLS was inert until `security_invoker = true`. Verified: base
      table 0 rows, view 2 rows, before the fix.
- [x] Per-agent tools. The registry stays per organisation; `agent_tools` says which of it
      an agent may call, filtered in `prepareConnectors` *before* the model is briefed, so
      an agent never offers a tool it would then be refused. Empty selection means no
      tools, never all of them.
- [x] The answering agent is recorded on the call (`CallTenant` → `CallSettings` →
      `recordCallStarted`). `configVersion` alone stopped identifying a configuration the
      moment two agents could both be on version 3.
- [x] Three adversarial tests in `isolation.test.ts`: an agent gets only what it selected,
      an empty selection gets no organisation tools but keeps the platform's three, and a
      selection naming an unregistered tool grants nothing.

1062 API tests, 302 tools tests, repo lint and typecheck green.

**Endpoints and page, done.**

- [x] `GET/POST/GET:id/PATCH/DELETE /agents` and `PUT /agents/:id/tools`, on `config:read`
      / `config:write` — an agent *is* the configuration, so a second `agents:*` vocabulary
      would have meant two names for one permission. `agents.ts` reshaped to take a
      `TenantScope` like the rest of the API surface, so no call site names a tenant.
- [x] Routing here, ownership not: an organisation picks which of its agents answers a line
      it already holds, and still cannot add a line. Both database refusals collapse into
      one 409 that does not say which fired — telling "already routed" from "not yours"
      apart lets somebody walk a number range to find who is a customer.
- [x] `agentId` filter on `GET /calls`. Distinct from `dialled`: a number can move between
      agents, so this survives a reassignment where filtering by number does not.
- [x] `openapi.json` and the web client regenerated; drift test green.
- [x] `/agents` reads `GET /agents` and renders N rows with per-agent counts. Verified with
      two agents: the second showed 0 calls and a dash rather than the org's 66 and 0%.
      Archiving it removed it from the list.

1062 API tests, 302 tools tests, repo lint and typecheck green.

**Agent detail page redesigned (2026-08-15).**

- [x] Entity header carrying All agents / Test call / Publish. Publish submits the form
      below it through the plain `form` attribute, so the control sits where it belongs
      with no client state and no second copy of it.
- [x] Overview rebuilt: three figures with week-on-week movement, an attention list, then
      recent calls. A readiness checklist used to lead here, which answered a question
      nobody with a working agent was asking.
- [x] Deltas are measured — four total-only call queries across two consecutive seven-day
      windows — and suppressed when the previous window was empty, so a first week cannot
      claim a triumph. Latency compares the live version's p50 against the previous
      version's, since a rollout is the usual reason it moves.
- [x] Attention rows use each readiness check's `detail`, not its `title`. The titles are
      phrased as the state you want ("A number is attached"), so beside a "blocked" tag
      they read as contradictions.
- [x] Knowledge tab added to match the design, holding an honest empty state — there is no
      document store behind it yet.

**Behaviour switches wired end to end (2026-08-15).**

- [x] `0020_agent_behaviour.sql` — `agents.barge_in` (default true) and
      `agents.answering_machine_detection` (default false), returned by all three
      `app.*_config_*` functions so the answer path still costs one round trip.
- [x] Reaches the AI. Barge-in threads `TenantConfig` → `CallTenant` → `CallSettings` →
      `runConversation`, and gates the `stopSpeaking("caller interrupted")` teardown only —
      the turn start is still stamped and the transcript still commits, so switching it off
      makes the agent finish its sentence rather than stop listening. AMD rides the
      existing `Promise.all` in `place.ts` and is expressed by withholding
      `amdCallbackUrl`, because Twilio only detects when it has somewhere to report to.
- [x] `PATCH /agents/:id` accepts both; the console saves on flip, with optimistic state
      that reverts if the write is refused. Verified in the browser against the database:
      each flip landed on the right agent and left the sibling alone.
- [x] Transfer-on-escalation is deliberately NOT a column. It is enforced in the dispatch
      path so neither a setting nor a prompt can talk it out of it; the row is drawn
      because it is true, and fixed because a switch for disabling a safety rail should
      not exist.
- [x] Per-section Save on the Conversation tab. The switches save instantly on their own;
      the script sections each publish. One caveat worth knowing: the API's configuration
      is a single atomic document, so a section Save publishes the whole of it as one
      version with the untouched fields carried along.

**The voice form reaches the call (2026-08-15).**

- [x] `0021` stores it, `0022` puts it on the answer path — one more jsonb column on the
      ingress query that was already happening, so the 800ms budget is untouched.
- [x] `parseCapturedFields` never throws. `captured_fields` is jsonb an operator can write
      by hand, so a malformed entry costs that one field and is logged with the agent —
      the promise `prepareConnectors` makes about tools, for the same reason.
- [x] Composed into the **task layer**, not the tenant layer. It is structured
      configuration built in the console rather than free text typed at the model, so it is
      not fenced and not filtered — every sentence is generated from a closed set of routes
      and confirmations, and the only tenant string in it is the question's wording. The
      guarantees still compose after it, so a field cannot reach past them.
- [x] The route is stated, not inferred: an agent that says "read it to me" when the caller
      should key it in loses digits the line would have carried intact.
- [x] Six tests in `compose.test.ts` — empty form says nothing at all, the operator's
      wording survives, route and confirmation are stated, order is preserved, guarantees
      still land last.

**Publishing was broken by 0018, and is fixed (2026-08-15).**

Asked "is the Conversation tab actually wired to the call agent?", the answer was no, in
three places. 0018 re-pointed every *read* at `agents` and left the *writes* behind.

- [x] `0023` — `app.publish_tenant_config` wrote to `tenants`, which nothing on the answer
      path reads any more, and its version insert omitted the `agent_id` that 0018 made NOT
      NULL. **Every publish since 0018 threw.** It now writes the agent-shaped columns to
      `agents`, keeps the shared registry on `tenants`, and stamps the history with its
      agent. Verified against the database: publish returns v2 and the call path reads the
      new greeting, persona and keyterms.
- [x] `0024` — `app.create_organisation` made a tenant and a membership but no agent, so
      every organisation signing up after 0018 had none: it could not publish and its agent
      list was empty. Now a trigger on `tenants`, not a line in that function, because
      sign-up, the db tests and an operator's psql session are three doors and three
      chances to forget.
- [x] `tenant-config.ts` — `readStoredConfiguration` and `loadCurrentTenantConfig` still
      selected the agent-shaped columns from `tenants`, which compiles and silently returns
      pre-0018 values. Re-pointed at the tenant's oldest live agent, matching the rule
      `app.tenant_config_for_id` and `publish_tenant_config` use.
- [x] Call tracing keys on `agent_id`, falling back to tenant-plus-version for calls
      answered before 0018 — those have no agent and never will, and R7.5 is the
      requirement that they stay explicable.

**Process note.** `pnpm --filter @ansa/db test` runs against a real database and had been
failing since 0018; the gate being used was lint, typecheck and the API suite, which mock
it. Run the db suite after any migration. The broken half here was loud, the dangerous half
silent — a screen reporting a new version over a script the caller never hears.

**"Tenant" is now "organization" (2026-08-15).**

One concept had two names and the person it confused most was the one who owns the product.

- [x] `0025` — `tenants` → `organizations`, `tenant_id` → `organization_id` on 19 tables,
      `tenant_credentials`/`tenant_numbers` renamed, and `tenant_prompt_versions` →
      `agent_prompt_versions` because 0018 re-keyed it on the agent and the old name had
      been describing the wrong owner since. The setting moved too: `app.tenant_id` →
      `app.organization_id`, so old code against the new schema is scoped to nothing and
      reads no rows — loud and empty, never someone else's data.
- [x] Function bodies were read out of `pg_get_functiondef` and transformed mechanically,
      not retyped, so none could quietly lose a clause. Dropped and recreated rather than
      replaced, because renaming an OUT parameter changes the return type.
- [x] Two renamed for accuracy rather than vocabulary: `tenant_config_for_number` →
      `agent_config_for_number`, `tenant_config_for_id` → `agent_config_for_organization`.
      Both return the agent's configuration and have since 0018.
- [x] 20 RLS policies recreated against `app.current_organization()`. `do_not_call` was
      written out by hand rather than generated: its `OR organization_id IS NULL` is the
      platform-wide suppression list, and generating it would have dropped that clause.
- [x] ~2,900 TypeScript sites renamed by script with `multi-tenant` and `tenancy` guarded —
      multi-tenancy is the architecture and keeps its name; the entity is an organisation.
      Files renamed to match, including `tenants.ts` → `call-config.ts`, which was never
      about the organisation: it loads the answering agent's config at ingress.

Verified: zero objects named tenant remain in the database, an unscoped `ansa_app` session
reads 0 rows from every table, and a scoped one reads only its own. 51 db + 302 tools +
1069 API tests, lint, typecheck and the web build all green.

**No agent is created automatically.**

- [x] `0025` drops the 0024 trigger. An organisation with no agent is now a real state —
      what a new sign-up looks like — and `app.publish_agent_config` refuses loudly rather
      than guessing. The db fixtures create their agent explicitly, as the console will.

**Organisation and agent are separate documents (2026-08-15).**

Not defaults-and-overrides. They answer different questions, and the organisation is where
billing, roles and retention will land — none of which an agent should inherit a field from.

- [x] `0026` — dropped 13 agent-shaped columns from `organizations` that 0018 had left
      behind "in case the copy was wrong". The copy was right, and what remained was a
      greeting no caller had heard since August sitting in a column called `greeting`. That
      is the shape of the next bug, not merely untidy.
- [x] `0027`/`0028` — **business hours moved back to the organisation.** 0018 swept them
      onto the agent because they sat in the same block, which was wrong on inspection: a
      greeting differs between agents, "when is this company open" has one answer. It also
      made the after-hours agent incoherent — it exists because the office is shut, so it
      must not be able to believe otherwise. Publish writes them to the organisation; the
      three config functions read them from there.
- [x] `GET/PATCH /organization` — name, created, and read-only `audioRetentionDays` and
      `consent`. One writable field, because one is what an organisation may change about
      itself today. The endpoint offers no way to change the operator-set values rather
      than accepting and ignoring them.

The split, as it now stands:

| Agent | Organisation |
|---|---|
| greeting, persona, instructions, voice, keyterms | name |
| escalation, dialled number, config version | business hours |
| barge-in, AMD, captured fields, tool selection | audio retention, consent (operator-set) |
| version history (`agent_prompt_versions`) | tool registry, webhook subscriptions |

**Known loss, on the record.** Opening hours are no longer in an agent's version snapshot,
because the organisation is not versioned. A call from three weeks ago can no longer be
explained in terms of the hours it ran under. `organization-config.test.ts` asserts this
so it stays a decision rather than a surprise. Versioning the organisation is the fix.

**Agent templates with preview.**

- [x] Five templates (customer service, after hours, appointment booking, renewals, blank),
      each carrying persona, greeting, instructions, ordered captured fields and the two
      switches. Nigerian throughout. `/agents/new` shows them as cards with a live preview
      of the resulting call, generated from the template rather than written out.
- [x] Creation is `POST /agents` → `PUT /agents/:id/fields` → `PATCH /agents/:id`, the last
      only when the switches differ from defaults.
- [x] Fixed a real bug the preview exposed: the spell-out rule keyed off whether the sample
      contained a space, which read "R e n e w" back to a caller who said "Renew". The
      field's *type* decides now — identifier, number and phone are spelled; name, date,
      choice and text are said.

**Tools tab, per agent (2026-08-15).**

- [x] The tab was read-only and its notice said per-agent selection did not exist — which
      stopped being true when `agent_tools`, `PUT /agents/:id/tools` and the `enabledTools`
      filter in `prepareConnectors` landed. It is now the screen for that.
- [x] Every registered tool with its tier, and beside each one what the tier actually does:
      read runs on request, write only after a spoken readback, irreversible never runs and
      transfers. Written per row rather than once at the top, because the tier is the whole
      decision being made — switching on an irreversible tool is agreeing it never fires.
- [x] Credential reference and route host shown; the full URL is not, since a path can
      carry an identifier and this is a list somebody reads.
- [x] Selections naming a tool the registry no longer holds are surfaced rather than left
      invisible until dispatch refuses them mid-call.
- [x] `saveAgentTools` saves the whole selection, unversioned — revoking a tool should take
      effect on the next call without publishing whatever is half-written elsewhere.

Verified end to end against a seeded registry: enabling `check_policy` wrote one
`agent_tools` row for that agent and left its sibling untouched. Registry restored to null.

**A test that was never flaky, and the API's own validation.**

- [x] `onboarding.test.ts > counts calls and deliveries as numbers` had been failing
      intermittently since the start of the session. It was not flaky: the fixture inserts a
      `pending` delivery with the default `next_attempt_at = now()`, and
      `app.claim_due_event_deliveries` claims exactly that. **Any locally running API would
      pick it up, fail to deliver it, and mark it failed** — so the test read three failures
      where it seeded two, and passed or failed depending on whether someone had an API
      running. The fixture now dates its rows a day out.
- [x] Teardown moved to the operator role: deleting an organisation cascades into
      `organization_numbers`, which `ansa_app` may only read, so the final statement failed
      and rolled back the whole transaction — cleaning nothing.
- [x] Worth recording: seeding a registry by hand was refused twice by the API's own rules —
      once for a tool with no `speech` (raw JSON is never spoken, R5.4.3) and once for a
      `speech.template` with no placeholders, which would say the same thing every call.
      Both are good rules and both caught me.

**Capture driven by agent fields — foundation (2026-08-15).**

`CAPTURE_WIRING.md` §7 left `expecting(kind)` unwired: "who decides *when* to ask belongs
to the conversation director, and nothing decides it yet". The agent's configured fields
are that decision. Capture was purely reactive — `classify()` on what a caller volunteered
— so an agent could confirm a value but never ask for one.

- [x] **One vocabulary.** The engine knows twelve entity kinds; the field builder offered
      seven that mapped to five, so email, NIN, BVN, OTP, address and time could not be
      configured at all even though the engine captures them well — including an eleven
      digit check and an email spelling fallback. The captured-field `type` is now the
      engine's own kind, so there is no translation to get wrong.
- [x] Documents written under the old vocabulary normalise on read (`identifier` →
      `reference`, `number` → `quantity`). A stored identifier silently becoming free text
      would have stopped it being read back — a downgrade invisible until a call went wrong.
- [x] **One preview.** `field-builder.tsx` and `conversation-preview.tsx` each had their own
      copy of the samples and spelling rules and had already drifted: one decided whether to
      spell a value out by asking if the string contained a space. Both now use
      `capture-vocabulary.ts`.
- [x] `form.ts` — the director. Ordered fields, what is outstanding, where an answer
      belongs. Pure: no speech, no state machine, never sees a transcript.
- [x] 16 tests, mostly edges:
      an agent with **no form is inert in every direction** (the case that matters most —
      it is every agent today, and a call that worked yesterday must not change);
      `choice` and `text` are required-but-uncapturable and must not hold a call open;
      a volunteered value goes to the first outstanding field of that kind and a **directed
      answer beats it**, because two `reference` fields cannot be told apart from a value;
      a duplicate key is ignored rather than given two questions and one answer slot;
      a declined optional field is settled, and accepted if the caller later gives it;
      a correction overwrites; unconfirmed is stored as unconfirmed.

**Wired into the call (2026-08-15).**

- [x] `call-facts.ts` gained a `captured` map keyed by the operator's field key, as a third
      arm of `Observation`. Its own arm rather than a widened `field`, and that is the
      safety argument: the arm takes `EvidenceSource`, which has no `"model"` member, so a
      model-sourced capture does not compile. Configured values follow the identifier rules
      exactly — they are collected because a tool will act on them.
- [x] `orchestrator.ts` routes a confirmed value to the field the agent asked for, falling
      back to the first outstanding one of that kind, and only then to `FACT_FIELD_FOR`.
      That last path is not cruft: an agent with no form still captures reactively, and a
      caller who volunteers their name should still have it recorded.
- [x] `armNextField()` puts the engine into `awaiting` for the next field — at the greeting
      and after each answer. The question is deliberately **not** spoken by the engine: the
      prompt already tells the model what to collect, and both speaking would ask the
      caller the same thing twice. What is taken is directed parsing, which is §7's whole
      argument — "the fourteenth" is a fragment in free speech and a date in answer to a
      question. Armed only from idle, so it cannot discard a readback in progress.
- [x] `media.gateway.ts` resolves a tool's `identifiers` from the captured map first, then
      the built-in three. A tool naming `claimNumber` used to answer `unconfirmed-identity`
      on every call, silently, discoverable only by making one.
- [x] Six tests on the captured facts, including the precedence rule I got wrong first
      time: a **transcriber** contradicting a confirmed value is contested, a **caller**
      correcting themselves is applied. The caller is the authority; contesting them would
      leave the agent holding a number they had just said was wrong.

1091 API + 51 db + 302 tools, lint, typecheck and a full build green.

**Still open.**

- [x] **`pattern` and `attempts` honoured (2026-08-15).** The operator's regex runs after
      the readback, not before. Deliberate: the engine establishes what was *said*, and
      asking "did I hear PM eight five nine two" about a value that is about to be rejected
      is the only way the caller learns they were heard correctly and the number is still
      wrong. Checking first says "sorry, say that again" to someone who said it perfectly.
- [x] Anchored like HTML's own `pattern` attribute, because `PM\d{7}` unanchored accepts
      `PM8592625-OLD` — right prefix, wrong record, and the agent would look it up.
- [x] An invalid regex accepts everything at runtime and is refused at write time. Both
      halves are needed: a stray bracket must not become a call that cannot get past its
      first question, and it must not silently become a format check that never runs.
- [x] Values over 256 characters fail rather than match. There is no regex timeout in
      JavaScript, so a backtracking pattern would block the event loop of a process
      carrying other people's calls. A cap is a ceiling, not a fix — worth knowing.
- [x] `attempts` counts per field, then escalates. With no handoff configured the agent
      says so plainly and carries on: a configuration dead end degrades into speech, never
      into silence.
- [x] Five scenarios in `conversation.test.ts` §20 drive a form through the whole
      orchestrator — the first tests exercising the director, the capture engine and the
      fact store agreeing on one call rather than each alone.
- [x] **The Tools tab names what it cannot feed (2026-08-15).** Each row says which of its
      `identifiers` this agent never collects, and an enabled one raises a notice. Only
      `callerName` and `policyNumber` resolve without a field — `customerId` has a slot in
      the fact store and no path that fills one.
- [ ] `redact: true` is stored and shown but does not yet suppress a value in transcripts.
- [ ] `publish_agent_config` still takes the organisation and resolves the oldest live
      agent. One agent per organisation hides it; two will not.
- [ ] **None of this has been heard on a real call.** See below.

### What reviewing those claims turned up (2026-08-15)

Checking my own summary found four defects, three of them from the same root: the fact
store learned to hold configured fields and its *other* consumers were never told.

- [x] **Configured identifiers were not being redacted.** `capturedIdentifierValues` feeds
      the transcript redactor and enumerated three built-in fields. An organisation that
      switched `captured-identifier` masking on had the two reachable built-ins masked and
      a NIN, BVN or one-time code collected through a configured field left in the
      transcript in full. The function had no test at all, which is how it survived.
- [x] **The model never saw a configured value.** `renderFacts` rendered the same three
      built-ins, so a caller could confirm their claim number and be asked for it again a
      turn later — the exact failure capture exists to prevent. Corrections had the same
      hole: a correction the model is not told about is the one it undoes.
- [x] **The `captured-identifier` webhook omitted them**, so an organisation collecting a
      claim number received an empty object.
- [x] **The form was absent from config history** (migration 0029). `setCapturedFields`
      wrote the column directly: no version bump, no snapshot. Two calls could record the
      same `config_version` and have collected different things, and nothing anywhere
      recorded what an agent had been asking callers for. For a feature whose job is taking
      names and policy numbers off people, that history *is* the audit. Editing the form now
      goes through `app.publish_captured_fields`, which bumps and snapshots in one
      transaction. Old rows keep an empty array, which reads as "not recorded" — backfilling
      them would claim every past version collected today's form.
- [x] A guard test pins `FACT_FIELD_FOR` against the Tools tab's `WITHOUT_A_FIELD`. The web
      app cannot import from the API, so that duplication is real; without the test the
      console can confidently describe a rule the call path no longer follows.
- [x] A `@ts-expect-error` test pins the thing I claimed in the last commit message: the
      captured arm takes `EvidenceSource`, which has no `"model"` member.

Not fixed, and deliberately: `customerId` remains an `IdentifierField` with no path that
fills it. The configured path covers it properly — a field keyed `customerId` resolves —
and removing the slot would change `IdentifierField` across the fact store, the prompt and
the event payload for no behavioural gain.

### R5.2.4 withdrawn — nothing redacts a caller's value (2026-08-15)

Removed on instruction, and the instruction was right for a reason worth writing down: a
masking capability that catches values with a *shape* and misses names in prose, dates of
birth, addresses and health disclosures is worse than none, because it invites an
organisation to believe an obligation is handled when it is not.

- [x] `packages/tools/src/redaction.ts` deleted with its tests. `redactPayload` now takes a
      value and nothing else.
- [x] The `redaction` block is gone from the events config API, the webhooks form, the
      connect schema and the server action. A **stored** block is ignored rather than
      refused — an organisation that saved one would otherwise have every event delivery
      stop, which is far worse than sending their data complete.
- [x] `capturedIdentifierValues` deleted. It existed only to feed the redactor.
- [x] `logSafe` deleted, and `ENTITY_POLICY.sensitive` with it once nothing read it. The
      event log now carries a NIN, a BVN and a one-time code in full.
- [x] The per-field `redact` toggle is gone from the API, the field builder and the
      templates. It was stored and displayed and could never do anything again.
- [x] R5.2.4 struck through in `PRD.md` with the reasoning; `docs/EVENT_WEBHOOKS.md`
      rewritten to tell an organisation what changed and what to check.

**What survives, and it is not the same rule.** Credential-shaped keys are still stripped
from every log line and every outbound payload, unconditionally and with no setting
(R5.2.1). That is not caller data — it is material held in trust. A test asserts it
alongside the ones asserting caller values go out complete, so the boundary is pinned in
both directions rather than described.

**The consequence, stated plainly.** Transcripts, event payloads and the internal event log
now hold whatever the caller said, national identity numbers and one-time codes included.
They are identifying data at rest. `recordings/`, `eval/runs/` and `eval/results/` are
already gitignored for that reason; the event log deserves the same care and does not yet
have a retention rule of its own.

- [ ] The event log has no retention policy. Audio does (`audio_retention_days`); the words
      do not, and the words now carry more than they did yesterday.

### Tool creation is a form now (2026-08-15)

The whole registry was one JSON textarea labelled `http and mcp`. It asked every operator
to know JSON Schema, the tier rules and the egress allowlist, and gave them one error at a
time to find out with. Replaced with a per-tool form, grouped like a wizard and laid out on
one sheet — steps read better the first time, a sheet reads better every time after, and
most of a tool's life is spent being edited.

Two of the four asks were not form work at all; the connector could not express them.

- [x] **Path parameters.** `{placeholders}` in the URL path, filled from arguments and
      consumed so they are not also sent in the query or body. Orthogonal to `send`, because
      REST is: `POST /policies/{id}/claims` puts one argument in the path and the rest in a
      body. Each value goes through `encodeURIComponent`, which is the whole security of the
      feature — unencoded, an argument of `../../admin` climbs out of its segment, and the
      model picks these values from words a caller said. A placeholder anywhere but the path
      is refused: one in the host would let an argument choose which server is called while
      the egress allowlist still checked the configured host.
- [x] **Static headers**, with `authorization`, `cookie`, `x-api-key` and the rest refused
      outright. Not a style rule — `GET /tools` returns the document, so a static credential
      header would make the secret readable by anyone who can read the configuration, which
      is exactly what `credentialRef` exists to prevent. Line breaks in a value are refused
      too. Custom headers are applied *before* the credential and content-type, so one can
      never displace them.
- [x] **The no-record sentence** was already `speech.fallback` and already wired to the
      404-means-no-record path. It now has a labelled field saying what it is for.
- [x] **Query or body** is a control that disappears on GET rather than a save that fails.

Also: the URL's host is added to the egress allowlist on save. That was the failure costing
the most and showing the least — the tool registered, the model was told it could use it,
and every call answered "sorry, I couldn't get that just now" with nothing on screen
explaining why.

`map()` is new in the request-schema DSL, for header names that belong to somebody else's
API. The client generator emitted `Record<string, never>` for it — a type accepting no
entry at all — so that was fixed in the same pass.

The parameter builder degrades rather than flattens: a stored schema with nested objects or
enums opens as raw JSON with a note, because rewriting somebody's hand-written schema into
three simplified rows on save is worse than not editing it.

MCP servers appear in the list, still run, and round-trip untouched.

- [x] **Fetch a sample response, and the form is steps (2026-08-15).** `POST /tools/sample`
      does one GET and hands back the body; the fields it found become clickable chips that
      insert `{placeholders}` into the sentence. It closes the failure the step exists for: a
      template naming a field the response does not have renders the no-record sentence, and
      on a call that is indistinguishable from the customer genuinely having no record.
      - It is a server-side fetch of a URL somebody typed, which is the shape of every SSRF.
        Safe because it goes through `createEgressGuard` — the same guard the call path uses
        — so no non-https scheme, no credentials in the userinfo, no private or link-local
        address, checked on every redirect hop and every resolved address rather than the
        first. Five of the eight tests are refusals, and they deliberately do not inject a
        guard, because what they prove is that the default is the real one.
      - The **allowlist** is the previewed host rather than the saved list. That list stops
        the *model* reaching an unlisted host mid-call; this is an operator asking to see a
        URL they are about to save into it, and requiring it first would mean editing your
        egress policy to find out whether you want to. Nothing about reaching inside the
        network changes — those checks are on the address.
      - **GET only.** A sample of a POST would perform whatever that POST does, and finding
        out what a cancellation endpoint returns by cancelling something is not a preview.
        For those the tier is the answer: save, then use the test step.
      - Paths are offered exactly as `renderTemplate` reads them, arrays at index 0 only. A
        field that cannot be addressed would be worse than none — it would be pasted in and
        fall through to the fallback.
- [x] The form is a `Stepper`, whose steps stay clickable: stepped to learn, jumpable to
      edit. Saving works from any step, because somebody who came back to change a timeout
      should not have to walk to the end to keep it.
- [x] An empty credential list says so and links to `/credentials`, instead of a dropdown
      whose only option is None. Not a bug — RLS was correctly hiding another organisation's
      credentials — but indistinguishable from one on screen.
- [x] **A step with a problem is marked in the rail (2026-08-15).** `StepDef.invalid`
      replaces the number with `!` and reads "needs a fix" beside the title — not colour
      alone, and it beats "done" so walking past a broken step does not tick it off. Problem
      keys are prefix-matched to steps, and anything unrecognised is attributed to the first
      step rather than dropped: a key with no home would mean a save that refuses while no
      step says why.
- [x] **Testing no longer waits for a save.** `POST /tools/try` builds an ephemeral document
      from the draft and hands it to the same `runToolInSandbox` the saved test uses — one
      execution route, a different document, which is the only version of this that does not
      become a second dispatch path. The tiers therefore still hold: a write answers
      `confirm` without firing, an irreversible one `transfer` and never runs.
      Waiting for a save meant publishing a configuration version to find out whether the
      thing worked and another to fix it, so the history filled with attempts rather than
      decisions — and every attempt was live on the line in between.
      The run is blocked while anything is invalid, because a half-written tool reports the
      wrong problem: a missing readback comes back as a refusal and the operator goes
      looking at their endpoint.
- [x] **Headers were being dropped on save.** They went into the request schema and the
      connector in one commit and into `toToolDocument` in the next, so for one commit a
      header could be typed, validated, saved and silently absent from the column. One
      `toStoredTool` now serves both `PUT /tools` and `POST /tools/try`, with a round-trip
      test.
- [x] **A `{placeholder}` in the query string works, and the naming said otherwise.** I told
      the user a URL like `?regNo={riskId}` would be sent literally. Wrong: `parseUrlParams`
      allows a placeholder anywhere after the origin, and `fillPath` replaces it across the
      whole URL, so a query placeholder is filled and consumed exactly like a path one. Only
      the origin is off limits, which is the SSRF rule and nothing to do with paths.
      `pathParams` was renamed `urlParams` and every message saying "path" now says what the
      rule is, because a field named for half of what it holds is how the next reader gets
      it wrong too. A test now pins query-string substitution end to end.
- [ ] Not built: the curl/OpenAPI import.

### Soft delete, where it means something (2026-08-15)

`deleted_at` on `organizations`, `users`, `memberships`, and `agents` — whose `archived_at`
was renamed rather than joined by a second flag, because two columns meaning "gone" is a
bug the first time code checks one. Not on the other sixteen: a soft delete that reads
still return is worse than none, and audio is hard-deleted on purpose because retention is
a promise that a caller's voice actually goes.

The column was the hour; honouring it was the work.

- [x] `users` RLS policy grants sight through a membership, so it now requires a live one.
      Without that, removing somebody left them readable — and left the row saying they
      belonged.
- [x] `authenticateSession` requires a live user *and* a live membership. A session outlives
      the membership that justified it, so removal has to end access on the next request
      rather than only hide a name from a list.
- [x] `credentials_for_email` skips a deleted user. It runs before there is a session or an
      organisation scope, so nothing else would have caught it.
- [x] `organization_for_number` skips a deleted organisation. Its numbers stay registered and
      the carrier goes on dialling them; without this a caller reaches an organisation that
      no longer exists.
- [x] `organisations_for_user` filters both — a deleted membership means they left, a deleted
      organisation means there is nothing to go back to.
- [x] `memberships_keep_an_owner` counts only live memberships, or soft-deleting the last
      owner would pass by being counted as its own replacement.
- [x] `removeMember` is a soft delete. The row is what a call log and an audit question point
      back at, and hard-deleting it made "who published version 4" unanswerable the moment
      that person left.
- [x] Six functions recreated for the rename, generated from `pg_get_functiondef` so nothing
      drifts from what was deployed. Partial indexes rebuilt against the new name.
- [x] Four adversarial tests in `rls.test.ts`, seeded as the operator because `ansa_app`
      cannot insert a user — that grant is itself part of the isolation — and asserted as
      `ansa_app`, which is the role whose view is under test.

**Still open.**

- [ ] Nothing in the console soft-deletes an organisation or a user yet. The column and every
      read are ready; the buttons are not.
- [ ] A deleted organisation's calls, tools and events are untouched. That is deliberate for
      now — they are records — but "delete an organisation" as a product action needs a
      decision about them, and retention already hard-deletes the audio.

### Knowledge base — decided shape, not built

Sources belong to the **organisation**, and an agent selects from them. Exactly the tools
registry pattern: one registry per organisation, per-agent enablement through a join table,
so a second agent reuses what the first already ingested rather than uploading it again.
`agent_tools` is the model to copy.

**Built 2026-08-15/16.** Storage (migration 0034), retrieval through `search_knowledge_base`
in the one dispatch path, grounded-only answering, ingestion endpoints and the tab.

- [x] Four tables, RLS forced, append-only enforced as a *grant* on `knowledge_retrievals`
      rather than a convention. `agent_knowledge_sources` is `agent_tools`' shape exactly.
- [x] `GET|POST /knowledge`, `GET|PUT /knowledge/{id}[/units]`, `DELETE /knowledge/{id}`, and
      `PUT /agents/{agentId}/knowledge` beside the tool selection it mirrors.
- [x] **Splitting happens in the browser, in front of a preview.** A unit is what retrieval
      returns and therefore what a caller hears, so a bad split is somebody being read half a
      sentence — and the only cheap moment to notice is before it is saved. A parser behind
      an upload would make the first sighting a phone call. The API takes units already split
      for the same reason.
- [x] Three shapes, each with a real decision in it. A table row carries its column names
      into the body, because retrieval is full-text and a caller asks "when does Ikeja
      close", not for a cell reference. A document heading becomes the question and the
      passage the body, because "Cancellations" alone answers nothing and the passage without
      it loses the word the caller will say. A lone FAQ line is kept rather than dropped —
      it is still something somebody wrote down.
- [x] Creating a source does not give it to an agent. Writing a FAQ must not change what a
      live line says.
- [x] `apps/web` has a test runner for the first time, and eleven tests on the splitters.
      There were none, which was defensible for pages that compose server components and not
      for pure logic that decides what a caller is read.

**Still open.**

- [x] **Editing a source's units, in the console** (2026-08-16). Units are edited directly
      rather than round-tripped back to pasted text: what is stored is units, and re-deriving
      text so it could be re-split would let the splitter reshape pieces nobody touched — a
      document whose passages were adjusted by hand would revert on the next save. Add,
      remove and reorder, because position is the tie-break and the reading order.
- [x] The replace is guarded by `expectedUpdatedAt`, compared inside the same transaction as
      the write. Two people with the same page open is ordinary, and a source is shared by
      every agent using it, so a silent last-write-wins rewrites what a colleague just
      published to several live lines.
- [x] **The guard was decorative and a test caught it.** `setKnowledgeUnits` writes child
      rows and the 0031 trigger fires on `knowledge_sources`, so the parent stamp never
      moved — `expectedUpdatedAt` would have matched forever and both editors would have
      saved. It now touches the parent, and two db tests assert the stamp moves.
- [x] Saving an empty source is refused with a reason: retrieval matching nothing sounds
      exactly like the source having been deleted, and retiring it says so on purpose.
- [x] **Retrieval was broken for spoken questions, and testing it is what found out**
      (2026-08-16). It matched with `websearch_to_tsquery`, which ANDs every term: "what time
      does Ikeja close" became `time & ikeja & close` and found nothing, against a passage
      saying Ikeja closes at 5pm that never uses the word "time". A spoken question always
      carries words the answer does not, so on a call the agent would have said it had
      nothing on file for almost everything it held. Two of eight realistic phrasings matched.
      - Now an OR, which restores recall, paid for by a rule rather than a tuned number: a
        passage must share **two** of the question's terms, or all of them when a question has
        fewer, so "renewal" alone still retrieves. A rank threshold would have separated the
        cases in the sample it was fitted to and meant nothing elsewhere — `ts_rank` is not
        comparable across corpora, term overlap is.
      - **Pidgin works when it borrows the English content words**, which is what branch
        names, product names and times are. "When Ikeja dey close" retrieves.
      - Ranking is length-normalised. The default tied a six-word passage with a sixty-word
        one carrying the same fact, so the winner was whichever had been typed first. The
        passage is read aloud to somebody waiting; the short one is the better answer.
        `ts_rank_cd` was the other candidate and tied them too.
      - Seven tests over real phrasings, including the false positive that OR introduced
        ("can I insure my dog on this policy" matching a renewal passage on "policy" alone).
- [ ] **Still no real call.** What is now tested is that retrieval finds the right passage for
      questions people actually ask. What no test can tell us is whether an 8 kHz transcript
      of those questions still contains the words this depends on.
- [ ] `abeg how much I go pay` retrieves nothing, and is asserted as such. "Pay" and "premium"
      share no term, and no query rewriting fixes that — it needs the organisation writing it
      down as a FAQ pair, or embeddings. The test fails the day that changes, so it has to be
      a decision.
- [x] **The query is bounded in Postgres** (2026-08-16). The retrieval agent flagged that
      losing the dispatcher's three-second race abandons the promise while the query carries
      on holding a connection for a turn nobody is listening to — and a full-text scan over a
      large source is exactly the shape that runs long. An `AbortSignal` would not have fixed
      it: node-postgres cannot stop a statement in flight without a second connection issuing
      `pg_cancel_backend`. `searchKnowledge` sets `set local statement_timeout = '2500ms'`
      instead, scoped to the transaction `withOrganization` already opens so it cannot leak
      to the next borrower of a pooled connection. Deliberately under the tool ceiling: the
      search should be what gives up, so the caller hears the source's fallback rather than
      the dispatcher's apology. Verified against the database — it cancels, and the session
      default is untouched afterwards.
- [x] The mirrored `KnowledgeHit` is gone. It existed because `@ansa/db` is consumed from its
      build output and the orchestrator had to compile before the storage layer had ever been
      built; that stopped being true once 0034 landed, and the comment said to delete it then.

### The two flags the voice agent raised, closed (2026-08-16)

**Speaking rate is built** (migration 0035). Nullable on `agents`, bounded 0.7–1.2 — the
range ElevenLabs renders without artefacts, and outside it the voice does not sound fast, it
sounds broken. Null means the voice's own pace and is the default, which is **not** the same
as 1.0: sending nothing lets a voice cloned at its speaker's rhythm keep it, and pinning it
flattens that. The adapter omits `voice_settings` entirely when unset for exactly that
reason.

Saved by `PATCH /agents/{id}`, the path `bargeIn` takes, not by publishing. Which voice
answers is configuration a version should capture; the pace it reads at is a dial somebody
turns while listening. The Voice tab's "not stored" row is now a control.

`number()` is new in the request-schema DSL — there was only `integer`, and a rate is
fractional. Separate rather than a flag on `integer`, because the two refuse different
things and a reader should be able to tell which a field is at a glance.

- [x] **Versioned after all, and it fixed the screen at the same time** (0037). Leaving it on
      `PATCH` gave the Voice tab a "save rate" button and no way to save the voice beside it,
      because the voice is published — one panel, two save paths, and the more obvious button
      saved the thing nobody came to change. Moving the rate into the publish gives one button
      and puts it in `agent_prompt_versions`, so "what did this call sound like" is answerable
      from the version the call recorded. `PATCH` still accepts it, the way it accepts
      `voiceId`.

### Nested forms, which never worked (2026-08-16)

Every tab panel renders inside `<form id="agent-publish">`, and `agent-workspace.tsx` says
why nothing inside a panel may be a `<form>`: nesting one is invalid HTML, the parser drops
the inner tag, and its submit button posts the outer form instead. Overview and Versions
follow that rule by dispatching their Server Action directly.

The panels added this session did not. Voice had one nested form, Knowledge four, the tool
form three — so "save rate", "save selection", "retire", "store source", "save changes" and
the rest were publishing the agent configuration rather than doing what they said.

- [x] All of them dispatch now, building their own `FormData` and calling the action, which
      is the pattern the file already described.
- [x] The voice has a save button, attached to the publish form by `form=` rather than by
      nesting — the failure the user actually hit, and the visible half of the same bug.

**Per-agent endpointing is deliberately not built.** The voice agent flagged
wait-before-answering as "arguably genuinely per-agent", and it is arguable — a form-heavy
agent reading NINs back wants a longer silence than a chatty one. It stays deployment-wide
anyway:

- It is a turn-taking threshold, and turn-taking is where this product is most easily made
  worse. Set too low the agent talks over people; too high it feels dead. Neither failure
  looks like a bad setting on a screen, both look like a bad agent on a call.
- No organisation has asked. The only evidence for it is a mockup.
- There is no way to judge a value without hearing it, and nothing in the console lets
  somebody hear one. A knob you cannot evaluate is a knob that gets set once and blamed
  later.

Worth revisiting when a real call gives a reason. Recorded here so it is a decision rather
than an omission.

### `query` where `mutate` was required — swept, and now guarded (2026-08-16)

Fixing `updateAgent` and `archiveAgent` treated one instance of a mistake that had already
been made twice. `organization-scope.ts` warns about it in its own doc comment and names the
shape — "a handler that reports success for a row it did not touch" — because the
adversarial API test caught it once already, in a member update that answered 200 while
changing nothing.

A sweep of `packages/db/src` for `scope.query` holding an `update`/`delete … returning`
found one more:

- [x] `renameOrganization` — the length check was always false, so renaming reported success
      whatever it touched. Now `mutate`, and it filters `deleted_at` while it is there, since
      the organizations policy does not.

- [x] **A test now refuses the pattern.** It scans the package's own source for
      `scope.query` calls whose SQL updates or deletes with a `returning` clause. Twice is a
      mistake; three times is a missing test.
      - Verified by planting a file that offends and watching it fail by name, then removing
        it. A guard nobody has seen fail is a guess.
      - It asserts how many files it read, because a scan that finds nothing passes forever.
      - The two methods share a signature on purpose — `mutate` just unwraps the pair — so
        nothing in the type system can tell them apart. The difference lives in the SQL
        string, which is why this is a source scan and not a type.

Also checked: the two `from agents` reads with no `deleted_at` filter are `listAgents` and
`findAgent`, and both are deliberate. A call log needs a retired agent's name, and the API
says so where somebody choosing an agent would read it.

### The event sweeper's DNS failures (2026-08-16)

Diagnosed rather than fixed, because there was nothing wrong with the resolution. All four
database URLs share one hostname, `MIGRATION_DIRECT_URL` was working throughout, and the
host resolves consistently now — the laptop lost its network for four minutes. The eighteen
`getaddrinfo ENOTFOUND` lines stopped on their own at 07:25 and nothing has failed since.

The sweep is inside a `catch` precisely so an outage is not a restart, and that worked. What
did not work was being able to tell:

- [x] **It now says when it comes back.** The log ended on an error and stayed there, so "is
      it still broken" could only be answered by comparing the last timestamp against the
      clock — which is how this was actually diagnosed, and is not a thing anyone should have
      to do. Recovery logs once, with how many sweeps it was out for.
- [x] **Repeats are collapsed.** Eighteen identical lines in four minutes; an hour would be
      two hundred and forty, with the next real failure somewhere in the middle. The first
      is logged in full and repeats of the same reason are counted. A *different* reason logs
      again, because a second failure arriving during the first is news rather than a repeat.
- [x] Five tests, including that a healthy sweeper stays silent — recovery is only news
      after a failure. Verified against a running API: twenty seconds, zero sweep lines.

Nothing was wrong with the connection handling, and nothing about it changed.

### Knowledge on the call path, finished (2026-08-16)

The tool was registered and the grounding instruction composed, but the loop was not closed:
nothing recorded which sources answered. `recordKnowledgeRetrieval` existed and had no
caller, so `knowledge_retrievals` was empty and the Knowledge tab's "used, 7d" read zero for
every source — a number that looks like measurement and is really "nothing wrote it". That
count is the only signal an organisation gets about whether a FAQ earns its place.

- [x] Wired through the dispatcher's `onResult`, deliberately not awaited: it runs on the
      turn a caller is waiting through, and a bookkeeping row must never cost them a second
      or fail their question. A failure logs and is dropped.
- [x] Counted once per source per retrieval, not once per passage — three passages from one
      source answering one question is one use of that source.
- [x] **The column was a `uuid` nothing on the call path could supply** (0036).
      `CallId` here is the carrier's `CallSid`, a string like `CA9f3…`; the internal uuid is
      generated inside the recorder and never handed back. The first write would have raised
      `invalid input syntax for type uuid`, been swallowed by the catch that keeps bookkeeping
      off a caller's turn, and left the column empty for good. Typecheck passed throughout —
      both are strings. Renamed to `carrier_call_id` as well as retyped, because `call_id`
      sitting beside a uuid `calls.id` is what caused the mistake; it now joins to
      `calls.carrier_call_id`.
- [x] Four tests on the counting, using Twilio's actual id shape rather than a uuid.

**Still open, and unchanged: no real call.** Retrieval is proved against questions people
would ask, and the recording is proved against the ids a call actually carries. What neither
proves is whether an 8 kHz transcript of those questions still contains the words retrieval
depends on.

### The Voice tab, finished (2026-08-16)

- [x] The picker holds only the account's voices. The "only what this account holds" switch
      was the wrong question to ask anybody: every other voice must be added inside
      ElevenLabs first, so listing them meant a hundred rows that answer a click with
      instructions and twenty-two real choices scattered among them. The library is one line
      under the list saying how many it holds and where to add them.
- [x] Selection is a radio mark, not a background tint — the row read as "chosen" only if you
      already knew which highlight meant what.
- [x] The rate is a slider beside the voice and the sample plays at it, live while dragging.
      A text box asking for 0.7–1.2 asks for a judgement nobody can make from digits.
      It uses `playbackRate`, not re-synthesis, and says so: ElevenLabs' `speed` changes how
      audio is generated, this changes how it is played. Enough for "too slow to bear", not
      for timbre. A synthesis endpoint would put the speech key and its per-character bill
      behind a button anyone with `config:read` can hold down.
- [x] A skeleton while the account is read. Two ElevenLabs calls and a plan lookup take a
      second or two cold, and one line of text for that long reads as a page that failed. The
      blocks mirror what replaces them so nothing jumps, with `aria-busy` and a live region
      because a shimmering rectangle is not an announcement.
- [x] The Listening panel is gone from the screen. Every row said "set elsewhere", which is
      furniture on the page somebody opens to change the voice. **The settings are untouched**
      — deliberately, and they stay deployment-level: turn-taking is tuned by us until a call
      gives a reason to expose it, because the goal is a conversation that is smooth by
      default rather than one an operator has to tune into being smooth.

### Save and publish are two different acts (2026-08-16)

Reported as "the version changed without publish yet". Changing the voice writes nothing —
verified in the browser, the server still reported the same version. What cut the version was
the **"Save voice and rate"** button, and its note in the history said so.

The defect was mine, from earlier the same day. There is one endpoint and one configuration
document, so that button never saved the voice: it published every tab, live on the next
call, under a label that said Save. "Save identity" and "Save instructions" did the same.
My first fix accepted that and gave each button an automatic note, which is a tidy answer to
a question nobody asked.

- [x] The three buttons are gone. Publish, through its dialog, is the only control that
      writes, so the note is unconditionally required again and the `intent` machinery that
      carried the exception is removed with it.

**The model the console should have**, agreed with the operator: a tab's Save writes to the
database and changes nothing about a live call; Publish makes the saved state take effect;
Discard throws the unpublished work away. Two reverts, both kept, because they answer
different questions — *throw away what I have not published* and *put yesterday's published
version back*.

**Where the line goes: anything belonging to one agent is staged, anything shared across the
organisation is immediate.** Staged — the publish form (name, voice, rate, greeting, persona,
instructions, keyterms, hours, escalation), the captured-field form, the agent's tool
selection, its knowledge selection, and its behaviour flags. Immediate — the tool registry
itself and the knowledge sources, because both are the organisation's and shared: writing a
FAQ or correcting an endpoint URL must not require republishing every agent. That is also how
they behave today, so nothing changes for them.

- [x] `agent_config_drafts`: one row per agent, the document as `jsonb`, with `organization_id`
      and RLS. Deliberately not mirrored columns — two copies of a twelve-field shape kept in
      step by hand is the failure 0031's own comment warns about, and the draft is compared
      against the live document by `diffConfigurations`, which already exists.
- [x] The call path does not change. `agent_config_for_number` keeps reading the live columns,
      so a half-finished draft cannot reach a phone line by construction rather than by
      remembering. **An isolation test must prove exactly that** before the console can save
      into a draft.
- [x] `save_agent_draft`, `discard_agent_draft`, and publishing deleting the draft
      rather than its arguments. Publishing deletes the draft in the same transaction.
- [x] `GET`/`PUT`/`DELETE /config/draft`, on `config` rather than `agents` because a draft is
      a configuration document. Which agent it belongs to is resolved by
      `app.live_agent_for_organization`, the same pick publishing makes, so a publish cannot
      consume a draft belonging to a different agent than it published to.
- [x] The console. Save, Publish and Discard sit in the header, and Save is **also** on each
      tab that has fields, because otherwise you scroll back up to save what you just typed.
      The per-tab ones say "Save changes", not "Save voice" — there is one endpoint and one
      document, so no button can save the voice without the greeting, and naming a section
      would be the old lie in a smaller font. A sentence beside each says what it does. What
      made the removed buttons a defect was never where they sat: it was that they published.
- [x] The form's own `action` is save, and Publish overrides it with `formAction` from inside
      the dialog. Pressing return in a text field submits through the form's action, so the
      default had to be the harmless one.
- [x] The form is keyed on which configuration it is showing. Nearly every field is an
      uncontrolled input reading `defaultValue`, and React does not reset those on re-render:
      without the key, Discard removed the draft, refreshed the page, and left the discarded
      text sitting in the boxes.
- [x] Restore loads into the draft rather than publishing. It returns the draft, not a
      version, and the confirmation says so. The provenance the old rollback used to write
      into the note travels as `restored_from` and the publish dialog offers it.

**A call reads published configuration and nothing else, and two guards now say so rather
than the design implying it.** `packages/db/src/drafts.test.ts` asks Postgres which `app.*`
functions mention `agent_config_drafts` and fails on any except the three that manage it —
which covers the `agent_config_for_*` a call runs today *and* whichever one somebody adds next
year, without them having to remember this file. `apps/api/src/tenancy/call-path.test.ts` scans
`telephony`, `orchestrator`, `tenancy`, `outbound` and `conversation` for the draft helpers or
the raw table name, because `scope.query` takes SQL and a hand-written join would be invisible
to a scan that only knew function names. Both were checked by breaking them on purpose: the
first named `publish_agent_config` when it was dropped from the allow-list, the second named
`agent-registry.ts` when a draft import was planted in it. Rule 4 in `CLAUDE.md` now states
the property, so a future session inherits it instead of rediscovering it.

**Verified against the running app**, not only in tests: saved a draft, watched the live
greeting stay `NULL` at version 6 in Postgres while the console showed the draft, discarded
it, and watched the fields reset. Two defects the browser found that the tests had not:
`updated_at` came back as a `Date` and the API's schema layer answered 500 on an otherwise
successful save, and the uncontrolled fields kept discarded text. Both fixed, and the
timestamp one now has the assertion the db test was missing.

- [x] The captured-field form, the tool selection and the knowledge selection are staged too
      (0040). **Sections are independent, and null means "not staged"** — four editors are
      saved at four different moments, so a tool save must not republish a half-written
      greeting and a greeting save must not blank a tool selection nobody touched. An empty
      array is a real value: an agent deliberately reaching no tools. `config` became nullable
      for the same reason, because a draft holding only a tool selection is now ordinary and
      filling the rest from the live row would stage a stale copy.
- [x] Publishing applies whatever is staged, in one transaction and in an order that matters:
      the form onto the agent row **before** `publish_agent_config`, because that function
      snapshots the row — applying it after would publish the form and record the old one, and
      a call pointing at that version would describe an agent that never existed. The two
      selections after, since the snapshot does not cover their join tables.
- [x] The tabs read a `staged` agent — live with the staged sections laid over it — computed
      once in the workspace rather than threaded as three props. Data captured, Tools and
      Knowledge already read their selection off `agent`, so they show staged values without
      knowing drafts exist, and a fourth section later is one line here.
- [x] The behaviour flags (`setAgentBehaviour` — barge-in, answering-machine detection) are
      staged too (0041), so nothing per-agent writes straight to live any more.
      **Two sections, not one**, though they are drawn on one panel: each toggle sends only
      the switch that moved, so a single section would have to carry the other flag's value
      as the page last read it — the stale copy 0040 rules out for `config`, and a second tab
      or a publish in between would silently put the other switch back. Two nullable booleans
      reuse the `coalesce` already in `stage_agent_draft_selection`; null is not staged and
      `false` is a staged "off", exactly as `[]` is a real selection.
      Applied *after* `publish_agent_config`, with the two selections rather than with the
      form: `agent_prompt_versions` has no column for either flag and the snapshot does not
      mention them, checked against the table rather than assumed. `PATCH /agents/{id}` no
      longer accepts them, and `AgentEdit` no longer carries them, so the publish path is the
      only way either flag reaches a call. What that PATCH still does accept is worth
      knowing: `greeting`, `persona`, `instructions`, `voiceId` and `speakingRate` are all
      publish-form fields it writes straight to the live agent row. Nothing in the console
      calls it that way, but it is the same hole in a different wall.

### The two holes the drafts slice left, closed (2026-08-16)

- [x] **`PATCH /agents/{agentId}` no longer writes what a caller hears.** It still accepted
      `name`, `persona`, `greeting`, `instructions`, `voiceId` and `speakingRate` and wrote
      them straight to the live agent row — the same defect the draft closes, in a wall nobody
      was looking at. Nothing called it with any of them, in the console or in `tools/`, so
      they are removed rather than deprecated: the schema layer now answers 422 naming the
      field, which is the right answer because it used to work and "it stopped" needs to be
      loud. `dialledNumber` stays, deliberately — it is operator-level routing, it has no
      representation in the published document, and it is how a number reaches an agent at
      all.
- [x] **Staging no longer throws away what somebody is typing.** The form was keyed on the
      draft's timestamp, which every section shares, so flipping a behaviour switch remounted
      the Voice and Routing panels and lost unsaved text on them. Each panel is now keyed on
      *its own* content — the configuration document, or the one selection it edits — so a
      panel resets when what it shows changes and stays put when somebody else's does. Keyed
      on the value rather than a timestamp, which also means an ordinary save that stores the
      text unchanged no longer remounts anything.
- [x] That exposed a second one, which the browser found and the keys could not fix: the
      behaviour switches are optimistic local state seeded once, so discarding a draft removed
      the staged flag, the page refreshed with the live value, and the switch carried on
      showing the flip that had just been thrown away. They now take the server's answer when
      it differs from the one they were seeded with, adjusted during render rather than in an
      effect — an effect paints the stale value first, and the answer can arrive after
      somebody has flipped the switch again.

- [x] `drafts.test.ts` was not idempotent, which is how both of the above were nearly missed.
      Several of its tests publish, so they change the fixture's greeting and switches;
      `afterAll` deletes the organisations but a run interrupted before it never gets there,
      and `on conflict do nothing` then inherited the published values. The file passed alone,
      failed in a full run, and failed *differently* each time — which reads as database
      flakiness and is not. `beforeAll` now deletes before it inserts and sets every column a
      test asserts a starting value for, and two tests that asserted the fixture's starting
      value now assert the invariant they are actually about.

Verified in the browser: typed unsaved text on the Conversation panel survives a switch flip,
the switch follows the server back to `false` on discard, and Postgres showed the flag staged
`true` with the live column still `false` at version 6 throughout.

### Validation errors that read as instructions (2026-08-16)

Reported from a screenshot of the tool form, which said:

> body.http.1.name must be at least 3 characters. body.http.1.description must be at least 1
> characters. body.http.1.url must be at least 1 characters. …

Three faults in one line, and it reached every 422 in the console rather than just this form.

- [x] **"1 characters"** was wrong about the grammar and about the problem, and it was the
      commonest message there is: `minLength: 1` is how every required text field in this API
      is written. An empty box is a missing answer, not a value of insufficient length, so it
      says `is required`. Other counts pluralise.
- [x] **The path is how the API points at a field, not how a person refers to one.** `body.`,
      `query.` and `path.` are dropped, array indices become 1-based (`http.1` → `Http #2`,
      because people do not count from zero), and camelCase is spaced. Deliberately not a
      lookup table of pretty labels: one would read better and rot silently the first time a
      field was renamed, and this has to work for endpoints added later.
- [x] **Four fragments run together read as one long fault.** Each is a sentence now.
- [x] The screen was headed "Add a tool" and said "Http #2", because `PUT /tools` validates
      the whole registry. `failureMessage` takes `{ within }`, and the tool action passes the
      index it wrote to — so the index is dropped for *that* tool and kept for any other,
      which is exactly when somebody needs to be told which one.

Verified in the browser against the same action that produced the screenshot: `Name must be at
least 3 characters. Description is required. Url is required. Speech template is required.
Speech fallback is required.`

The helpers live in `apps/web/src/lib/api/problem-text.ts` rather than in `server.ts`, because
that module reaches for `next/headers` at import time and cannot be loaded in a test.

**Still open on this slice.** `capturedField` moved from `agents.controller.ts` to
`api/schemas.ts` because two controllers now need it — worth knowing it is shared before
editing it.

One more, smaller: `revalidatePath("/agents", "layout")` re-runs every fetch the agent page
makes, so Save and Discard take several seconds to show. Correct, but slow enough to look
broken; the toast is the only immediate feedback.

Open question not yet settled: business hours are stored on `organizations` (0027) but are
edited on the publish form, so they are org-level data inside an agent-level draft. The draft
covers the publish form as a unit because that is the version boundary; whether hours should
move to the agent is a separate question, and is the same one behind "Routing & hours edits
hours as though they were the agent's" further up this file.

### The call that is still owed

`packages/db/seeds/dev-organization.mjs` had rotted — it wrote `organizations.dialled_number`,
a column 0026 dropped when the organisation stopped being the agent. Nothing imports the
seed, so the first symptom was a working tunnel, a working carrier and no way to make a
call reach anything. Rewritten: it creates the organisation, registers the number as the
operator, and creates the agent with a form. Verified idempotent, and
`agent_config_for_number` returns the form including the pattern.

The dev agent is armed with the probe form: `callerName` (name, readback), `policyNumber`
(reference, `PM\d{7}`, readback) and `contactEmail` (email, spellback). Which number that
is stays out of the repo — it is `SEED_DIALLED_NUMBER`, for the same reason the seed reads
it from the environment. To disarm, clear the form on the agent holding that number; do it
through `PUT /agents/:agentId/fields` rather than with SQL, so the change is versioned.

What to listen for, in order of what is actually in doubt:

1. **Does it ask at all**, in the operator's wording rather than the model's paraphrase.
2. **`PM8592625` accepted, five bare digits re-asked.** The pattern path has never run
   against a real transcript. Say the wrong-shaped number *clearly* — the interesting case
   is being heard perfectly and rejected anyway.
3. **Three wrong shapes reaches a person**, or says something honest if there is nobody.
4. **The email.** The one genuinely in doubt. 8 kHz destroys the consonant contrasts an
   address is made of — m/n, s/f — and no readback logic repairs a channel that never
   carried the distinction. If it fails, the answer is probably that email is a keypad or
   an SMS field and not a spoken one. That is a finding, not a defeat.

**Still open.**

- [x] `instructions` on `POST /agents` and `PATCH /agents/:id` (2026-08-15). A template's
      house rules now ride along on the create, so an agent is complete when the wizard
      returns and nothing has to be pasted in afterwards. Bounded at 2000 to match what
      `config.publish` already accepted, so a template can travel either route. The warning
      on the create page is gone, replaced by the field itself and a line saying it can be
      edited later. Verified against the database: create, patch and the call path all
      carry it.
- [ ] The Routing & hours tab still edits hours as though they were the agent's. They are
      the organisation's now; that tab needs to move to an organisation settings screen.
- [ ] `conversation-preview.tsx` and `field-builder.tsx` duplicate the sample values and
      read-back wording. One module.
- [ ] `config.*` is still organisation-scoped and resolves the oldest live agent.

- [ ] Agent templates to pick from when creating the first one, and the create form itself.
- [ ] Organisation-level general config that an agent's own settings override. Today an
      agent carries every value outright and there is no organisation default beneath it.
- [ ] `config.*` is still organisation-scoped and resolves the oldest live agent. Three
      places share that rule so they move together.

- [ ] Capture *enforcement* is still the model's job on this path. The prompt tells it to
      confirm before using a value, and risk tiers stop a write-tier tool firing — but
      nothing yet tracks per-field state on the call: `attempts` does not count, `pattern`
      does not reject and re-ask, and `redact` does not hide anything in a transcript. Those
      need a capture state machine in the orchestrator holding a value per field with a
      confirmed flag. That is the next real slice, and until it lands those three settings
      describe an intention rather than a behaviour.

- [ ] `config.*` reads and writes the tenant's oldest live agent via
      `app.tenant_config_for_id`. Correct with one agent, a coin toss with two. **This is
      the blocker on creating a second agent through the UI** — the wizard at `/agents/new`
      and the workspace at `/agents/[agentId]` both publish through `config.publish`, so
      today they would edit whichever agent that function picks. Make them agent-scoped
      before wiring a create form to `POST /agents`.
- [ ] Only `GET /agents` is exercised over HTTP. The mutations are typechecked, schema-
      checked by the drift test and unit-covered, but no test drives them through the
      pipeline — the constraint behaviour underneath them was proven directly in psql.
- [ ] Readiness is organisation-wide, so a failing check pauses every agent. Honest today
      (none of them can answer) and wrong once checks become per agent.

## Voice remediation (2026-08-20)

Following `docs/ansa-conversational-fixes.md` and `docs/ansa-agent-prompt.md`. Eight
phases, one commit each, and a real phone call between every one. The audit that precedes
them is in the Phase 1 commit message.

- [x] **Phase 1 — Flux is the turn detector** (`35708e5`). Silence-threshold endpointing is
      gone rather than flagged off. `LISTEN_PROVIDER` and `LISTEN_TURNS` were deleted, so a
      deployment can no longer configure its way back to the bug; `LISTEN_WORDS` still
      chooses who transcribes, which is the axis that has a real answer either way. The
      session reconnects with backoff and buffers audio across the gap. `eot_timeout_ms`
      went 3000 -> 4000 because Nigerian callers read reference numbers aloud.
      *Correction to the audit: `TURN_DETECTION` and `VAD_*` are not dead config — they
      still drive the OpenAI transcriber's buffer commits.*
- [x] **Phase 2 — barge-in settles after the stop** (`4b072c4`). The backchannel guard
      could never fire, because `stopSpeaking` nulls the turn before the transcript that
      would clear it arrives. The torn-down turn is now held for a second with what was
      heard and what was not; a backchannel, a bare particle or our own echo resumes the
      remainder, anything with content commits the interruption and marks it with an
      em-dash. Interim transcripts cancel the recovery clock — without that, a caller who
      cuts in and talks for three seconds gets talked over by the recovery itself.
- [x] **Phase 3a — the fast model, the warm connection, and the numbers**. Split from
      Phase 3: sentence-boundary chunking already existed, and Cartesia is 3b.
      - `eleven_flash_v2_5` (~75ms) replaces `eleven_turbo_v2_5` (~250-300ms). Flash reads
        numbers less gracefully, which costs nothing here because `@ansa/normalizer` runs
        first and TTS never sees a digit.
      - Voice settings — stability, similarity boost, style, speaker boost, speed — are
        deployment configuration, merged over the voice's own stored settings. An unset
        knob is absent from the request rather than sent as a default.
      - **The brief is wrong about `optimize_streaming_latency`.** ElevenLabs deprecated
        it; it is deliberately not sent. Verified against the current docs, not recalled.
      - Warm-up: `LlmProvider.warmUp(system)` fires as the greeting starts. The real system
        prompt and not a stub, because the connection is only half of it — the prefix every
        turn resends goes into the vendor's prompt cache too.
      - Stage timings now reach the `latencies` table, which has existed since migration
        0001 with nothing writing to it. `GET /api/v1/calls/latency` returns p50/p90/p95
        per stage over a range, never an average, and refuses a range over 31 days rather
        than clamping it. `tts_first_byte` and `llm_first_token` carry the vendor's name,
        which is what makes the Phase 3b A/B readable.
- [x] **Phase 3b — Cartesia Sonic behind `TtsProvider`**. `TTS_PROVIDER=elevenlabs|cartesia`,
      validated at boot; an unknown value and a cartesia with no key both refuse to start,
      rather than falling back to the default and reporting a clean A/B of one vendor
      against itself. Everything downstream holds a `TtsProvider` and cannot tell which it
      has, so the switch is configuration rather than code.
      - **Streaming, so `/tts/sse` and not `/tts/bytes`** — the bytes endpoint returns a
        whole utterance, which R4.2.3 treats as disqualifying rather than merely slow.
      - **The brief is dated on the model.** "Sonic" is not an id and `sonic-2` and
        `sonic-turbo` are gone; the line is `sonic-3.5`, `sonic-3` and `sonic-latest`.
        Pinned to `sonic-3` — a floating tag moves what is being measured underneath the
        measurement. The `Cartesia-Version` header is pinned for the same reason.
      - `container: "raw"`, `encoding: "pcm_mulaw"`, `sample_rate: 8000`: native telephony
        audio, no transcoding hop either way.
      - `VendorSynthesisStream` is now shared by both adapters. Not tidiness — two adapters
        being compared must not differ in how they stop, or the A/B measures the adapters.
      - The readiness check no longer validates a Cartesia voice against an ElevenLabs
        account. It reports `unchecked` and says why, because both ids are uuids and a
        confident wrong answer is worse than none.

**What a production A/B still needs, and this is not it.** Voice is published per agent and
ids are per-vendor, so flipping `TTS_PROVIDER` means republishing every agent's voice — the
switch is per deployment, not per call, and the two sides cannot run concurrently on the
same traffic. To split live traffic properly an agent needs a voice id *per vendor*, and
there is no Cartesia voice catalogue here for the console to pick one from (Cartesia has a
`/voices` endpoint; nothing reads it yet). What works today is a week on one, a week on the
other, compared through `GET /api/v1/calls/latency` — `tts_first_byte` carries the vendor
name, so the two are separable even in mixed data.
- [x] **Phase 4a — where the call is**. Split from Phase 4, which turned out to be roughly
      40% already built, one item in direct conflict with a load-bearing rule, and two
      items belonging to later phases.
      - `conversation/situation.ts` — part of day, WAT clock, open/closed, minutes to
        closing, how long the call has run, turns that went nowhere, whether a person has
        been offered. Pure: `now` is a parameter, no I/O, no clock lookup of its own.
      - Rendered as its own block beside `renderFacts`, and **empty whenever nothing is
        worth saying** — which is most turns. There is deliberately no "the line is open"
        line: open is the default the prompt is already written against, so saying it every
        turn is prompt budget spent on an assumption. A line means the default is wrong.
      - `EscalationWatch.failedTurns()` is now readable. The hard transfer at three stays
        exactly as it was; showing the count lets the agent offer a person itself at two,
        which lands better than a transfer arriving mid-sentence.
      - `businessHours` is **required and nullable** on `OrchestratorDeps`, not optional —
        the same reasoning as `organizationId`. An optional field here is a wire a
        construction site can forget, and the symptom is not a compile error but an agent
        that quietly never knows the time.

**What was already there, and is better than the brief describes.** `slots: {value,
confirmed}` is `captured: ReadonlyMap<string, Fact>` — four-level status, evidence sources,
correction history. `intent + confidence` is `intent: Fact`. The StateBlockRenderer is
`renderFacts`, and it has run every turn since §10 landed.

**The brief's `record_slot(name, value, confirmed)` tool was not built, and should not be.**
`Observation` in `call-facts.ts` has no arm in which an identifier or a captured field takes
`source: "model"` — refused by the type system and again at runtime, because a tool call
arrives as parsed JSON where no type was checked. That tool would let the model assert
`confirmed: true` on a policy number, which is the single thing the module exists to
prevent. Slot filling already happens from evidence: STT agreement, spelling, the keypad,
caller confirmation, a system of record.

**`toolCalls` in the state block was not built either.** `modelMessage(outcome)` already
puts every tool result into the conversation verbatim, so a block copy would be a second
source of truth for the same fact.

- [x] **Phase 4b — who this caller is to us**. `readCallerHistory` runs once as the call
      connects, while the greeting plays, and is **never awaited**. The orchestrator holds
      a getter rather than a promise — a promise invites an `await`, and an `await` there
      puts a database round trip on the turn the caller is waiting through. Null covers a
      withheld number, no database, a read still running and a read that failed; the
      correct behaviour is identical in all four, so the block simply says nothing.
      - Migration 0043 indexes `calls (organization_id, caller, created_at desc)` where the
        caller is not null. Nulls are excluded because a withheld number is not an identity
        — without the partial predicate, a caller with no CLI would be told they had rung
        eleven times this week because ten strangers had.
      - **`priorIssueUnresolved` is `lastCallHandedOver`, and the rename is the point.**
        Nothing in the schema knows whether an issue was resolved: `end_reason` on an
        inbound call is the media stream's close reason, written whether or not a transfer
        happened. What is recorded is the `escalated to a human` event. A handover is a
        fact; "unresolved" is a guess, and an agent told an issue is unresolved will invent
        the issue.
      - Three calls in a week routes to a person without trying again. Three contacts means
        the process failed, not the caller.
      - `packages/db/src/caller-history.test.ts` drives it against the real database,
        including the same number calling two organisations — the row that would surface if
        RLS were not doing its job.
- [ ] Phase 5 — emotional read appended after the spoken text, zero latency cost
- [ ] Phase 6 — pools instead of fixed artifacts (greetings, fillers, backchannels)
- [ ] Phase 7 — outbound: AMD, DNC as a dial-time gate, consent basis, calling windows
- [ ] Phase 8 — dialogue policy layer and the output guard

**Awaiting a real phone call:** phases 1, 2, 3a and 3b. None of them is done until one is
made. 3b additionally needs a Cartesia key and a Cartesia voice id republished on the agent
before it can be heard at all.

**Left deliberately for later.** `TRANSCRIPTION_MODEL` is set three ways —
`env.ts` defaults to `gpt-4o-transcribe`, `.env` agrees, and `.env.example` says
`gpt-4o-mini-transcribe` and claims ~120ms faster. One of those is wrong and it is worth
measuring rather than guessing.

## Session discipline

- Update this file before you stop working. Check boxes, note what broke.
- One slice at a time. Do not start the next until the current one's "done when" is true.
- Push to remote at the end of every session.
