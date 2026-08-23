---
name: intron-sahara-listen
description: Use when integrating or debugging Intron speech-to-text in Ansa — the wss://infer.voice.intron.io/stt/v1/stream WebSocket, PARTIAL_TRANSCRIPT vs COMMITTED_TRANSCRIPT, base64 PCM16 framing, the mu-law to PCM transcode, code-switched Nigerian language codes (ha/ig/yo/pcm), the 300-second session ceiling and mid-call reconnect, or when deciding between Intron and Deepgram for the words half of the listen layer.
---

# Intron in Ansa

Intron is a candidate for the **transcriber** half of the listen layer, and only that half.
It has no turn detection, so Deepgram Flux stays the turn detector — this is composition two
in CLAUDE.md: "Provider A transcribes, provider B detects turns, same audio fanned out to
both. Likely outcome. Higher cost, better result."

All API facts below were read from docs.voice.intron.io on 2026-08-23. Nothing here has been
run against the live API yet; every line marked **(unverified)** is a gap that a probe must
close before it is trusted.

## Why it is on the table

Deepgram Flux is American-English-centric. On the calls of 2026-08-23 it heard "Sikiru" as
"Abijo" and then as "BQ BQ", both at confidence 1.000, and the caller spent the whole call
spelling. Intron trains on African speech and offers code-switched Nigerian language models.
That is the entire case for it, and it is a strong one.

## What it costs, stated up front

Three things Ansa relies on today do not exist in this API:

| Ansa needs | Intron | Consequence |
|---|---|---|
| Word-level confidence | **Not returned** | `mustConfirm`'s `when-uncertain` branch is dead again. It is the only branch that reads confidence, and null is not low. |
| Keyterm boosting | **Not supported** | 61 published keyterms stop having any effect. Also means no keyterm can corrupt a name, which is what "BQ BQ" was. |
| Streaming finals per turn | **COMMIT closes the socket** | See below — this is the design problem. |

CLAUDE.md: "STT/Transcriber implementations must expose word-level confidence and keyterm
injection. If a vendor can't satisfy the interface, that's information about the vendor —
don't reshape the interface around it and don't leak the gap upward." Intron satisfies
neither. `Transcript.confidence` becomes null, exactly as the OpenAI adapter already does at
`packages/providers/listen/openai/src/listen-session.ts:178`.

## The wire

```
wss://infer.voice.intron.io/stt/v1/stream
  ?sample_rate=8000
  &bit_rate=16
  &num_channels=1
  &use_language_asr_input=en

Authorization: Bearer <INTRON_API_KEY>
```

| Param | Default | Notes |
|---|---|---|
| `sample_rate` | 16000 | 8000 is **(unverified)** — the docs list no allowed set. Probe before building on it. |
| `bit_rate` | 16 | PCM bit depth. |
| `num_channels` | 1 | |
| `use_language_asr_input` | `en` | See language codes below. |

## Audio framing

Not binary frames. Audio goes **base64 inside a JSON message**:

```json
{ "message_type": "INPUT_AUDIO_CHUNK", "audio_base_64": "<base64 PCM16 LE>", "ack_id": 1 }
```

- **PCM16 little-endian.** Twilio gives us 8 kHz mu-law, so a transcode is required. The
  OpenAI adapter already faces this — `AppConfig.openAiSendPcm` and the `sendAsPcm` flag
  through `media.gateway.ts` — and that is the precedent to follow rather than a new one.
- **Chunk size 1 KB to 32 KB.** Twilio media frames are 160 bytes of mu-law (20 ms), so
  frames must be coalesced before sending or every one is under the floor.
- Base64 inflates by a third, and JSON framing adds more. This is a heavier wire than
  Deepgram's raw binary.

## Messages back

```json
{ "message_type": "SESSION_CREATED", "session_id": "…", "credit_balance": 120.0,
  "configs": { "sample_rate": 16000, "bit_rate": 16, "num_channels": 1,
               "use_prompt_id": null, "use_language_asr_input": "en",
               "use_language_asr_output": "en" } }

{ "message_type": "PARTIAL_TRANSCRIPT", "transcript": "…" }

{ "message_type": "COMMITTED_TRANSCRIPT", "transcript_id": "…",
  "transcript_text": "…", "audio_len": 10 }

{ "message_type": "SESSION_TIME_LIMIT_EXCEEDED" }
```

`SESSION_CREATED` echoes the config the server actually applied. Read `configs.sample_rate`
back and log it — that is how you find out whether 8000 was honoured or silently coerced.

