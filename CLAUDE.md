# CLAUDE.md — Ansa Implementation Guide

Read this at the start of every session, after `TASKS.md`.

`PRD.md` says what to build. `TASKS.md` says what order. This says how.

---

## Reading order

1. `TASKS.md` — current slice, what's checked, what's next
2. This file — conventions and non-negotiables
3. `PRD.md` — requirement detail (R-numbers referenced from TASKS)
4. `docs/STACK_DECISION.md` — why the providers are what they are

---

## The four rules that override everything

**0. The product is TypeScript. `eval/` is Python and is not the product.**
`apps/` and `packages/` are NestJS/TypeScript — that is Ansa. `eval/` is standalone
measurement tooling, run by hand, standard-library Python, zero dependencies. It never
imports from the monorepo and the monorepo never imports from it. During a build slice you
should not be writing Python at all; during Gate A you should not be writing NestJS. If a
session drifts across that line, stop and reorient — it is the clearest signal available
that the wrong task is being worked.

**1. A slice is done when a phone call proves it.** Not when the code compiles, not when
the unit tests pass. If you can't dial the number and hear the result, the slice is open.
For outbound, the equivalent is a call you placed ringing a real handset — a REST call
that returned 201 proves nothing.

**2. No vendor types outside adapters.** Twilio, Deepgram, Intron, Spitch, ElevenLabs and
Anthropic SDK types live inside `packages/providers/*` and nowhere else. Orchestration
code imports our interfaces. If `import { DeepgramClient }` appears in
`apps/api/src/orchestrator`, that's a defect, not a shortcut. The whole point is that
swapping STT is a one-file change.

**3. `organization_id` is not optional.** Every table, every query, every log line, every metric
label, every event. Isolation is enforced by Postgres RLS, not by remembering to add a
`where` clause. A query that could return another organization's row is a security bug even if
no one has hit it.

---

## Repo shape

```
ansa/
├── apps/
│   └── api/                 # NestJS — telephony, orchestration, tools
├── packages/
│   ├── providers/
│   │   ├── listen/
│   │   │   ├── transcriber/ # words: interface + implementations
│   │   │   └── turn/        # turn events: interface + implementations
│   │   ├── tts/
│   │   ├── llm/
│   │   └── telephony/
│   ├── normalizer/          # pure, no I/O, highest coverage in the repo
│   ├── tools/               # registry, dispatch, adapters, risk tiers
│   ├── shared/              # types shared across packages
│   └── config/              # eslint/tsconfig
├── eval/                    # corpus, scoring scripts, results
└── docs/
```

Turborepo + pnpm. TypeScript strict. No `any` without a comment explaining why.

**Functions are expressions, not declarations.** Write `const parseFrame = (raw: string) =>
…`, never `function parseFrame(raw: string) {…}`. Enforced by `func-style: expression` in
`@ansa/config`, so it fails lint rather than review.

Two consequences worth knowing before you fight them:

- **Order matters.** Expressions do not hoist, so a helper must appear above its first use.
  This is mostly a feature — a file reads top-down in dependency order — but it will bite
  when you move code and get "used before declaration".
- **Class methods are exempt**, because they cannot be anything else. NestJS controllers,
  modules and gateways stay classes; the decorators require it. The rule targets free
  functions, not methods.

Arrow functions keep their inferred name in stack traces when assigned to a `const`, so
this costs nothing in debuggability. Type predicates work unchanged:
`const isRecord = (v: unknown): v is Record<string, unknown> => …`.

---

## Inbound and outbound

Ansa answers calls and places them. Outbound was explicitly out of scope until
2026-08-08 and the codebase still reflects that in places — if you find an interface that
reads as though outbound will never exist, it predates this and is safe to widen.

What has **not** changed is why the restriction existed, and it still constrains how
outbound should land: pre-generalising costs clarity in every file. So widen a type when
a real outbound requirement forces it, not in anticipation of one. `direction` exists
because two lifecycles genuinely differ; it is not licence to add `CallType` enums for
call kinds nobody has asked for.

