# Ansa — Product Requirements

**Status:** v2 rebuild. Supersedes the insurance-only v1.
**Owner:** Vera
**Last updated:** 2026-08-03

---

## 1. What this is

Ansa is a multi-tenant SaaS that answers a company's inbound phone calls with an AI
agent that talks like a person, looks things up in that company's own systems, and hands
off to a human when it should.

**Horizontal across industries. Vertical on geography.**

Any company can use it — insurance, logistics, fintech, healthcare, retail, education.
But the product is built for Nigerian and West African callers first: Nigerian-accented
speech, Nigerian number formats, naira, local telephony realities, WhatsApp fallback.
That geographic focus is the moat. Voice quality is commoditizing; understanding a
Lagos caller reading a policy number over a bad line is not.

### 1.0 The name

**Ansa** — "answer," contracted, with West African phonetics. Two syllables, spells
itself, survives being said down a phone line, and carries no meaning it has to fight.

Not yet cleared. Before any spend on domains, logos or launch:

- [ ] CAC business-name search
- [ ] Nigerian Trademarks Registry search (class 9 and class 42)
- [ ] `.com` / `.ai` / `.ng` availability
- [ ] Collision check against the existing voice-AI field — it is crowded and funded
- [ ] **The phone-line test.** Synthesize "Thank you for calling Ansa" with the chosen
      Nigerian voice, play it over a real 8kHz call, and confirm two things: it survives
      the compression, and the chosen STT transcribes it correctly when a caller says it
      back. A name our own pipeline mishears is disqualifying no matter how it reads on a
      deck. Add "Ansa" to the default keyterm vocabulary either way (R4.1.3).

### 1.1 Why we are not competing head-on with Vapi / Retell / Bland / ElevenLabs Agents

Those platforms are well-funded, ship fast, and are excellent at American English. They
are also measurably weaker on African accents, indifferent to naira and Nigerian phone
number conventions, and priced in USD for a market that budgets in naira. We win where
they are weak and lose where they are strong. Every roadmap decision is checked against
this: *does this widen the geographic advantage, or does it drag us into a feature race
we cannot win?*

### 1.2 Explicit non-goals for v1

- Outbound calling and dialer campaigns
- Self-serve agent-builder UI (first 10 organizations are onboarded by hand)
- Billing and subscription management
- Connector marketplace
- Analytics dashboards beyond raw call inspection
- Non-English languages (Yoruba/Hausa/Igbo are Phase 3, and only after English is solid)
- Mobile apps

Nothing on this list gets built in v1 even if a prospect asks. Say yes to the customer,
put it in Phase 2.

---

## 2. Users

| User | What they need |
|---|---|
| **Caller** | To be understood the first time, get a real answer, and reach a human when the AI can't help. Does not know or care that it's AI. |
| **Organization admin** | To configure the agent's persona, knowledge, tools, escalation rules and business hours; to review calls that went badly. |
| **Human agent** | To receive a warm transfer with full context — who's calling, what they wanted, what the AI already tried. |
| **Us (platform)** | To debug any call turn-by-turn, six months later, without guessing. |

---

## 3. The call, end to end

```
Caller → Telephony (Twilio) → Media stream (WS)
      → VAD / endpointing
      → STT (provider-abstracted)
      → Orchestrator ── tool calls ──→ internal registry
      │                            └──→ organization external tools (HTTP / MCP)
      → LLM (Claude)
      → Response normalizer (numbers, currency, dates)
      → TTS (provider-abstracted)
      → Telephony → Caller

Every step above emits an event to the call event log.
```

---

## 4. Voice quality requirements

### 4.1 Listening — transcription and turn detection are separate concerns

Phone audio arrives as 8kHz μ-law. Most STT models are trained on 16kHz+ American
English. Nigerian-accented speech over a compressed line is the worst case for the
default stack, and it is our primary technical risk.

Understanding *what the caller said* and knowing *when the caller stopped talking* are
different problems with different best-in-class providers. The architecture treats them as
two interfaces so they can be sourced independently.

**Transcription:**
- **R4.1.1** Transcriber provider MUST be swappable behind an interface. No provider SDK
  types cross into orchestration code.