## The design problem: COMMIT ends the session

> "Send `COMMIT` when done streaming audio. Receive `COMMITTED_TRANSCRIPT` and the
> connection closes."

A conversational agent needs a stable final per caller turn, many times per call. This API
gives one committed transcript per *connection*. Two ways out, and neither is free:

**A socket per turn.** Connect, stream the turn, COMMIT, take the final, close. Correct
finals, but pays connection setup on every turn — on the path where `turn_to_audio` is
currently 221 ms, and CLAUDE.md calls latency a correctness property.

**One socket, partials only.** Stream continuously, never COMMIT until the call ends, and
take the newest `PARTIAL_TRANSCRIPT` when Flux fires `onEndOfTurn`. No extra latency, and it
is exactly the correlate-by-timestamp shape the composite path already has. The risk is that
a partial has not had whatever rescoring the commit applies — **(unverified)**, and the
thing to measure first.

Prefer the second, and prove the partial's quality against the committed one on the same
audio before committing to it.

## Session ceiling

- **300 s lifetime**, then `SESSION_TIME_LIMIT_EXCEEDED`. No resume mechanism.
- **60 s idle gap.**

Ansa's calls already run to 177 s. A five-minute ceiling means reconnecting mid-call, and
the reconnect must be invisible: open the next socket before the current one dies, not
after, or the caller's words fall on the floor during the handover. `listen-session.ts` in
the Deepgram package has the redial and buffering machinery to copy.

Nothing in the turn layer may notice this. Flux holds the turn events on its own socket and
is unaffected — which is a good argument for the split rather than against it.

## Language codes

`use_language_asr_input` takes a code. The Nigerian ones are code-switched with English,
which is what Nigerian callers actually speak:

| Code | Language |
|---|---|
| `en` | English |
| `pcm` | Pidgin-English |
| `yo` | Yoruba-English |
| `ig` | Igbo-English |
| `ha` | Hausa-English |

Also available: `af`, `ak`, `am`, `lg`, `rw`, `sw`, `wo`, `zu`.

Which one a call should use is a real product question and not obviously `en`. A Lagos
caller may code-switch mid-sentence, and the language is chosen at connect time, before
anyone has spoken. **(unverified)** whether `en` handles code-switching acceptably or
whether `pcm` is the better default for Nigerian traffic. Measure, do not guess — this is
the Gate A question that `docs/STACK_DECISION.md` still records as unmeasured.

## Where the code goes

Follow the Deepgram package's shape exactly; the seam is already the right one.

| Path | What belongs there |
|---|---|
| `packages/providers/listen/intron/src/protocol.ts` | URL building, message parsing, mu-law to PCM16, chunk coalescing. Pure, no socket. |
| `packages/providers/listen/intron/src/listen-session.ts` | Session, reconnect before the 300 s ceiling, buffering. Implements `TranscriptSource` only. |
| `apps/api/src/telephony/ws-intron-socket.ts` | The only place `ws` meets Intron. Bearer header lives here. |

Implement `TranscriptSource` from `apps/api/src/telephony/composite-listen.ts`, **not**
`ListenSession`. That type exists precisely so a words provider has no turn events to
ignore: "A words provider now has no turn events to ignore, so the mistake cannot be made
from a config file."

`LISTEN_WORDS=intron` selects it in `media.gateway.ts`'s `openListen`. The `=== "deepgram"`
branch returns the single socket; everything else composes.

Vendor strings — `INPUT_AUDIO_CHUNK`, `COMMITTED_TRANSCRIPT`, `infer.voice.intron.io` — must
not appear outside those three files. CLAUDE.md rule 2.

## Other endpoints, not used by the call path

REST STT (`/docs/stt/file-upload-sync`, `/file-upload`, `/file-status`) is batch and is
disqualifying for a call — but it is the right tool for the **eval harness**, which scores a
fixed corpus offline and does not care about latency. TTS and the Voice Bots API are out of
scope; Ansa's TTS is ElevenLabs and Ansa *is* the voice bot.

## Before trusting any of this

Four probes, in order. Each is cheap and each can kill the plan:

1. Does `sample_rate=8000` connect, and does `SESSION_CREATED.configs` echo 8000 back?
2. Is a `PARTIAL_TRANSCRIPT` at end-of-turn as good as the `COMMITTED_TRANSCRIPT` for the
   same audio?
3. On the same Nigerian audio, does Intron beat Flux on names and numbers? That is the
   whole reason for the change and it is the one number nobody has.
4. What does a mid-call reconnect at 300 s cost the caller?
