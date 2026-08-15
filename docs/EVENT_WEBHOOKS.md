# Event webhooks

Ansa pushes your organisation a record of your own calls, at the points in a call's life
where you would want one. You host the endpoint; we are the client.

This is not the tool layer. A tool is something the agent decides to call in the middle of
a conversation, on a three-second budget, with a risk tier. An event is decided by the
platform after the fact, is never on the conversation's critical path, and cannot affect a
call in any way — the call writes a row and forgets it, and a separate worker delivers it.
If your receiver is down for an hour, your callers will not know.

---

## What you get

| Event | When |
|---|---|
| `call.ended` | The call is over, however it ended. Carries the conversation. |
| `call.transferred` | The agent handed the caller to a person. Carries the summary the person answering was given. |

A transferred call produces both: one when the transfer is dialled and one when the call
finishes.

### `call.ended`

```json
{
  "event": "call.ended",
  "occurredAt": "2026-08-08T14:22:31.004Z",
  "call": {
    "callId": "<the carrier's call id, the one on your phone bill>",
    "direction": "inbound",
    "dialled": "<the number they rang>",
    "caller": "<their number, or null if withheld>",
    "startedAt": "2026-08-08T14:20:02.000Z",
    "endedAt": "2026-08-08T14:22:31.004Z",
    "endReason": "caller hung up",
    "durationSeconds": 149,
    "configVersion": 7
  },
  "identifiers": {
    "callerName":   { "value": "…", "confirmed": true,  "status": "CONFIRMED" },
    "policyNumber": { "value": "…", "confirmed": false, "status": "UNCERTAIN" }
  },
  "transcript": [
    { "at": 1200, "speaker": "caller", "text": "…", "confidence": 0.82 },
    { "at": 2400, "speaker": "agent",  "text": "…", "confidence": null }
  ],
  "actions": [{ "name": "policy_lookup", "outcome": "ok" }],
  "transferredToHuman": false
}
```

**`confirmed` is the field to write your integration around.** `true` means the caller
heard the value read back and agreed to it, typed it on the keypad, or it came from a
system of record. `false` means the transcriber offered it and nobody has agreed to it
yet. Writing an unconfirmed value into a customer record is how a call reaches the wrong
account. `confidence` on a transcript line is the transcriber's own, over 8kHz telephone
audio; it is not a substitute for `confirmed`.

### `call.transferred`

```json
{
  "event": "call.transferred",
  "occurredAt": "2026-08-08T14:21:58.220Z",
  "call": { "…": "as above" },
  "reason": "the caller asked for a person",
  "summary": {
    "callerName": "…",
    "wanted": "…",
    "confirmed":   [{ "subject": "policy", "value": "…" }],
    "unconfirmed": [{ "subject": "policy", "value": "…" }],
    "actions": [{ "name": "…", "outcome": "ok" }],
    "stillOpen": "…",
    "callerTurns": 9
  }
}
```

`unconfirmed` is separated from `confirmed` for the same reason as above, and it is not
noise: it is what the caller may have said, so a person can ask about it rather than
starting from nothing. It must never be stated back to them as fact.

---

## Verifying that it came from us

Every delivery carries:

```
ansa-event-id:          <uuid, stable across retries — deduplicate on this>
ansa-event-type:        call.ended
ansa-organization-id:         <your organization id>
ansa-timestamp:         <unix seconds>
ansa-delivery-attempt:  <1, 2, 3 …>
ansa-signature:         v1=<hex>
```

The signature is:

```
HMAC-SHA256(secret, "v1." + timestamp + "." + event id + "." + raw request body)
```

over the **raw body bytes**, before any JSON parsing. Compare it in constant time, and
reject anything whose `ansa-timestamp` is more than a few minutes old — that check is what
stops a captured delivery being replayed at you next week, and it only works because the
timestamp is inside the signed string rather than merely beside it.

```python
expected = hmac.new(secret, f"v1.{ts}.{event_id}.".encode() + raw_body, "sha256").hexdigest()
ok = hmac.compare_digest(expected, signature.removeprefix("v1=")) and abs(now - int(ts)) < 300
```

The attempt number is deliberately **not** signed, so a retry of the same delivery sends
byte-identical body and signature. That is what makes deduplicating on `ansa-event-id`
safe.

---

## Delivery

- **At least once.** Answer `2xx` and we stop. Anything else and we try again.
- **Retries** back off exponentially from about ten seconds, with jitter, up to fifteen
  minutes between attempts, for eight attempts by default. A `5xx`, a `408`, a `429`, a
  timeout or a refused connection is retried; any other `4xx` is not, because it means we
  are sending something you will never accept and hammering you would make our bug your
  incident.
- **A receiver that stays down trips a circuit** and is left alone for a while. It trips
  per receiver, so your other endpoint is unaffected.
- **Order is not guaranteed.** Two events from the same call can arrive in either order.
  Use `occurredAt` and `ansa-event-id`.
- **Every attempt is recorded**, with the exact bytes sent, the status you answered and
  the error if there was one. If you believe you never received something, we can show you
  what left and when.
- Your endpoint must be **HTTPS** and on the allowlist in your configuration. We refuse to
  post anywhere else, including anywhere a redirect from your own server points at.