- **R4.1.2** Provider selection MUST be decided by measured accuracy on our own real-
  conversation Nigerian phone corpus (§9), not by vendor marketing. Candidates: Intron
  Sahara v2, Spitch, Deepgram (Nova-3 / Flux).
- **R4.1.3** Domain vocabulary boosting (keyterms) MUST be supported per organization —
  Nigerian names, place names, product names, insurer/bank names.
- **R4.1.4** Streaming with interim results is required. Batch STT is disqualifying.
- **R4.1.5** Word-level confidence MUST be carried through to the orchestrator so
  low-confidence turns can trigger a clarifying question rather than a wrong answer.

**Turn detection:**
- **R4.1.6** Turn detection MUST be a separate provider interface emitting speech-start,
  end-of-turn, optional eager-end-of-turn, and turn-resumed events. It MUST be sourceable
  from a different vendor than transcription, or from our own VAD as a fallback.
- **R4.1.7** The orchestrator correlates turn events and transcripts by timestamp and MUST
  NOT assume they arrive on the same connection.
- **R4.1.8** Where eager end-of-turn is used, a turn-resumed event MUST cancel all
  in-flight speculative work — LLM request, tool dispatch, TTS synthesis. Speculative
  execution without reliable cancellation is worse than no speculation.
- **R4.1.9** Cost is tracked per listen provider. Running two providers on the same audio
  doubles the STT bill; that tradeoff must be visible, not discovered on an invoice.

### 4.2 Text-to-speech

- **R4.2.1** Default voice MUST be Nigerian-accented. Options: ElevenLabs professional
  voice clone from a paid Nigerian voice actor (30+ min clean studio audio), or a
  provider with native Nigerian voices.
- **R4.2.2** Voice is a per-organization setting. Multiple Nigerian voices (male/female,
  warmer/more formal) available from day one of organization onboarding.
- **R4.2.3** Streaming TTS with time-to-first-byte under 300ms.
- **R4.2.4** TTS output format MUST match telephony natively (μ-law 8kHz) to avoid a
  transcoding hop.

### 4.3 Numbers — deterministic, never prompted

The LLM MUST NOT emit raw digits to TTS. A normalization layer sits between them and is
unit-tested independently.

**Outbound (spoken to caller):**
- Phone numbers grouped the Nigerian way, not digit-by-digit American style
- `₦250,000` → "two hundred and fifty thousand naira"
- `₦1.2m` → "one point two million naira"
- Policy/claim/order references: letters phonetically clarified where ambiguous
  (B/V/P, M/N, F/S), digits spoken singly
- Dates in the local convention; times with WAT assumed
- This layer also runs over **tool output**, not just LLM text

**Inbound (captured from caller):**
- **R4.3.1** Any number captured from speech MUST be read back for confirmation before
  it is used in a tool call. No exceptions, no confidence threshold that skips this.
- **R4.3.2** Readback uses the same normalizer, so the caller hears it the way they'd
  say it.
- **R4.3.3** DTMF (keypad) fallback offered after two failed capture attempts.

---

## 5. Tool calling

The heart of the product. A voice agent that can't touch the organization's systems is a
glorified IVR.

### 5.1 Internal tools (platform-owned, identical for every organization)

Deterministic, implemented by us, always available:

| Tool | Notes |
|---|---|
| `transfer_to_human` | Warm transfer with context payload; respects business hours |
| `create_ticket` | Fallback when no human available |
| `schedule_callback` | Caller picks a window |
| `send_sms` | Confirmations, links, reference numbers |
| `send_whatsapp` | Nigeria-specific; often better than SMS here |
| `verify_caller` | Identity check against organization-configured fields |
| `search_knowledge_base` | Organization's uploaded docs, retrieved |
| `end_call` | Graceful close with summary |

### 5.2 External tools (organization-configured)

Organizations point the agent at their own systems by **two routes into one registry**. This is
the central architectural decision of the tool layer.

- **Route A — HTTP connector.** Organization declares an endpoint, a JSON schema for arguments,
  an auth reference into the credential vault, a risk tier and a timeout. For the
  majority of Nigerian SMBs and mid-market companies, who have a REST API and no idea
  what MCP is. This is the default path and the one that will onboard most organizations.