The differences that actually matter:

- **Organization resolution runs backwards.** Inbound resolves the organization from the dialled
  number at ingress (R7.3). Outbound already knows the organization — it is the one that asked
  for the call — so the organization travels *out* with the origination and comes back on the
  media socket as a stream parameter. Do not resolve it a second time from the caller ID.
- **The media path is identical once answered.** `<Connect><Stream>` is the same verb, the
  same socket, the same orchestrator. Everything below the answer is shared, and a second
  copy of it would be the same mistake as a second tool dispatch path.
- **Outbound can fail in ways inbound cannot.** No answer, busy, rejected, voicemail. An
  inbound call is answered by definition; an outbound one has a lifecycle before audio
  exists, and the orchestrator must never be started for a call that was never picked up.
- **Voicemail is not a caller.** Answering-machine detection is not optional politeness:
  an agent that holds a two-minute conversation with a voicemail greeting is both useless
  and billed.
- **Consent is a hard gate, not a policy.** Nigerian NDPR and NCC rules on unsolicited
  calls, plus time-of-day limits and do-not-call suppression, belong in the dispatch path
  and not in a prompt. Same rule as risk tiers: code cannot be talked out of it. A organization
  configuring "call these numbers" must not be able to configure away the check.

## Voice is not chat

Most LLM application patterns are wrong here. The differences that actually bite:

- **Latency is a correctness property, not a performance nicety.** An 800ms gap is a bad
  answer even if the words are right. Instrument every stage from the first slice.
- **Silence reads as a dropped call.** Any gap over 2s must produce sound. This is why
  the holding-speech scheduler exists.
- **Turns are two sentences.** The model will drift long. Enforce it in the prompt, catch
  it in review.
- **Streaming everywhere.** Batch STT and non-streaming TTS are disqualifying, not
  suboptimal.
- **Barge-in changes context.** When the caller interrupts, the unplayed portion of the
  agent's turn never happened. Do not leave it in the conversation history — the agent
  will reference things the caller never heard.

---

## The normalizer

`packages/normalizer` is pure: text in, text out, no I/O, no network, no config lookups.
It's the easiest package to test and the one that most determines whether the product
feels Nigerian or translated.

- Nothing reaches TTS unnormalized. Not LLM output, not tool results, not static
  greetings, not error messages.
- The LLM never emits raw digits to be spoken. If it does, that's a prompt bug *and* the
  normalizer should still catch it.
- Every bug found in production becomes a test case before it's fixed.
- Prompting is not a substitute for this. The model will get naira amounts right 90% of
  the time, and 90% is a customer complaint.

---

## Tool calling

**One registry, one dispatch path, many adapters.** Internal tools, HTTP connectors and
MCP servers all register into the same place and execute through the same code. Risk
tiers, timeouts, holding speech, credential handling, SSRF guards, summarization and
logging are implemented once.

When adding a new tool route, the test is: did you write an adapter, or did you write a
second dispatch path? Only the first is acceptable.

**Risk tier is a required field.** Registration fails without one.

- `read` — executes freely
- `write` — spoken confirmation plus readback before firing
- `irreversible` — never executes, transfers to a human

This is enforced in the dispatch path. It is never a prompt instruction, because prompts
can be talked out of things and code cannot.

**Holding speech starts when the tool is dispatched, not when it returns.** This is a
scheduling requirement. Get it right with the first tool.

---

## Provider abstraction

Each provider package exports an interface and one or more implementations. The interface
is designed around what the orchestrator needs, not around what any vendor's SDK offers.

### The listen layer is two interfaces, not one

This is the seam that matters most, and it is easy to get wrong by treating "STT" as a
single blob.

Understanding *what the caller said* and knowing *when the caller stopped talking* are
different problems, and the best provider for each is currently not the same one. African-
accent-specialist models (Intron Sahara v2) lead on transcription of Nigerian speech,
numbers and names. Conversational models (Deepgram Flux) lead on model-native end-of-turn
detection and barge-in timing but are American-English-centric. If those two interfaces
are fused, you cannot combine them, and you cannot swap one without disturbing the other.