---

## Configuration

Published with the rest of your configuration and versioned with it, so every delivery
records which version of these rules was in force when the payload was built.

```json
{
  "events": {
    "egress": { "allowedHosts": ["hooks.example.com"] },
    "subscriptions": [
      {
        "name": "crm",
        "url": "https://hooks.example.com/ansa",
        "events": ["call.ended", "call.transferred"],
        "signingSecretRef": "crm_hook",
        "timeoutMs": 10000,
        "maxAttempts": 8
      }
    ]
  }
}
```

The signing secret itself never appears in that file. It is sealed separately:

```
ORGANIZATION_ID=… node tools/organization/config.mjs credential crm_hook signing <shared-secret>
```

Add `"credentialRef": "…"` to a subscription if your endpoint also wants an
`Authorization` header or an API key header on top of the signature.

---

## Redaction

**Nothing is redacted unless you ask for it.** The payload is a record of a conversation
your own agent had with your own customer. You are the data controller; withholding your
own data from you on a judgement we made about your compliance posture is not our call,
and it would break the obvious uses — the CRM that needs the policy number, the ticketing
system that needs the callback number.

If you want masking, ask for it. Per organization:

```json
{ "events": { "redaction": { "categories": ["captured-identifier", "card-number"] } } }
```

…or per receiver, which overrides the organization rule for that receiver alone — the shape most
organisations actually want, where the CRM gets everything and the analytics vendor does
not:

```json
{ "name": "analytics", "…": "…",
  "redaction": { "categories": ["captured-identifier", "digit-sequence", "email"] } }
```

Anything masked is replaced with `[redacted:<category>]`, so you can tell that something
was removed and what kind of thing it was, rather than finding a sentence with a hole in
it and assuming the transcriber failed.

### The categories

| Category | What it catches |
|---|---|
| `captured-identifier` | Every value this call recorded as an identifier — the caller's name, policy number, customer id — in each of the forms the transcriber wrote it down, including spaced and hyphenated spellings of the same reference. |
| `email` | Email addresses. |
| `card-number` | 13–19 digit runs that pass a Luhn check. |
| `digit-sequence` | Any run of `minDigits` digits or more (default 4). Spaces and hyphens between digits do not break the run. |
| `spoken-digit-sequence` | A run of `minSpokenDigits` digit *words* or more (default 4) — "four eight two nine one" — which is how a reference arrives when somebody reads it out. |

`minDigits` and `minSpokenDigits` are settable alongside `categories`.

### What redaction will not do, and you should assume it does not

This is the part worth reading twice. Redaction here works on two things: values this call
*knew* were identifiers, and *shapes*. Anything that is neither will go through.

- **Names in prose are not caught by shape, and never will be.** A name has no structure
  that distinguishes it from any other word. `captured-identifier` catches a name that the
  agent captured and confirmed; it does not catch one the caller mentioned in passing —
  a spouse, a broker, the colleague they spoke to last week.
- **Dates of birth are not caught.** A date has a shape; a date of *birth* does not have a
  shape that distinguishes it from the date of an accident, a renewal or last Tuesday.
  Masking every date would gut the payload; masking none is what we do. If dates of birth
  matter to your obligations, treat the whole transcript as containing one.
- **Addresses are not caught.** Same reason. `digit-sequence` will take the number off the
  front of a street address and leave the rest.
- **Health, financial and other sensitive disclosures are not caught.** "I have been off
  work since the surgery" is special-category data under NDPR and has no shape at all.
- **`digit-sequence` will over-mask.** With the default of four it takes amounts, years and
  quantities as well as references. That is the trade for a rule that cannot know what a
  number means, and it is why `captured-identifier` is the one to reach for first.
- **`spoken-digit-sequence` covers single digits only** — the words for 0–9 plus "oh",
  "nought", "double" and "triple". Tens and teens are excluded deliberately: "twenty",
  "hundred" and "thousand" appear in ordinary talk about money and dates far more often
  than in a spoken reference, and including them would mask sentences containing no
  identifier at all.
- **A transcript may be wrong.** The transcriber mishears, and a misheard identifier is a
  string nothing will recognise as one. Redaction operates on what was written down, not
  on what was said.

If your obligation is "this system must never hold a customer's identifiers", redaction is
the wrong tool for it and you should not subscribe to `call.ended` at that receiver at all.
Subscribe to `call.transferred`, which carries a summary rather than a conversation, or
give that receiver its own subscription with `captured-identifier` on and accept that the
transcript is still prose somebody spoke.

### What is never sent, whatever you configure

Credentials and authentication material. Any field whose name looks like a secret —
`authorization`, `token`, `api_key`, `password`, `signature`, `cookie` and the rest — is
removed unconditionally, and that is not a setting. It is not your customer's personal
data and it is not yours to receive; it is material held in trust, and it appearing in an
outbound payload would be a defect.

---

## Seeing what happened

The internal viewer has a delivery log at `/viewer/deliveries`, showing every queued
delivery, its status, how many attempts it took, what your endpoint answered, and the
exact bytes that were sent. Settled deliveries are kept for 30 days; a delivery still
retrying is never purged.