- **Route B — MCP server.** Organization brings their own MCP server; we discover its tool
  list and register it. For technically sophisticated organizations, and the reason we never
  build N bespoke connectors.

**R5.2.0 — Both routes are adapters that populate the same tool registry and execute
through the same dispatch path.** Risk tiers, latency budgets, holding speech, credential
handling, SSRF guards, circuit breakers, result summarization and logging are implemented
**once** and apply identically to both. If a security control or a latency rule exists in
one route and not the other, that is a bug.

Adding a third route later (GraphQL, database-direct, webhook-push) must mean writing one
adapter, not a second dispatch path. If it doesn't, the abstraction is wrong.

**Security requirements (non-negotiable):**
- **R5.2.1** Per-organization encrypted credential vault. Credentials never in the agent
  config, never in logs, never in the LLM context.
- **R5.2.2** Egress allowlist per organization. SSRF protection: no private IP ranges, no
  link-local, no redirects to unlisted hosts.
- **R5.2.3** Hard timeout, retry policy and circuit breaker per tool. A failing organization
  endpoint must not degrade other organizations.
- **R5.2.4** Every tool invocation logged with args, result, latency, outcome —
  redacted per organization's PII rules.

### 5.3 Risk tiers — a required field on every registered tool

| Tier | Behaviour |
|---|---|
| `read` | Executes freely. Lookups, status checks, FAQ. |
| `write` | Requires explicit spoken confirmation + readback of the values before firing. |
| `irreversible` | Agent never executes. Transfers to a human. Payments, cancellations, policy changes. |

This generalizes the old "never process transactions" rule into something enforceable in
code rather than in a prompt. The tier is validated at tool-registration time; a tool
without one cannot be registered.

### 5.4 Latency budget — the voice-specific constraint

Chat tool calls can take five seconds. Voice tool calls cannot.

- **R5.4.1** Tool call ceiling: 1.5s soft, 3s hard. On hard timeout, the agent says so
  and offers an alternative — it never goes silent.
- **R5.4.2** Holding speech MUST begin playing the moment a tool call is dispatched, not
  after it returns. "Let me pull that up for you." This is a scheduler requirement in
  the orchestrator, not a prompt trick, and must be designed in from the first slice.
- **R5.4.3** Tool results are summarized before reaching TTS. Raw JSON is never spoken.
- **R5.4.4** Parallel tool calls where the LLM requests independent lookups.

### 5.5 End-to-end latency targets

| Metric | Target | Hard fail |
|---|---|---|
| Caller stops speaking → agent starts speaking | < 800ms p50 | > 1.5s p95 |
| Barge-in → agent audio stops | < 150ms | > 300ms |
| TTS time-to-first-byte | < 300ms | > 600ms |

---

## 6. Conversation behaviour

- **R6.1 Barge-in.** Caller interrupts, agent stops immediately, partial output is
  discarded from context so the agent doesn't reference something the caller never heard.
- **R6.2 No silence.** Any gap over 2s gets a filler or a check-in. Silence on a phone
  line reads as a dropped call.
- **R6.3 Short turns.** Voice, not chat. Two sentences max per turn unless reading back
  a list. Enforced in the system prompt and monitored in eval.
- **R6.4 Graceful failure.** Three failed comprehension attempts on the same intent →
  offer human transfer. Never loop.
- **R6.5 Escalation rules** are per-organization config: business hours (WAT), transfer
  destinations, out-of-hours behaviour (ticket vs callback), and named intents that
  always transfer regardless.
- **R6.6 Emotional handling.** Distress, anger, or a bereavement/claim context triggers a
  lower-friction path to a human. Detection is a classifier on the transcript, not a
  vibe in the prompt.
- **R6.7 Disclosure.** The agent identifies as an AI assistant if asked directly, always.

---

## 7. Multi-tenancy

Retrofitting isolation is the single most expensive mistake available to us. It is
designed in from schema v1.

- **R7.1** `organization_id` on every table, every log line, every event, every metric label.
- **R7.2** Isolation enforced at the data layer (Postgres RLS), not in application code.
  Application-layer-only isolation is treated as a security bug.
