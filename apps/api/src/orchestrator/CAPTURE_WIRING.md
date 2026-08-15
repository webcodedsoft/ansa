> **APPLIED 2026-08-08** in "Capture releases the turn it is not handling". Sections 1-6
> are wired. Section 7 (`expecting`) is deliberately not: who decides *when* to ask
> belongs to the conversation director, and nothing decides it yet. The "what is still
> unproven" list at the bottom is still unproven.

# Wiring `capture.ts` into `orchestrator.ts`

Written by the `entity-capture` agent while four other agents held `orchestrator.ts`. Every
change below is in that one file and nothing here has been applied. `capture.ts` compiles
and its tests pass against the orchestrator as it stands today, so nothing is broken by
*not* doing these — but three of them are bugs and the first one is live.

---

## 1. P0 — the escalation black hole. Two lines.

**Confirmed on a real call at 12:12:42 on 2026-08-08: once capture escalated, the agent
went silent for the rest of the call.**

`captureHandled` returns `true` unconditionally, so "capture ran" was read as "capture
handled it". Once the state reached `escalate`, `advance` returned the state unchanged
with nothing to say, the orchestrator still reported the turn as handled, `respondTo`
never ran, and the caller — who had just been told a colleague was coming — talked to a
dead line. Nothing resets `capture` afterwards, because both `capture = idle` assignments
live inside the `result.captured !== null` branch.

`CaptureResult` now carries `handled: boolean`. It is false when capture is not involved:
a terminal state, or a turn holding nothing worth capturing.

`say === null` was considered as a substitute and is not one — it is also null on the turn
a value is confirmed, which capture very much has handled.

In `captureHandled`, immediately after `capture = result.state;`:

```ts
    const result = advance(capture, { kind: "speech", text });
    capture = result.state;

    // Capture is not involved in this turn — nothing to capture, or capture is over.
    // Releasing rather than swallowing is what keeps an escalated caller audible: the
    // state stays `escalate` so they are never dragged back into a readback, and the
    // model answers them like any other caller.
    if (!result.handled) return false;
```

This also closes the same bug one state earlier. The existing gate lets a turn through
when `nameFrom(text) !== null`, or when `worthConfirming` is true; if `start()` then
declines the value — a conversational quantity, or a cue with no value behind it — the
old code still returned `true` and swallowed the turn.

`escalate` stays terminal for capture and is never re-entered. That is deliberate and it
has a cost: a caller who escalated on their name will not have a later policy number
captured either. Reversing that means giving the orchestrator a reason to reset `capture`
to `idle` — a new entity being asked for, say — and it should be a deliberate decision by
whoever owns the call-level state machine, not a side effect here.

## 2. The gate — replace three lines with one

The current gate can only reach capture through a name cue or a digit run, so email,
address, date, time and amount are unreachable no matter what the caller says.

```ts
// Today
if (capture.kind === "idle" && nameFrom(text) === null) {
  const value = parseSpokenDigits(text);
  if (value === null || !worthConfirming(value, text)) return false;
}
const result = advance(capture, { kind: "speech", text });
```

```ts
// Instead: capture classifies the turn itself, and `handled` reports the answer.
const result = advance(capture, {
  kind: "speech",
  text,
  confidence: transcript.confidence,   // see §3
  at: Date.now(),
});
capture = result.state;
if (!result.handled) return false;
```

`worthConfirming` and `nameFrom` stay exported with their current signatures so this can
be done in either order.

## 3. Pass the transcriber's confidence through

`advance` takes an optional `confidence` on the speech event. It is used in exactly one
direction: below a floor, an identifier gets one spoken attempt before the keypad instead
of two, and a conversational quantity gets confirmed when it otherwise would not have
been. There is no path on which it removes a check — see the header comment in
`capture.ts` and the `mustConfirm` tests.

`Transcript.confidence` is `number | null` and null is passed through unchanged. Null is
not low.

## 4. Redact sensitive values before logging — this is a leak

```ts
if (capture.kind === "confirming") {
  record.event("entity_candidate", { subject: capture.subject, value: capture.value });
```

A NIN, a BVN and a one-time code all reach this line in the clear, and **that is now the
intended behaviour.** `logSafe` masked them until 2026-08-15; it was removed along with
R5.2.4 on the rule that no caller value is redacted anywhere. The organisation is the data
controller and the event log is their record of their own call.

