# Wiring the call state machine into `orchestrator.ts`

Apply this by hand, serially, once the other agents working in `orchestrator.ts` have
landed. It is a **no-behaviour-change refactor**: every edit adds a line that reports
something the orchestrator already did. No edit moves, reorders, removes or guards any
existing statement. If an edit here asks you to change a condition, it is wrong — stop.

Line numbers are against `26239bf` and will have drifted. The **anchor** is the thing to
find; the line number is only a hint about where to look.

After every edit, `orchestrator.test.ts` must still pass unchanged. That suite is the
proof that this refactor changed nothing, and it is the reason not one of its expectations
may be edited while applying this file.

---

## 1. Import

**Anchor** the last line of the import block:

```ts
import { SYSTEM_PROMPT } from "./system-prompt";
```

**Add** below it:

```ts
import { createCallState } from "./call-state/machine";
```

## 2. Construct the machine — one place, one log line

**Anchor** (~line 489), the recorder:

```ts
const record = deps.recorder ?? nullRecorder;
```

**Add** immediately below:

```ts
/**
 * The call's state as one named value. It decides nothing — every branch below still
 * makes the decision it makes today and reports what it did. See call-state/machine.ts.
 */
const callState = createCallState((transition) => {
  log.info("call state", transition);
  record.event("call_state", { ...transition });
});
```

`callState` is referenced by handlers registered above this line, which is fine: they run
long after the module body, exactly as `record` already does inside `measure`.

---

## 3. The edits, in file order

Each is "find the anchor, add the line". Nothing else.

### 3.1 First byte of audio for a turn — `speakNext`, inside `synthesis.onAudio` (~615)

**Anchor**

```ts
current.sentenceAudioAt = Date.now();
```

**Add below**

```ts
callState.apply({ kind: "agent.audio.started", seq: current.seq });
```

This is the PROCESSING → RESPONDING edge, and it is the same instant the orchestrator
already treats as "the agent is speaking for real now" when it cancels the filler.

### 3.2 Two failed syntheses and nothing said — `synthesis.onError` (~668)

**Anchor**

```ts
log.error("turn produced no audio, ending the call", { seq: current.seq });
turn = null;
stream.hangUp();
```

**Add** between `turn = null;` and `stream.hangUp();`

```ts
callState.apply({ kind: "agent.turn.interrupted", seq: current.seq, reason: "tts failed twice" });
callState.apply({ kind: "call.hangup.requested", reason: "tts failed twice" });
```

### 3.3 A turn played out — `finishIfComplete` (~709)

**Anchor**

```ts
log.info("agent turn played", {
  seq: current.seq,
  ms: Math.round(durationMs(current.bytesHeard, stream.format)),
});
turn = null;
```

**Add below** `turn = null;`

```ts
callState.apply({ kind: "agent.turn.completed", seq: current.seq });
```

### 3.4 A turn cut short — `stopSpeaking` (~726)

**Anchor**

```ts
const current = turn;
if (current === null) return;
turn = null;
```

**Add below** `turn = null;`

```ts
callState.apply({ kind: "agent.turn.interrupted", seq: current.seq, reason });
```

It must go **after** the null guard. `stopSpeaking` is called from paths that find no turn
at all and returns early; reporting above the guard would invent an interruption on a call
where nothing was playing.

### 3.5 Speech start, all three branches — `onSpeechStart` (~764)

Three separate edits, one per branch, because the orchestrator does three different things.

**Echo** — anchor:

```ts
echoSegments.add(event.offsetMs);
```

add below:

```ts
callState.apply({ kind: "caller.speech.started", handling: "echo" });
```

**Agent still thinking** — anchor:

```ts
log.debug("caller spoke while the agent was still thinking", {
  offsetMs: event.offsetMs,
});
```

add below:

```ts
callState.apply({ kind: "caller.speech.started", handling: "over-thinking" });
```

**Accepted** — anchor:

```ts
log.debug("caller speech start", { offsetMs: event.offsetMs });
```

add below:

```ts
callState.apply({ kind: "caller.speech.started", handling: "barge-in" });
```