- **R7.3** Phone number → organization resolution at call ingress, before any other work.
- **R7.4** Per-organization rate limits and quotas so one organization cannot starve another.
- **R7.5** Organization config is versioned. A call records which config version served it, so
  a call from three weeks ago can be explained.

---

## 8. Observability — the call event log

This is not a "nice to have later." It is the debugger, the eval corpus, the analytics
source, and the evidence when a organization says the agent said something it didn't.

Every call produces an ordered, immutable event stream:

- Call lifecycle: ringing, answered, transferred, ended (with reason)
- Every audio segment (stored, retention per organization policy)
- Every interim and final transcript with confidence
- Every LLM request/response including the resolved system prompt and config version
- Every tool call: name, tier, args, result, latency, outcome
- Every latency measurement per stage
- Barge-in events
- Normalizer input/output pairs

**R8.1** Any call MUST be replayable turn-by-turn in a plain internal viewer from day
one. Not a customer-facing dashboard — a debugging tool for us.

---

## 9. Quality: the seed corpus and the review loop

Two mechanisms, and they do different jobs. The corpus **chooses** the stack. The review
loop **improves** it. Neither substitutes for the other.

### 9.1 Seed corpus — chooses the provider, built before the pipeline

The provider choice is the expensive-to-reverse decision. Prompts, confidence thresholds,
keyterm strategy, readback aggressiveness and the normalizer are all tuned against a
particular error profile. Discovering after eight slices that a different STT is 12 points
better on number strings means retuning all of it.

**The corpus is real conversation over real phone lines.** Scripted read-aloud measures
acoustic accent handling and nothing else. It misses hesitation, self-correction,
restarts, fillers, talking over the agent, trailing off, background noise, and
code-switching mid-sentence — and those are where a live system actually breaks. A stack
chosen on clean read-aloud audio will look 10–20 points better than it performs.

Two tiers, because they measure different failures:

**Tier 1 — Number strings, read aloud (still valid).** When a real caller gives a policy
number, they *do* read it aloud, one group at a time. So scripted capture is
representative here, and it's cheap. ~30 lines: policy numbers, phone numbers, naira
amounts, reference codes. The script is the ground truth — no transcription needed.

**Tier 2 — Real conversation calls.** This is the tier that decides the stack.

- **R9.1.1** ≥30 minutes of genuine two-sided conversational audio captured over an
  actual phone call, 8–10 Nigerian speakers, mixed language backgrounds and line quality.
- **R9.1.2** Preferred source, in order:
  1. **Anonymized recordings from a real Nigerian call centre** (a design partner). Real
     callers, real intents, real frustration. Requires consent and NDPR review, but this
     is the gold standard and worth asking for.
  2. **Wizard-of-Oz calls** — a human plays the agent following a service persona; the
     caller believes they are calling a real company. Produces authentic caller
     behaviour without an agent existing yet.
  3. Role-play calls where both parties know it's a test. Weakest, still far better than
     read-aloud.
- **R9.1.3** Every caller turn labelled by category: `number_string`, `intent_statement`,
  `disfluent`, `interruption`, `pidgin_mix`, `noisy`, `emotional`.
- **R9.1.4** Ground truth by **consensus adjudication**, not from-scratch transcription:
  run all candidate providers, accept segments where all agree, and human-transcribe only
  the disagreements. This cuts the manual work by roughly two-thirds and — critically —
  does not bias ground truth toward any single candidate. Never seed ground truth from one
  provider's output.
- **R9.1.5** Scoring: WER per category for prose; **exact match** for number strings, since
  a policy number that is 95% right is 100% wrong. Report disfluent and interruption
  categories separately — that gap is what read-aloud testing hides.
- **R9.1.6** **Turn-taking is scored separately from transcription.** WER measures the
  transcriber; it says nothing about the turn detector, and the two may come from different
  vendors. Against human-labelled turn boundaries on the same corpus, measure:
  - end-of-turn detection latency (p50 / p95) from true end of speech
  - **false end-of-turn rate** — agent would have cut the caller off mid-thought
  - **missed end-of-turn rate** — agent would have sat in silence
  - speech-start detection latency, which bounds barge-in responsiveness
  - where eager end-of-turn exists: how often it fires and is then retracted
