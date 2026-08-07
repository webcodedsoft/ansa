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

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--url` | `http://127.0.0.1:3222` | Base URL of the API |
| `--mode` | `unsigned` | `unsigned`, `signed`, or `badsig` |
| `--frames` | `120` | 160-byte μ-law frames to send (120 = 2.4s of audio) |
| `--hold-ms` | `1000` | How long to keep the socket open after the last frame, so outbound audio can arrive |

`TWILIO_AUTH_TOKEN` is read from the environment for `--mode signed`.

A `403` is reported and exits 0 — for `unsigned` and `badsig` against an API with
verification on, rejection is the correct outcome. Exit 1 means something genuinely broke.