Note the last one is reported whether or not a turn is open — it is the caller taking the
floor, and `stopSpeaking` reports the interruption separately on the next line.

### 3.6 The caller stopped — `onEndOfTurn` (~794)

**Anchor** the first line of the handler:

```ts
mark("stt_final");
```

**Add above it**

```ts
callState.apply({ kind: "caller.turn.ended" });
```

### 3.7 The listener died — `onFailure` (~825)

**Anchor**

```ts
const farewell = turn;
if (farewell === null) {
  stream.hangUp();
  return;
}
stream.onMark(() => {
  if (farewell.bytesHeard >= farewell.bytesSent && farewell.bytesSent > 0) stream.hangUp();
});
```

**Add** a hang-up report immediately above **each** of the two `stream.hangUp()` calls:

```ts
callState.apply({ kind: "call.hangup.requested", reason: "listen connection lost" });
```

### 3.8 The four remaining turn constructors

One line under each `turn = …` assignment. The `reason` is what separates GREETING and
ERROR_RECOVERY from an ordinary turn, so it must match the table exactly.

| Function | Anchor | Add below |
|---|---|---|
| `sayNow` (~874) | `turn = direct;` | `callState.apply({ kind: "agent.turn.started", seq: direct.seq, reason: "capture" });` |
| `sayRecovery` (~897) | `turn = recovery;` | `callState.apply({ kind: "agent.turn.started", seq: recovery.seq, reason: "recovery" });` |
| `repeatLast` (~928) | `turn = repeat;` | `callState.apply({ kind: "agent.turn.started", seq: repeat.seq, reason: "repeat" });` |
| `respondTo` (~963) | `turn = current;` | `callState.apply({ kind: "agent.turn.started", seq, reason: "model" });` |

`sayNow` is the capture path and only the capture path — readbacks, spell prompts and
keypad prompts — which is why its reason is `capture` rather than something about
readback specifically.

### 3.9 Capture, from speech — `captureHandled` (~1104)

**Anchor**

```ts
const result = advance(capture, { kind: "speech", text });
capture = result.state;

if (result.captured !== null) {
  capture = idle;
```

**Rewrite as** (this is the only edit in the file that touches more than one line, and it
adds two reports and one `const`; no existing statement moves):

```ts
const previous = capture;
const result = advance(capture, { kind: "speech", text });
capture = result.state;

if (result.captured !== null) {
  capture = idle;
  callState.apply({ kind: "capture.updated", previous, next: capture });
```

and then, further down, **anchor**

```ts
// Recorded here because respondTo is not running for this turn, and a history with
// the agent's readback but not the caller's number makes no sense to the model.
conversation.addCaller(forModel);
```

**Add above** that comment:

```ts
callState.apply({ kind: "capture.updated", previous, next: capture });
```

One report per path. Reporting once after `capture = result.state` and again after
`capture = idle` would also be correct — `confirmed` and `idle` name the same state, so
the second produces no transition — but one per path keeps the log honest about how many
times capture actually moved.

### 3.10 Capture, from the keypad — `onDigit` (~1146)

**Anchor**

```ts
const result = advance(capture, { kind: "keypad", digit });
capture = result.state;

if (result.captured !== null) {
  capture = idle;
```

**Rewrite as**

```ts
const previous = capture;
const result = advance(capture, { kind: "keypad", digit });
capture = result.state;

if (result.captured !== null) {
  capture = idle;
  callState.apply({ kind: "capture.updated", previous, next: capture });
```

and then, further down, **anchor** the last line of the handler:

```ts
if (result.say !== null) sayNow(result.say, "keypad");
```

**Add above** it:

```ts
callState.apply({ kind: "capture.updated", previous, next: capture });
```

Same shape as 3.9: one report per path. Every press reports, including the ones that only
lengthen `digits` — those are the presses CAPTURING_ENTITY is made of.

### 3.11 The six discards — `onFinal` (~1174 onwards)

None of these changes any state; they are reported so a discard can be read against the
state it happened in, which is the only way to tell an over-firing filter from an
under-firing one. In each case add the line immediately below the existing `log` call.

