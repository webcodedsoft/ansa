---
name: twilio-media-streams
description: Use when integrating or debugging Twilio in Ansa — Media Streams WebSocket frames (connected/start/media/dtmf/stop/mark/clear), the <Connect><Stream> TwiML verb and custom <Parameter> values, placing outbound calls via the REST Calls API with inline Twiml, answering-machine detection (MachineDetection, AsyncAmd), call status callbacks, warm transfer with <Dial answerOnBridge>, or X-Twilio-Signature webhook validation.
---

# Twilio Media Streams in Ansa

Twilio is the carrier for both directions. Everything below the answer is shared between
inbound and outbound; what differs is how the call *begins* and how the organization is
resolved.

All API facts re-verified against twilio.com/docs on 2026-08-20. Items marked
**(repo observation)** come from this codebase's comments and probes.

## The files

| Path | What lives there |
|---|---|
| `packages/providers/telephony/src/twilio/protocol.ts` | Frame parsing, frame encoding, all TwiML rendering, status-callback parsing. Pure. |
| `packages/providers/telephony/src/twilio/twilio-media-stream.ts` | `CallMediaStream` over one socket. `send`/`mark`/`clear`/`hangUp`. |
| `packages/providers/telephony/src/twilio/twilio-telephony.provider.ts` | `TelephonyProvider`: webhook verification, `placeCall`, `transferToNumber`, `endCall`, frame loop. |
| `packages/providers/telephony/src/twilio/twilio-numbers.ts` | Number lookup/provisioning. |
| `apps/api/src/telephony/media.gateway.ts` | Owns the `ws` server; knows sockets, not the wire format. |
| `apps/api/src/telephony/ws-media-socket.ts` | `ws` → `MediaSocket`. |
| `apps/api/src/outbound/place.ts` | The **only** door for outbound. Consent check lives here. |

`streamSid`, `CallSid`, `MachineDetection`, `answerOnBridge` and every other Twilio word
stop at `packages/providers/telephony/`. The gateway sees `CallMediaStream`.

## Inbound vs outbound

**Inbound.** Twilio POSTs the voice webhook → `parseInboundCall` reads `CallSid`/`To`/`From`
→ we resolve the organization from the dialled number (R7.3) → `renderAnswer` returns
`<Connect><Stream>` with the organization on a `<Parameter>` → the socket opens.

**Outbound.** We already know the organization — it asked for the call.
`placeOutboundCall` checks consent, then `placeCall` POSTs to the REST API with the TwiML
**inlined** in the `Twiml` parameter. No webhook round trip, and no enumerable tenant id in
a query string that anyone reaching the tunnel could probe. The organization travels out
with the origination and comes back as a `<Parameter>` on the media socket. **Do not
resolve it a second time from the caller ID.**

## The TwiML

```ts
export const renderConnectStream = (
  mediaStreamUrl: string,
  parameters: Readonly<Record<string, string>> = {},
): string => { /* … */ };
```

Produces:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response><Connect>
  <Stream url="wss://…/media">
    <Parameter name="organizationId" value="…" />
    <Parameter name="direction" value="outbound" />
  </Stream>
