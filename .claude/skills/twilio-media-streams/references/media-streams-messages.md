# Twilio Media Streams — full message and parameter reference

Verified against twilio.com/docs on **2026-08-20**. Sources fetched:
`/voice/media-streams`, `/voice/media-streams/websocket-messages`, `/voice/twiml/stream`,
`/voice/answering-machine-detection`, `/voice/api/call-resource`,
`/usage/webhooks/webhooks-security`.

## Messages from Twilio → your server

### connected
```json
{
  "event": "connected",
  "protocol": "Call",
  "version": "1.0.0"
}
```

### start
```json
{
  "event": "start",
  "sequenceNumber": "1",
  "start": {
    "accountSid": "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "streamSid": "MZXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "callSid": "CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "tracks": [ "inbound" ],
    "mediaFormat": {
        "encoding": "audio/x-mulaw",
        "sampleRate": 8000,
        "channels": 1 },
    "customParameters": {
     "FirstName": "Jane",
     "LastName": "Doe",
     "RemoteParty": "Bob"
   }
  },
  "streamSid": "MZXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

`customParameters` values are always strings. `streamSid` appears both nested and at the
top level; `parseFrame` prefers the nested one and falls back.

### media
```json
{
 "event": "media",
 "sequenceNumber": "3",
 "media": {
   "track": "outbound",
   "chunk": "1",
   "timestamp": "5",
   "payload": "no+JhoaJjpz..."
 },
 "streamSid": "MZXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

`timestamp` is milliseconds since the stream started, sent as a **string**. `payload` is
base64 `audio/x-mulaw` 8000 Hz.

### dtmf
```json
{
  "event": "dtmf",
  "streamSid":"MZXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "sequenceNumber":"5",
  "dtmf": {
      "track":"inbound_track",
      "digit": "1"
  }
}
```

DTMF is supported **only** on bidirectional streams, and only inbound (Twilio → your
server). Unidirectional streams do not carry DTMF at all.

### stop
```json
{
 "event": "stop",
 "sequenceNumber": "5",
 "stop": {
    "accountSid": "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "callSid": "CAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  },
  "streamSid": "MZXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

### mark (echoed back)
```json
{
 "event": "mark",
 "sequenceNumber": "4",
 "streamSid": "MZXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
 "mark": {
   "name": "my label"
 }
}
```

## Messages from your server → Twilio

### media
```json
{
  "event": "media",
  "streamSid": "MZXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "media": {
    "payload": "a3242sa..."
  }
}
```

> "The payload must be encoded `audio/x-mulaw` with a sample rate of `8000`" and base64
> encoded. "The audio can be of any size." "The media messages are buffered and played in
> the order received."

### mark
```json
{
 "event": "mark",
 "streamSid": "MZXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
 "mark": {
   "name": "my label"
 }
}
```

> "Send a `mark` event message after sending a `media` event message to be notified when
> the audio that you have sent has been completed." … "Twilio sends back a `mark` event
> with a matching `name` when the audio ends (or if there is no audio buffered)."

### clear
```json
{
 "event": "clear",
 "streamSid": "MZXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

> "Send a `clear` message if you want to interrupt the audio that has been sent in various
> `media` messages. This empties all buffered audio and causes any `mark` messages to be
> sent back to your WebSocket server."

## `<Stream>` TwiML noun

| Attribute | Notes |
|---|---|
| `url` | Required. "A relative or an absolute URL." **Only `wss` is supported; query parameters aren't allowed.** |
| `name` | Optional, unique per call. Lets `<Stop><Stream name="…"/>` target it. Unidirectional only in practice. |
| `track` | Optional, **unidirectional only**: `inbound_track` (default), `outbound_track`, `both_tracks`. |
| `statusCallback` | Optional absolute URL; fired when streams start, stop or error. |
| `statusCallbackMethod` | `GET` or `POST` (default `POST`). |

Child element `<Parameter name="…" value="…" />`: "The combined length of each
`<Parameter>` `name` and `value` attributes must be under 500 characters."

### `<Connect><Stream>` vs `<Start><Stream>`

- `<Start><Stream>` — unidirectional fork. Execution continues to subsequent TwiML
  immediately. Cannot play audio back.
- `<Connect><Stream>` — bidirectional. "Twilio doesn't execute subsequent TwiML
  instructions" until your server closes the WebSocket. Bidirectional streams cannot be
  stopped with `<Stop><Stream>`; ending the call ends the stream.

### Limits

- Unidirectional: "you can stream up to four tracks at a time on a Call. This four-track
  limit is shared with other Twilio features that fork audio."
- Bidirectional: "you can have only one Stream per Call."
- "Each Media Stream is associated with one WebSocket connection."
- Bidirectional streams carry only the inbound track.

## `POST /2010-04-01/Accounts/{AccountSid}/Calls.json`

| Parameter | Notes |
|---|---|
| `To` / `From` | `From` must be a Twilio number or verified caller ID. |
| `Twiml` | "TwiML instructions for the call Twilio will use without fetching Twiml from url parameter. **Max 4000 characters**" |
| `Url` | Alternative to `Twiml`; absolute URL returning TwiML. |
| `StatusCallback` | URL. |
| `StatusCallbackMethod` | `GET`/`POST`, default `POST`. |
| `StatusCallbackEvent` | `initiated`, `ringing`, `answered`, `completed`. **Default is `completed` only.** Repeat the parameter for each. |
| `MachineDetection` | `Enable` or `DetectMessageEnd`. |
| `AsyncAmd` | `true`/`false`, default `false`. |
| `AsyncAmdStatusCallback` / `AsyncAmdStatusCallbackMethod` | URL / default `POST`. |
| `Timeout` | Ring timeout in seconds. Default 60, max 600. |
| `Record` | Boolean. |

Auth: HTTP Basic, username = account SID.

### Call status values
`queued`, `initiated`, `ringing`, `in-progress`, `completed`, `busy`, `failed`,
`no-answer`, `canceled`.

### Status callback fields
`CallSid`, `CallStatus`, `Direction` (`inbound`, `outbound-api`, `outbound-dial`),
`CallDuration` (terminal events only), `SipResponseCode` (terminal events).

## Answering-machine detection

| Parameter | Range | Default |
|---|---|---|
| `MachineDetection` | `Enable`, `DetectMessageEnd` | none |
| `AsyncAmd` | `true`, `false` | `false` |
| `MachineDetectionTimeout` | 3–59 seconds | 30 |
| `MachineDetectionSpeechThreshold` | 1000–6000 ms | 2400 |
| `MachineDetectionSpeechEndThreshold` | 500–5000 ms | 1200 |
| `MachineDetectionSilenceTimeout` | 2000–10000 ms | 5000 |

- `Enable`: "return an AnsweredBy value as soon as it identifies the called party."
- `DetectMessageEnd`: immediate for humans; for machines the result is "returned only once
  the end of the greeting is reached."

`AnsweredBy` values:
- with `Enable`: `machine_start`, `human`, `fax`, `unknown`
- with `DetectMessageEnd`: `machine_end_beep`, `machine_end_silence`, `machine_end_other`,
  `human`, `fax`, `unknown`

`AsyncAmdStatusCallback` webhook fields: `CallSid`, `AccountSid`, `AnsweredBy`,
`MachineDetectionDuration` (milliseconds).

> Twilio's note: synchronous detection "doesn't consume forked streams"; asynchronous
> detection "uses one of four available per-call streams, potentially conflicting with
> Media Streams, SIPREC, or Real-Time Transcription features."

## Webhook signature validation

> Twilio "combines, then hashes, the following data: Your account auth token, the
> `x-twilio-signature` header value from Twilio, the Webhook URL set in Twilio, [and] All
> request parameters" using "the HMAC-SHA1 hashing algorithm using your account auth token
> as the secret key."

- Form-encoded: the complete URL **including query parameters**, with form params "sorted
  alphabetically and appended to the URL when calculating the signature."
- JSON: "Twilio appends a `bodySHA256` query parameter to your webhook URL. The parameter
  value is a SHA-256 hash of the raw JSON request body." … "Don't extract individual JSON
  properties or treat them as form parameters. Use your SDK's JSON-specific validation
  method (for example, `validateRequestWithBody`) and pass the raw request body string."

Node helpers: `validateRequest()` for form-encoded, `validateRequestWithBody()` for JSON.

## Not documented / unverified

- Message rate limits on the media WebSocket.
- Explicit pacing guidance for audio sent to Twilio (the docs say only that it is buffered
  and played in order).
- Maximum payload size for one outbound `media` message ("The audio can be of any size").
- Whether `AsyncAmd` genuinely contends with a bidirectional `<Connect><Stream>` for the
  four-stream budget. The two doc pages are in tension; this repo runs both together and
  has not observed a failure.