- **R9.1.7** The output is two rankings, not one — best transcriber and best turn detector.
  The winning composition may be one provider or two (R4.1.6).
- **R9.1.8** Round-trip latency MUST be measured from Lagos, not from the vendor's
  benchmark. Against an 800ms budget, hosting region can disqualify a provider on its own,
  regardless of accuracy.
- **R9.1.9** Rerun on every provider or config change. Number-accuracy regression blocks
  the change.

Cost: about two working days. It was one day when the corpus was scripted. The extra day
buys a stack decision that survives contact with a real caller.

### 9.2 Post-call review loop — improves the system, runs forever

Permanent infrastructure, not a phase. This is the flywheel, and it is what "self-
improving" actually means in practice.

- **R9.2.1** Every completed call is scanned automatically against failure heuristics:
  low-confidence turns, repeated clarification requests, failed number captures, DTMF
  fallbacks triggered, silences over 2s, escalations, abrupt caller hangups, tool
  timeouts, detected frustration.
- **R9.2.2** Calls crossing a threshold land in a **review queue** inside the internal
  call viewer, ranked by severity.
- **R9.2.3** A human reviews the flagged call, listens to the audio, and **corrects the
  transcript**. That correction is the point: production audio has no ground truth until
  someone supplies it.
- **R9.2.4** Every corrected turn is promoted into the eval corpus with its category
  label. The corpus grows from real traffic and the regression suite grows with it.
- **R9.2.5** Corrections also feed:
  - per-organization keyterm vocabulary (names and terms the STT keeps missing)
  - normalizer test cases (anything spoken wrong)
  - prompt adjustments (recurring conversational failure patterns)
  - candidate FAQ entries the knowledge base is missing
- **R9.2.6** Review outcomes are tracked over time so provider or prompt changes can be
  attributed to measurable movement, not to feel.

### 9.3 Live conversation test — before any customer traffic

WER is the wrong metric for a conversation. A call can score 8% WER and still fail because
the agent interrupted at the wrong moment, went silent for four seconds, or confirmed the
wrong policy number confidently.

- **R9.3.1** Before a organization goes live, ≥20 unscripted calls from **people who are not on
  the build**, on their own phones, on real networks — including at least one on a poor
  connection and one from a noisy environment.
- **R9.3.2** Scored on task success, not transcription: did the caller get what they
  called for, without repeating themselves more than once, without an unnecessary
  transfer, without a wrong-number-confirmed-correct event.
- **R9.3.3** Every one of those calls goes through the review loop (§9.2) and its
  corrections enter the corpus.
- **R9.3.4** Any wrong-number-confirmed-correct event is a launch blocker. That is the
  failure mode that loses a customer's customer.

---

## 10. Success metrics

| Metric | v1 target |
|---|---|
| Number-string capture accuracy (readback-confirmed first try) | ≥ 90% |
| Overall WER on Nigerian phone-audio eval set | ≤ 15% |
| Calls resolved without human transfer | ≥ 50% |
| p50 response latency | < 800ms |
| Calls where agent went silent > 3s | < 1% |
| Organization onboarding time (manual, by us) | < 1 day |

---

## 11. Phasing

**Phase 1 — Foundation (this document's scope).** Seed corpus and provider bake-off, one
organization, one phone number, inbound only, English, internal tools plus both external
connector routes (HTTP and MCP), post-call review loop, manual onboarding, internal call
viewer.

**Phase 2 — Product.** Organization admin UI, self-serve config and connector setup, billing,
analytics, WhatsApp channel, inbound webhooks from organization systems.

**Outbound calling is gated, not scheduled.** It begins only after Slice 7a passes — 20
unscripted inbound calls, task success measured, zero wrong-number confirmations. Outbound
is technically easy from the same pipeline, which is exactly why it will tempt us early. An
outbound agent that mishears is worse than an inbound one: we chose to call them.

**Phase 3 — Depth.** Yoruba/Hausa/Igbo, cross-call caller memory, emotion-aware routing,
self-improving prompts from failed-call review, live agent shadowing.

Phase 3 is where the differentiation lives, but it is worthless without Phase 1 being
genuinely solid. Do not skip ahead.