What follows is worth stating rather than discovering: the event log and the transcript
viewer hold national identity numbers and one-time codes in full, and are identifying data
at rest. `recordings/`, `eval/runs/` and `eval/results/` are gitignored for the same reason,
and the log deserves the same treatment.

## 5. Tell the model what kind of thing was confirmed

```ts
// Today — shape-sniffs the value, so a confirmed date becomes "My number is 2026-08-14."
const asName = /^[A-Za-z][A-Za-z' -]*$/.test(result.captured);
respondTo(text, asName ? `…My name is ${result.captured}.` : `…My number is ${result.captured}.`);
```

```ts
// Instead — the kind is now on the result.
respondTo(text, confirmedUtterance(result.capturedKind, result.captured));
```

Same in the `onDigit` handler, where `capturedKind` is also populated.

## 6. Keypad state now carries its subject

`onDigit` never constructs a keypad state so nothing changes there, but if anything
starts to, `{ kind: "keypad", subject, digits, attempt }` is the shape. The subject is
what lets the shape check fire on a caller who types nine digits of an eleven-digit BVN
perfectly clearly.

## 7. `expecting(kind)` — the agent asking first

**Wired, 2026-08-15, by `orchestrator/form.ts`.** The decision this section said belonged
to a conversation director now comes from the agent's own configuration: the operator's
list of fields, in their order, armed at the greeting and again after each answer.

Two things about that wiring are not obvious from the code:

- **The engine does not speak the question.** `expecting()` returns an `ask` string and the
  orchestrator throws it away. The task layer already tells the model what to collect, so
  speaking both would ask the caller the same thing twice — once conversationally and once
  as a form. What is taken from `expecting` is the `awaiting` state, and therefore
  `parseDirected`. Directed parsing was always the point of this section; the sentence is
  the model's to phrase.
- **It arms only from idle**, so it can never discard a readback in progress.

A field may also carry the operator's own `pattern` and `attempts`. Those run *after* the
readback, deliberately: the engine's job is to establish what was said, and asking "did I
hear PM eight five nine two" about a value that is about to be rejected is the only way the
caller learns the agent heard them correctly and their number is still wrong. Checking
first would say "sorry, say that again" to someone who said it perfectly.

The rest of this section is the original argument, kept because it is why the seam is
shaped this way.

---

Unwired, and it is the answer to the state-machine agent's observation that there is no
"gathering" state on the primary path. That observation is **correct** about the code as
it was: `start()` went from idle straight to a readback, so the agent only ever confirmed
a value the caller had volunteered — it never asked for one.

`awaiting` is that state. It is reachable today from inside `capture.ts` when a value
fails its shape check (a short NIN sends the caller back to the question), but the
agent-asks-first path needs a call site:

```ts
const asked = expecting("email");
capture = asked.state;
if (asked.say !== null) sayNow(asked.say, "asking:email");
```

It matters because directed parsing is much better than speculative parsing. "The
fourteenth", "Sikiru" and a letter-only reference are unrecognisable in free speech and
unambiguous in answer to a question, and `parseDirected` is only used from `awaiting`.

Who decides *when* to ask belongs to the conversation director, not here. `ENTITY_POLICY`
carries an `ask` string and a `label` for each kind so that decision does not need to
invent phrasing.

---

## What is still unproven

Everything below needs a phone call, not a test run.

- **No entity type other than name and reference has been heard on a real call.** The
  parsers are exercised against written text; a Nigerian caller saying an email address
  over 8kHz mu-law is a different problem and may well break them.
- **`UNCERTAIN_BELOW = 0.7` is a guess and is labelled as one in the code.** Nobody has
  measured what either transcriber reports on a real Nigerian line. It is set high
  deliberately: a wrong value there can only make the agent check more often than it
  needed to. It should be tuned once `tools/stt-compare` has run on a genuine recording,
  and not before.
- **The am/pm assumption and the day-first date reading are guesses by construction.**
  Both are said out loud in the readback so a caller can catch them, which is the whole
  defence. Whether callers actually catch them is a question for a call.
- **Email capture over a bad line is the highest-risk of the new kinds.** The spelling
  fallback rebuilds the local part and keeps the domain, which is right in principle and
  has never been heard.