```ts
// packages/providers/listen/

interface Transcriber {
  // audio in → text out. Knows nothing about turns.
  connect(opts: { sampleRate; encoding; keyterms: string[] }): TranscriberSession;
}
interface TranscriberSession {
  write(chunk: Buffer): void;
  onInterim(cb: (t: Transcript) => void): void;   // partial text
  onFinal(cb: (t: Transcript) => void): void;     // stable text + word-level confidence
  close(): void;
}

interface TurnDetector {
  // audio in → turn events out. Knows nothing about words.
  connect(opts: { sampleRate; encoding; eotThreshold; eagerEotThreshold }): TurnSession;
}
interface TurnSession {
  write(chunk: Buffer): void;
  onSpeechStart(cb): void;        // drives barge-in
  onEagerEndOfTurn(cb): void;     // optional: speculative response start
  onEndOfTurn(cb): void;          // commit the turn
  onTurnResumed(cb): void;        // caller wasn't finished — cancel speculative work
  close(): void;
}
```

**Three valid compositions, all behind the same orchestrator code:**

| Composition | When |
|---|---|
| One provider serving both interfaces | Simplest. Use if one wins both in Slice 0. |
| Provider A transcribes, provider B detects turns, same audio fanned out to both | Likely outcome. Higher cost, better result. |
| Provider transcribes, our own VAD/endpointing detects turns | Fallback if no turn provider is acceptable. |

**Rules:**
- The orchestrator consumes turn events and transcripts as separate streams and correlates
  them by timestamp. It must never assume they come from the same connection.
- Audio fan-out to multiple listen providers happens in one place, not scattered through
  the pipeline.
- `onTurnResumed` must actually cancel in-flight speculative work — LLM request, tool
  dispatch, TTS synthesis. If it doesn't, eager end-of-turn makes things worse, not better.
- Cost per listen provider is tracked separately. Running two doubles your STT bill and
  you need to be able to see whether it's worth it.

### Everything else

STT/Transcriber implementations must expose word-level confidence and keyterm injection.
TTS implementations must expose streaming synthesis with cancellation (barge-in kills
in-flight audio) and native telephony output format.

If a vendor can't satisfy the interface, that's information about the vendor — don't
reshape the interface around it and don't leak the gap upward.

---

## Testing

- `packages/normalizer` — exhaustive. Highest coverage in the repo.
- Organization isolation — an adversarial test proving organization A cannot read organization B's calls.
  Written in Slice 2, runs in CI forever.
- Tool security — SSRF attempts, credential leakage into transcripts and LLM context,
  cross-organization tool access. Runs in CI.
- Eval harness — reruns on any provider or prompt change. **Number-accuracy regression
  blocks merge.**
- Failure drills — STT down, LLM timeout, TTS failure, organization endpoint hanging. Every one
  must degrade into speech, never into silence.

---

## Session discipline

- Update `TASKS.md` before stopping. Check boxes; write down what broke.
- One slice at a time. Don't start the next until the current "done when" is true.
- `pnpm lint && pnpm typecheck` before committing.
- Push to remote at the end of every session. The last build was lost on a dead laptop.

---

## Things that will feel tempting and are wrong

- Building the organization dashboard because the internal viewer is ugly. The viewer is for
  debugging; ugly is fine.
- Skipping the readback confirmation because STT confidence looks high. Confidence is not
  correctness on 8kHz audio.
- Handling number formatting in the system prompt because it works in testing. It works
  until it doesn't, in front of a customer.
- Treating STT as one interface because the vendor SDK does. Words and turn boundaries are
  separate problems with separate winners; fusing them costs you the best available
  combination and you won't notice until it's expensive to unpick.
- Adding a second dispatch path for MCP because it's structurally different. It isn't,
  above the adapter.
- Starting Phase 2 or 3 features because they're more interesting. They are. That's why
  they're listed under "Not now."
