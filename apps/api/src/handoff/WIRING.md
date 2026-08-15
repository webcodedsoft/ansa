> **APPLIED 2026-08-08** in "The escalation goes somewhere, and the caller hears why
> first". Steps 3, 4a-4d and 5. Step 4e waits on tool dispatch. Step 2 (moving the
> destination into AppConfig) is still open, and so is everything under "what a real
> call still has to prove".

# Wiring the handoff

Written because eight other agents are in this tree at the same time and `orchestrator.ts`,
`capture.ts`, `media.gateway.ts`, `telephony.module.ts` and `config/env.ts` belong to other
charters. Everything in this directory is finished and tested; none of it runs on a call
until the edits below are made. **Nothing here is done until they are** — an escalation
path nothing calls is exactly the "unwired module that reads as progress" the wiring check
exists to catch, and it will not be caught here because the tests reference every export.

Applied in order, the edits are about sixty lines. Step 1 is already done; steps 3 and 4
are not, and until step 4 exists no trigger fires and no call is ever transferred.

---

## 1. ~~`telephony.module.ts` — register the whisper endpoint and the destination~~ DONE

Applied, because nothing else was in that file and the wiring check was right to fail on
three exports with no caller. Left here so the shape is visible.

```ts
import { HandoffController } from "../handoff/handoff.controller";
import { resolveHandoffDestination } from "../handoff/destination";
import { createWhisperRegistry } from "../handoff/whisper";
import { HANDOFF_DESTINATION, WHISPER_REGISTRY } from "../handoff/tokens";

@Module({
  controllers: [VoiceController, ViewerController, HandoffController],
  providers: [
    // …existing…
    { provide: WHISPER_REGISTRY, useFactory: () => createWhisperRegistry() },
    {
      provide: HANDOFF_DESTINATION,
      inject: [LOGGER],
      useFactory: (log: Logger) => resolveHandoffDestination(process.env, log),
    },
  ],
  exports: [/* …existing…, */ WHISPER_REGISTRY, HANDOFF_DESTINATION],
})
```

One registry per process, not per call: the carrier fetches the whisper from outside the
call's own lifetime.

---

## 2. `config/env.ts` — optional, and preferred

`resolveHandoffDestination` takes a `NodeJS.ProcessEnv` so it works today without touching
the config module. It reads:

| Variable | Meaning |
|---|---|
| `HANDOFF_TO_NUMBER` | E.164. The person. Required, or escalation says so out loud. |
| `HANDOFF_FROM_NUMBER` | E.164 the carrier account owns. Shown to the person answering. |
| `HANDOFF_RING_SECONDS` | Default 25. |

When `config/env.ts` next changes hands, these belong in `AppConfig` like everything else,
and `resolveHandoffDestination` should take the config object instead of the environment.

R6.5 puts the destination in **per-organization** configuration alongside business hours and
out-of-hours behaviour. `HandoffDestination` is deliberately the shape a `organizations` row will
fill: when those columns exist, `resolveHandoffDestination` gains a organization argument and
nothing above it changes. One destination for every organization is a single-organization assumption
with a deadline on it.

`TWILIO_ACCOUNT_SID` is now load-bearing for inbound as well as outbound: without it the
REST call that performs the transfer cannot be made, and escalation will apologise and
hang up rather than connect.

---

## 3. `media.gateway.ts` — one journal, one handoff, per call

In `startConversation`, after the recorder is created:

```ts
const recorder = createCallRecorder({ dataSource: this.dataSource, log });
// Tees the same events on their way to call_events, because the recorder batches and the
// last few seconds of a call — the ones that caused the escalation — are not in the table
// yet when the transfer is dialled.
const journal = withHandoffJournal(recorder);
```

Then pass `journal.recorder` to `runConversation` **in place of** `recorder`, keeping
`recorder.started(...)` and `recorder.ended(...)` where they are.

Build the handoff after the organization is known:

```ts
const handoff = createHandoff({
  telephony: this.telephony,
  callId: stream.callId,
  organizationId: organization?.organizationId ?? null,
  callerNumber: stream.parameters[CALLER_PARAM] ?? null,
  destination: this.destination,          // injected HANDOFF_DESTINATION
  events: journal.events,
  record: journal.recorder,
  log,
  say: () => Promise.resolve(),           // replaced in step 4 — see the warning there
  hangUp: () => { stream.hangUp(); },
  whisper: this.whisper,                  // injected WHISPER_REGISTRY
  whisperBaseUrl: this.config.publicBaseUrl,
});
```

and hand `handoff` to `runConversation` as a new optional dep.

---

## 4. `orchestrator.ts` — the five call sites

Add to `OrchestratorDeps`:

```ts
/** Hands the call to a person. Absent means escalation only logs, as it does today. */
readonly handoff?: Handoff;
```

and inside `runConversation`:

```ts
const watch = createEscalationWatch();
const escalate = (trigger: EscalationTrigger | null): boolean => {
  if (trigger === null) return false;
  void deps.handoff?.escalate(trigger);
  return deps.handoff !== undefined;
};
```

### 4a. `say` must resolve when the caller has HEARD the line

This is the one part that is not a copy-paste, and it is the part a real call will punish.
`transferToNumber` replaces the call's carrier instruction, which tears down the media
stream. Anything still queued at the carrier — measured at ~1.8s on this project's own
calls — is discarded. So "let me put you through" must be **heard**, not merely sent,
before the REST call goes out.