| Anchor (existing log) | Add |
|---|---|
| `log.warn("discarded a transcript with no speech behind it", …)` | `callState.apply({ kind: "caller.transcript.discarded", reason: "no-speech" });` |
| `log.info("ignored non-speech", …)` | `callState.apply({ kind: "caller.transcript.discarded", reason: "noise" });` |
| `log.info("ignored echoed agent audio", …)` | `callState.apply({ kind: "caller.transcript.discarded", reason: "echo" });` |
| `log.debug("ignored backchannel", …)` | `callState.apply({ kind: "caller.transcript.discarded", reason: "backchannel" });` |
| `log.debug("ignored bare particle", …)` | `callState.apply({ kind: "caller.transcript.discarded", reason: "particle" });` |
| `log.info("ignored transcript matching our own speech", …)` | `callState.apply({ kind: "caller.transcript.discarded", reason: "self-speech" });` |

For the first one, the line goes **after** `record.event("hallucination discarded", …)`
and before the `return`.

### 3.12 The caller asked us to repeat (~1236)

**Anchor**

```ts
log.info("caller asked us to repeat", { text });
conversation.addCaller(text);
repeatLast();
```

**Add** between `conversation.addCaller(text);` and `repeatLast();`

```ts
callState.apply({ kind: "caller.turn.dispatched" });
```

### 3.13 A turn held for a continuation (~1282)

**Anchor**

```ts
log.info("caller has not finished, waiting", { text: whole });
cancelFiller();
```

**Add below** `cancelFiller();`

```ts
callState.apply({ kind: "caller.turn.held" });
```

**And inside the timer callback**, anchor:

```ts
log.info("caller did not continue, answering what we have", { text: whole });
if (!captureHandled(whole, wholeForModel)) respondTo(whole, wholeForModel);
```

add between those two lines:

```ts
callState.apply({ kind: "caller.turn.dispatched" });
```

### 3.14 The turn is answered (~1297)

**Anchor**

```ts
// Before the model, never after. R4.3.1 is a gate, and a gate the model can answer
// around is not a gate.
if (captureHandled(whole, wholeForModel)) return;
```

**Add above** the comment:

```ts
callState.apply({ kind: "caller.turn.dispatched" });
```

### 3.15 The call closed — `onClosed` (~1302)

**Anchor**

```ts
stream.onClosed((reason) => {
  clearPending();
```

**Add** as the first line of the handler, above `clearPending()`:

```ts
callState.apply({ kind: "call.closed", reason });
```

First, deliberately. The machine is terminal once closed, so the
`agent.turn.interrupted` that `stopSpeaking("call ended")` reports three lines later is
ignored rather than logged as a state change on a call that has already ended.

### 3.16 The greeting (~1326)

**Anchor**

```ts
turn = greetingTurn;
lastUtterance = deps.greeting;
```

**Add below** `turn = greetingTurn;`

```ts
callState.apply({ kind: "agent.turn.started", seq: greetingTurn.seq, reason: "greeting" });
```

**And in the pre-rendered branch**, anchor:

```ts
greetingTurn.sentenceAudioAt = Date.now();
```

add below:

```ts
callState.apply({ kind: "agent.audio.started", seq: greetingTurn.seq });
```

The live-synthesis branch needs nothing: it goes through `enqueue` → `speakNext` and picks
up 3.1 for free.

---

## 4. What the log will look like

A clean turn:

```
IDLE -> GREETING           agent.turn.started
GREETING -> LISTENING      agent.turn.completed
LISTENING -> UNDERSTANDING caller.turn.ended
UNDERSTANDING -> PROCESSING agent.turn.started
PROCESSING -> RESPONDING   agent.audio.started
RESPONDING -> LISTENING    agent.turn.completed
```

A readback that is confirmed:

```
LISTENING -> UNDERSTANDING      caller.turn.ended
UNDERSTANDING -> CONFIRMING_ENTITY capture.updated
CONFIRMING_ENTITY -> LISTENING  capture.updated      <- the value was released
LISTENING -> PROCESSING         agent.turn.started
```

