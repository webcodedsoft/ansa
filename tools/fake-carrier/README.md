# fake-carrier

Impersonates the telephony carrier: POSTs the inbound-call webhook, reads the TwiML that
comes back, opens the media socket that TwiML points at, and streams μ-law frames down it.

It exists so the call path can be exercised without ngrok, a provisioned number, or
telephony minutes. A slice is still not done until a real phone call proves it — this
shortens the loop before that call, it does not replace it.

It found two defects on its first run that the unit tests could not: the webhook answering
`201` where the carrier requires `200`, and a build that silently stopped emitting a file.

## Use

```sh
pnpm build

# Terminal 1 — the API, signature checking off for local work
PORT=3222 PUBLIC_BASE_URL=http://127.0.0.1:3222 TWILIO_VERIFY_SIGNATURES=false \
  node apps/api/dist/main.js

# Terminal 2
node tools/fake-carrier/dist/main.js --url http://127.0.0.1:3222
```

With signature checking on, pass the same token the API is running with:

```sh
TWILIO_AUTH_TOKEN=<token> node tools/fake-carrier/dist/main.js --mode signed
```

## Fifty at once

```sh
node tools/fake-carrier/dist/main.js --url http://127.0.0.1:3222 --calls 50
```

Above one call the per-frame narration is dropped and a summary replaces it: how many failed,
and the p50, p95 and max time the carrier waited for TwiML. All fifty are placed at once rather
than ramped, because R5.5 asks whether the targets hold under fifty concurrent calls and a ramp
answers an easier question.

Each call carries its own `CallSid` and `streamSid`. They used to be constants, which is right
for one call and wrong for fifty — the API keys a call on the carrier's own id, so fifty calls
sharing one id are one call reported fifty times, and the run would measure nothing while
looking like it worked.

**What the summary does not measure.** Time to TwiML is the part visible from outside the
process. Turn-to-audio, which is the number the product is judged on, is measured inside the
API and written to `latencies` — read it there for the same run. A harness that reported its
own guess at it would be reporting the harness.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--url` | `http://127.0.0.1:3222` | Base URL of the API |
| `--mode` | `unsigned` | `unsigned`, `signed`, or `badsig` |
| `--frames` | `120` | 160-byte μ-law frames to send (120 = 2.4s of audio) |
| `--hold-ms` | `1000` | How long to keep the socket open after the last frame, so outbound audio can arrive |
| `--pace-ms` | `2` | Milliseconds between frames. The default is ten times faster than a phone; pass `20` to imitate a real call's timing. |
| `--to` | `+2348099999999` | The number dialled. The default is a test-range number no organisation holds, so it exercises the unregistered path. Pass a number a real agent answers to reach that agent's transcriber, prompt and form. |

`TWILIO_AUTH_TOKEN` is read from the environment for `--mode signed`.

A `403` is reported and exits 0 — for `unsigned` and `badsig` against an API with
verification on, rejection is the correct outcome. Exit 1 means something genuinely broke.
