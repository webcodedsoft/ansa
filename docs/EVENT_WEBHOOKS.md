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

**No value is redacted, and there is no setting for it.** The payload is a record of a
conversation your own agent had with your own customer. You are the data controller, and
withholding your own data from you on a judgement we made about your compliance posture was
never our call. It also broke the obvious uses — the CRM that needs the policy number, the
ticketing system that needs the callback number.

Between Slice 6a and 2026-08-15 this section described a per-organisation and per-receiver
masking capability with five categories. That capability was withdrawn and the code deleted.
Two things follow that you should act on:

- **A `redaction` block in your stored configuration is now ignored.** It is not an error and
  it will not stop your events being delivered — it simply does nothing. Reading your
  configuration back and saving it removes the block.
- **Payloads that were partly masked are now complete.** If a receiver was relying on masking
  to stay within its own obligations, that receiver is now getting identifiers it did not get
  before. Check it before your next call, not after.

The honest framing, which the old section buried under a table of categories: masking never
worked well enough to rely on. Names in prose have no shape; dates of birth are
indistinguishable from any other date; addresses are not catchable; "I have been off work
since the surgery" is special-category data under NDPR with no shape at all; and a misheard
identifier is a string nothing recognises. A capability that catches some of your obligations
and silently misses the rest is worse than none, because it invites you to believe the
problem is handled.

If your obligation is "this system must never hold a customer's identifiers", the answer is
not to mask the payload. Do not subscribe that receiver to `call.ended` at all — subscribe
it to `call.transferred`, which carries a summary rather than a conversation.

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