The orchestrator already knows when audio has been heard: `stream.onMark` advances
`bytesHeard`, and `finishIfComplete` fires when `bytesHeard >= bytesSent`. Add a resolver
alongside `sayNow`:

```ts
const sayAndWait = (text: string, reason: string): Promise<void> =>
  new Promise((resolve) => {
    sayNow(text, reason);
    const spoken = turn;
    if (spoken === null) { resolve(); return; }
    playedOut.set(spoken.seq, resolve);   // new Map<number, () => void>
  });
```

and in `finishIfComplete`, immediately before `turn = null`:

```ts
playedOut.get(current.seq)?.();
playedOut.delete(current.seq);
```

`createHandoff` already guards the other side of this with `sayTimeoutMs` (8s default): a
mark that never arrives logs a warning and the transfer proceeds. Do not remove that
guard by resolving eagerly — the timeout is the backstop, not the mechanism.

Then in `media.gateway.ts` step 3, `say` becomes
`(text) => sayAndWait(text, "handoff")`. Since `sayAndWait` lives inside
`runConversation`, the cleanest shape is for the gateway to pass a *factory*
(`makeHandoff: (say) => Handoff`) rather than a built `Handoff`, or for `runConversation`
to call `deps.handoff.attach({ say, hangUp })`. Either is fine; the second keeps the
gateway simpler.

### 4b. Explicit request — in `transcripts.onFinal`

After the echo, backchannel, particle and repair filters, **before** `captureHandled`:

```ts
if (escalate(watch.callerSaid(text))) {
  conversation.addCaller(whole);   // the ask belongs in the record
  return;                          // no model turn: they are leaving
}
```

Placing it after the filters matters — "put me through" echoed back from our own audio
must not transfer the call.

Placing it *before* capture matters more. A caller mid-readback who says "just give me a
person" is answered today with another readback, which is the exact loop R6.4 forbids.

### 4c. Repeated misunderstanding

Three places feed one counter:

```ts
// in sayRecovery, after the log line
escalate(watch.misunderstood(reason));

// in the repair-request branch of onFinal, before repeatLast()
escalate(watch.misunderstood("caller asked us to repeat"));

// in captureHandled, when the same subject is read back for the third time
if (capture.kind === "confirming" && capture.attempt >= 3) {
  escalate(watch.misunderstood(`third readback of the ${capture.subject}`));
}
```

and one place resets it — in `completion.onDone`, where a turn produced real speech:

```ts
if (full.trim().length > 0) watch.understood();
```

Without the reset, three scattered failures across an otherwise fine six-minute call
transfer a caller who was doing fine. R6.4 is three failures *on the same intent*.

### 4d. Capture gave up

In `captureHandled`, replacing the current "nothing to transfer to yet" branch:

```ts
if (capture.kind === "escalate") {
  log.error("capture failed, caller needs a human", { text });
  record.event("escalated to a human", { text });
  if (escalate(watch.captureFailed())) return true;   // handoff speaks its own line
}
```

The `return true` is important: `capture.ts` produces "Let me get a colleague for you" as
`result.say`, and the handoff speaks its own departure line. Without the early return the
caller hears both. **`capture.ts` needs no change** — its escalation line remains correct
for a deployment with no handoff configured.

### 4e. Tool failure

`packages/tools` does not exist yet. When it does, its dispatch path calls:

```ts
escalate(watch.toolFailed(name, outcome));   // outcome: "timeout" | "error"
```

The summary already reads `tool_result` / `tool_invoked` / `tool_failed` events with
`{ name, outcome, summary }` and reports them as actions performed. If the tools agent
picks different event kinds, add them to `TOOL_KINDS` in `summary.ts` and `KEPT` in
`journal.ts` — those two lists are the whole coupling.

An `irreversible` tier tool must transfer rather than execute (R5.3). That is a
`captureFailed`-shaped call into `escalate` from the dispatch path, not a new path here.

---

## 5. One event the summary would like and does not get

The keypad branch of `stream.onDigit` records nothing when a value is confirmed, so a
reference the caller typed rather than spoke is invisible to the handoff — and the keypad
is reached exactly when speech has already failed twice, which is exactly the call most
likely to be transferred.

Two lines, mirroring the speech path so no new class of data enters the log:

```ts
if (result.captured !== null) {
  capture = idle;
  record.event("entity_candidate", { subject: "number", value: result.captured });
  record.event("value confirmed", { chars: result.captured.length });
  // …existing…
}
```

`summarise` also accepts `value` directly on `value confirmed` if that is preferred, but
the pair above keeps the keypad and speech paths identical in the log.

---

## What a real call still has to prove

Unit tests prove none of the following. Each is a seam.

1. **The line is heard before the stream dies.** Step 4a. If the ordering is wrong the
   caller is transferred mid-sentence with no idea why.
2. **The caller hears something while the phone rings.** `answerOnBridge="true"` is set
   for this reason. Whether the carrier plays ringback to an already-answered leg is
   *expected and unverified*; if it is silence, that is a gap over two seconds (R6.2) and
   the fix is a `ringTone` attribute or a held filler.
3. **The whisper actually plays, and only to the person.** The URL is fetched from the
   public internet by the carrier, so `PUBLIC_BASE_URL` must be reachable and the token
   must survive the round trip.
4. **The no-answer line plays instead of a hangup.** Requires a destination that rings out.
5. **Carrier signature verification on the whisper endpoint.** Deliberately not enabled —
   see the comment in `handoff.controller.ts`. Worth adding once (3) is proved on a real
   call, not before.