</Connect></Response>
```

- **`<Connect><Stream>` is bidirectional. `<Start><Stream>` only forks audio to you and
  cannot play anything back.** With `<Connect>`, Twilio does not execute subsequent TwiML
  until your server closes the WebSocket.
- **The document deliberately ends after `</Connect>`.** No next verb means the carrier
  hangs up when the socket closes — that is how `hangUp()` works with no REST credentials.
- **`url` must be `wss` and query parameters are not allowed on it.** That is why config
  travels as `<Parameter>`, not `?organizationId=`.
- **`<Parameter>`: combined `name` + `value` length must be under 500 characters.**
- **One bidirectional stream per call.** Unidirectional streams can be up to four per call,
  a limit shared with other audio-forking features.
- **DTMF works only inbound (Twilio → us) on a bidirectional stream**, and not at all on
  unidirectional streams.

Custom parameters come back on the `start` frame as `start.customParameters`, **always as
strings**. `parseFrame` drops any non-string rather than coercing it: a half-parsed tenant
id is worse than none.

## The frames

Full JSON for every message, both directions:
[`references/media-streams-messages.md`](references/media-streams-messages.md).

Twilio → us: `connected`, `start`, `media`, `dtmf`, `stop`, `mark`.
Us → Twilio: `media`, `mark`, `clear`.

Audio in both directions is base64 `audio/x-mulaw` at 8000 Hz, 1 channel. `media.timestamp`
is a **string** of milliseconds since the stream opened; `parseFrame`'s `readNumber`
handles both string and number because the carrier is not consistent about it.

## mark and clear — the part people get wrong

> "Send a `mark` event message after sending a `media` event message to be notified when
> the audio that you have sent has been completed." … "Twilio sends back a `mark` event
> with a matching `name` when the audio ends (**or if there is no audio buffered**)."

> "Send a `clear` message if you want to interrupt the audio… This empties all buffered
> audio and **causes any `mark` messages to be sent back** to your WebSocket server."

> "The media messages are buffered and played in the order received."

Three consequences that this codebase depends on:

1. **You can write audio faster than real time.** Twilio buffers it. So "how much did the
   caller actually hear" is *not* how much you sent — it is which marks came back. The
   orchestrator encodes the answer into the mark name — `seq:bytesSent`, emitted
   sub-sentence roughly every 200ms of audio:

   ```ts
   if (durationMs(current.bytesSent - markedAt, stream.format) >= 200) {
     markedAt = current.bytesSent;
     stream.mark(`${current.seq}:${current.bytesSent}`);
   }
   ```
2. **`clear` flushes pending marks back at you.** After a barge-in those late marks would
   inflate `bytesHeard` for a turn the caller stopped hearing. `orchestrator.ts` sets
   `turn = null` before `stream.clear()`, and `onMark` returns early when
   `Number(seq) !== current.seq`. Keep that ordering.
3. **A mark also comes back when nothing was buffered.** An empty synthesis still resolves
   the turn; do not treat a mark as proof audio was played.

Barge-in order in `stopSpeaking`, and it is load-bearing:

```ts
current.cancelLlm?.();
current.synthesis?.cancel();
current.queue.length = 0;
cancelFiller();
cancelWatchdog();
stream.clear();
```

Stop producing before discarding. Audio synthesised in the gap lands at the carrier
*after* the clear and plays over the caller.

## Placing a call

`buildCallForm` in `twilio-telephony.provider.ts`. `POST
/2010-04-01/Accounts/{AccountSid}/Calls.json`, HTTP Basic with the account SID as username,
form-encoded.

- **`Twiml` is capped at 4000 characters.** `renderConnectStream` is small, but a caller
  adding `<Parameter>` values must stay inside it.
- `StatusCallbackEvent` defaults to `completed` only. We append all four —
  `initiated`, `ringing`, `answered`, `completed` — because ringing and no-answer are
  exactly what distinguishes outbound from inbound.
- `Timeout` (ring) defaults to 60s, max 600.
- A non-2xx is surfaced, not swallowed: an unowned `From` and a malformed destination both
  land there and both are configuration errors far cheaper to read now than to infer from a
  call that never rings.

The response `status` is `queued` or `initiated`. **It has not rung, let alone been
answered.** Never start the orchestrator on a 201.

## Answering-machine detection

| Parameter | Values / range | Default |
|---|---|---|
| `MachineDetection` | `Enable`, `DetectMessageEnd` | none |
| `AsyncAmd` | `true`, `false` | `false` |
| `AsyncAmdStatusCallback` / `…Method` | URL / `POST` | — |
| `MachineDetectionTimeout` | 3–59 s | 30 |
| `MachineDetectionSpeechThreshold` | 1000–6000 ms | 2400 |
| `MachineDetectionSpeechEndThreshold` | 500–5000 ms | 1200 |
| `MachineDetectionSilenceTimeout` | 2000–10000 ms | 5000 |

`AnsweredBy` with `Enable`: `machine_start`, `human`, `fax`, `unknown`.
With `DetectMessageEnd`: `machine_end_beep`, `machine_end_silence`, `machine_end_other`,
`human`, `fax`, `unknown`.
Async callback fields: `CallSid`, `AccountSid`, `AnsweredBy`, `MachineDetectionDuration`.

Ansa sends `MachineDetection=DetectMessageEnd` + `AsyncAmd=true`:

- **Synchronous detection withholds the media stream until it decides — measured at 6.9
  seconds of dead air before the first audio frame (repo observation).** The caller says
  hello into nothing. Asynchronous connects immediately and reports the verdict to a
  callback.
- `DetectMessageEnd` rather than `Enable`, because knowing a machine answered is not useful
  on its own — we need to know when its greeting *finished*.
- **AMD is the agent's own switch (migration 0020), expressed by withholding the callback
  URL, not by a flag.** Twilio only runs detection when it has somewhere to report it. See
  `apps/api/src/outbound/place.ts`.
- ⚠ **Vendor caveat worth checking on a real call:** Twilio's AMD page says asynchronous
  detection "uses one of four available per-call streams, potentially conflicting with
  Media Streams, SIPREC, or Real-Time Transcription features," while the Media Streams page
  says a bidirectional stream is limited to one per call. These two statements are in
  tension with what this repo does (`AsyncAmd=true` alongside `<Connect><Stream>`), and it
  has not been observed failing here. If outbound audio ever goes missing on a call with
  AMD on, this is the first thing to test.

## Transfer

`renderDialTransfer` — three details, each chosen against a specific failure:

- **`answerOnBridge="true"`.** Without it the caller's leg is treated as connected the
  instant the dial starts and they hear *nothing* while the human's phone rings. Silence
  over two seconds reads as a dropped call (R6.2).
- **`url` on `<Number>`.** TwiML fetched when the *person* answers, played to them alone
  before the legs are joined. Without it the human picks up mid-sentence and asks for the
  name the caller spent four minutes spelling.
- **A verb after `</Dial>`.** A document that ends at the dial hangs up on the caller when
  nobody answers. They have already been failed once.

`transferToNumber` replaces the live call's instruction, which **ends our media stream the
moment it resolves**. Anything the caller is owed — "let me get a colleague" — must have
been *heard* before this is called, not queued behind it. The escalation path waits for the
mark; see `apps/api/src/handoff`.

`renderSay` (the whisper) deliberately has no `<Gather>` and no next verb: the carrier joins
the legs the moment the document finishes.

## Webhook signature

`verifyWebhook` delegates to `validateRequest` from the `twilio` package. Twilio HMAC-SHA1s
the full URL *including query string*, with POST form params sorted alphabetically and
appended, keyed by the auth token.

For **JSON** bodies Twilio appends a `bodySHA256` query parameter and you must use
`validateRequestWithBody` with the raw body string — do not extract JSON properties and
treat them as form parameters. Ansa's webhooks are form-encoded today; if a JSON webhook is
ever added, `verifyWebhook` needs the other helper.

`verifySignatures: false` exists only for local testing. Leaving it false in front of a
public tunnel lets anyone on the internet originate calls against this service.

## Status callbacks

`parseStatusCallback` accepts `initiated`, `ringing`, `in-progress`, `completed`, `busy`,
`no-answer`, `failed`, `canceled`. Duration is `CallDuration` on the completed callback and
`Duration` elsewhere; both absent while in flight. `SipResponseCode` appears on terminal
events.

Twilio reports `Direction` as `outbound-api` or `outbound-dial` depending on how the call
was created. Both are simply "outbound" above the adapter — leaking the distinction upward
would be a vendor word in orchestration code.

**Inbound calls record no carrier duration**, because a status callback is configured on
the *number* rather than set in TwiML and nothing reports one. The gateway therefore times
the media stream itself and lets the carrier's figure overwrite it if it ever arrives.

## The idiom

Arrow consts (`func-style: expression`); NestJS classes are exempt because decorators
require them. `TwilioMediaStream` is a class for that reason; everything in `protocol.ts`
is an arrow const.

Parsers return `null` for anything malformed or unrecognised — "a carrier adding a new
event type must not take a call down."

```ts
export const encodeClear = (streamSid: string): string =>
  JSON.stringify({ event: "clear", streamSid });