That third line is a real instant and not a defect: `captureHandled` sets `capture = idle`
on the line before it calls `respondTo`, so for the duration of one synchronous statement
the call has no capture outstanding and no turn open. If it becomes annoying in the log
the fix is to move the report, not to move the assignment.

---

## 5. Verifying the refactor changed nothing

```
pnpm lint && pnpm typecheck && pnpm test
```

`orchestrator.test.ts` must pass **without a single expectation being touched**. If one
needs editing, an edit above did more than report.

Then make a call. The state line appears at `info`, so a call transcript should read as a
list of states with nothing surprising in it. Two things to look for specifically:

- No `-> UNDERSTANDING` that never leaves. That is a transcript that never arrived and a
  watchdog that did not fire.
- No `-> TRANSFERRING`. If one appears, the rest of that call is the agent saying nothing
  at all — see below.

---

## 6. Known wrong, deliberately not fixed here

Found while deriving the transitions. Every one of these is current behaviour; this
refactor preserves all of them exactly, and the tests in `machine.test.ts` pin several of
them so that a later fix is a visible change rather than a quiet one.

1. **Escalation is a black hole, and it is the worst of these.** Once
   `capture.kind === "escalate"`, `captureHandled` no longer takes the `idle` early
   return, `advance` returns the state unchanged with `say: null`, and the function
   returns `true`. So `respondTo` never runs again: **the agent goes permanently silent
   for the rest of the call**, swallowing every caller turn, and re-records
   `escalated to a human` on each one. A caller who has just been told "let me get a
   colleague for you" then talks to a dead line. Owner: `human-handoff` (§18) — there is
   nothing to transfer to yet, which is why the state exists at all — but the silence is
   independent of the transfer and could be fixed before it.

2. **The barge-in guard stamps the caller's turn start with our own echo.**
   `callerTurnStartedMs ??= event.offsetMs` runs at the top of `onSpeechStart`, *above*
   the echo guard. When the guard then decides the segment was our own audio returning,
   the offset has already been recorded, and the caller's next turn is filed as having
   started at the moment of the echo. Recorded turn ordering is already known to be
   confusing on this path. One-line fix, but it changes recorded data, so not here.
   Owner: `turn-taking`.

3. **`RECOVERY_LINE` is one constant, spoken verbatim every time.** "Sorry, I did not
   catch that. Could you say it again?" — identically, however many times a call needs
   it. `capture.ts` already varies its second attempt for exactly this reason, and the
   charter names it. Fixing it is a behaviour change and belongs in its own commit.

4. **CAPTURING_ENTITY is unreachable on the primary path.** `start()` in `capture.ts`
   goes straight from `idle` to a readback, so the system never has a state in which it
   is gathering a value for the first time — capture is only ever *confirming* a value it
   already has a guess at. CAPTURING_ENTITY exists today only via the spelling and keypad
   fallbacks, both of which are reached after a rejection. That is not wrong, but the
   state's name promises more than the code does.

5. **ON_HOLD has no referent at all.** There is no hold in Ansa: no hold, no music, no
   resume. It is declared because the charter names it, and `machine.test.ts` asserts it
   stays unreachable so it cannot quietly become a state nobody can explain. Either build
   the hold or delete the state.

6. **The transcript watchdog survives the caller starting again.** It is armed at
   end-of-turn and cancelled only by `respondTo`, the first byte of audio, `stopSpeaking`
   or the next end-of-turn. A caller who starts a second utterance the detector never
   commits can therefore be interrupted, five seconds in, by "Sorry, I did not catch
   that" while they are still speaking. Narrow, but it is the failure mode the watchdog
   was written to prevent, pointed the other way.

7. **`pending` outlives a new agent turn.** Nothing in `sayNow`, `sayRecovery`,
   `repeatLast` or `respondTo` calls `clearPending`. In practice the 1.1s continuation
   timer always fires before anything else can matter, so this is theory rather than an
   observed bug — but `playFiller` refuses to play while `pending` is set, so a stale
   `pending` would silently disable the thinking-gap acknowledgement on the following
   turn.