```

Every outbound frame is built by a named encoder in `protocol.ts`. Do not hand-roll
`JSON.stringify({event: …})` at a call site.

## Things that are not what you'd guess

1. **You cannot put query parameters on the `<Stream url>`.** Config travels as
   `<Parameter>`, capped at 500 chars per name+value pair.
2. **`clear` sends your pending marks *back* to you.** Guard on turn identity or you will
   credit the caller with hearing audio you just threw away.
3. **A mark returns even when nothing was buffered.**
4. **Twilio buffers outbound media.** Bytes sent ≠ audio heard, ever. Marks are the only
   truth.
5. **The `Twiml` parameter caps at 4000 characters.**
6. **`Timeout` on a REST call means *ring* timeout, not request timeout.** Default 60s.
7. **A 201 from `POST /Calls` means queued, not ringing.**
8. **Twilio does not sell Nigerian numbers.** `AvailablePhoneNumbers/NG/{Local|Mobile|TollFree}`
   returns **404** — that is Twilio's answer for a country it does not sell, not a bug
   (repo observation; see `docs/STACK_DECISION.md`). The plan is a Nigerian SIP trunk over
   Twilio SIP interconnect, which keeps this adapter and changes only where calls
   originate.
9. **`From` on an inbound webhook can be the literal string `anonymous`** for a withheld
   number, not an absent field.
10. **Bidirectional streams carry only the inbound track.** If you need the outbound track
    (the agent's own audio) for recording, that is a second, unidirectional `<Start><Stream>`
    against the four-stream budget — not a flag on this one.

## Debugging

- No audio to the caller → check `streamSid` on the outbound frames matches the `start`
  frame's, then check whether a `clear` raced the media.
- Call drops the instant the agent finishes → something closed the socket and there is no
  TwiML after `</Connect>`. That is by design for `hangUp()`; it is a bug anywhere else.
- Outbound call rings but the agent never speaks → the orchestrator was started before the
  `start` frame, or `<Connect>` was rendered as `<Start>`.
- 401 on `POST /Calls` → Basic auth username must be the **account SID**, not an API key SID.
- Signature failures behind a tunnel → the URL Twilio signed includes the public hostname
  and the query string; validate against that, not the internal one.
