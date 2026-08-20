# Realtime session reference

Everything here was fetched on **2026-08-20**. Sources are named per section. Where a page
disagrees with another page, both are recorded.

Fetched from:
- `https://developers.openai.com/api/docs/guides/realtime`
- `https://developers.openai.com/api/docs/guides/realtime-conversations` (and `.md`)
- `https://developers.openai.com/api/docs/guides/realtime-transcription` (and `.md`)
- `https://developers.openai.com/api/docs/guides/realtime-websocket.md`
- `https://developers.openai.com/api/docs/guides/realtime-vad`
- `https://developers.openai.com/api/docs/guides/realtime-models-prompting.md`
- `https://developers.openai.com/api/reference/resources/realtime/client-events` (and `.md`)
- `https://developers.openai.com/api/docs/models/all.md`
- `https://developers.openai.com/api/docs/guides/speech-to-text.md`
- Local: `node_modules/.pnpm/openai@7.4.0/node_modules/openai/resources/realtime/realtime.d.ts`

The API-reference URL
`https://developers.openai.com/api/reference/resources/realtime/subresources/sessions/methods/create`
**404s**. The session schema had to be read off the client-events reference and the SDK types.

---

## 1. Connecting

| Intent | URL |
|---|---|
| Transcription only | `wss://api.openai.com/v1/realtime?intent=transcription` |
| Speech-to-speech | `wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1` |

Headers: `Authorization: Bearer <key>`; optional `OpenAI-Safety-Identifier: <user-id>`.

WebRTC and SIP are the other two transports. Ansa uses WebSocket because the audio arrives
from Twilio on a server-side socket already.

---

## 2. The session document (GA)

```jsonc
{
  "type": "session.update",
  "session": {
    "type": "transcription",          // or omitted / "realtime" for speech-to-speech
    "audio": {
      "input": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "noise_reduction": { "type": "…" },      // or null to disable
        "transcription": {
          "model": "gpt-live-transcribe",
          "prompt": "…",                          // free text describing the recording
          "keywords": ["…"],                      // literal terms; model-dependent
          "languages": ["en"],                    // ISO 639-1 / selected 639-3 / regional zh
          "delay": "low"                          // minimal | low | medium | high | xhigh
        },
        "turn_detection": { "type": "semantic_vad", "eagerness": "auto" }
      },
      "output": {                                 // speech-to-speech only
        "format": { "type": "audio/pcm" },
        "voice": "marin",
        "speed": 1.0                              // 0.25 – 1.5, default 1.0
      }
    },
    "instructions": "…",
    "tools": [ /* see §6 */ ],
    "tool_choice": "auto",                        // auto | none | required | forced tool
    "parallel_tool_calls": true,
    "max_output_tokens": "inf",                   // 1–4096 or "inf" (default)
    "truncation": "auto",                         // auto | disabled | retention-ratio object
    "output_modalities": ["audio"],
    "prompt": { /* … */ },
    "reasoning": { "effort": "low" },
    "include": [ /* … */ ]
  }
}
```

`RealtimeTranscriptionSessionCreateRequest` is the minimal variant: only `type`, `audio.input`
and `include`. Everything under `audio.output`, `tools`, `instructions`, `reasoning` etc. is
meaningless in a transcription session.

---

## 3. Audio formats

From `openai@7.4.0` `RealtimeAudioFormats`, which is the union
`AudioPCM | AudioPCMU | AudioPCMA`:

| `type` | `rate` | SDK doc comment |
|---|---|---|
| `"audio/pcm"` | `24000` | *"The PCM audio format. Only a 24kHz sample rate is supported."* |
| `"audio/pcmu"` | — | *"The audio format. Always `audio/pcmu`."* (G.711 μ-law) |
| `"audio/pcma"` | — | *"The audio format. Always `audio/pcma`."* (G.711 A-law) |

**Stale page warning.** `/api/reference/resources/realtime/client-events` still lists `pcm16`,
`g711_ulaw`, `g711_alaw`. Those are the retired Beta names. The Realtime conversations guide and
the installed SDK both use the `audio/*` MIME-style names. Believe the SDK.

Ansa's mapping (`packages/providers/listen/openai/src/protocol.ts`):

```ts
export const toInputFormat = (format: AudioFormat, asPcm = false): RealtimeAudioFormats => {
  if (asPcm) return { type: "audio/pcm", rate: PCM_RATE };
  if (format.encoding === "mulaw" && format.sampleRate === 8000) return { type: "audio/pcmu" };
  if (format.encoding === "linear16" && format.sampleRate === PCM_RATE) {
    return { type: "audio/pcm", rate: PCM_RATE };
  }
  throw new Error(`No realtime input format for ${format.encoding}@${format.sampleRate}Hz`);
};
```

Throwing is correct. Silently sending an unsupported rate produces a session that configures and
then transcribes nothing.

---

## 4. Turn detection

### `server_vad`

| Field | Meaning (verbatim where quoted) |
|---|---|
| `threshold` | 0–1. *"A higher threshold will require louder audio to activate the model, and thus might perform better in noisy environments."* |
| `prefix_padding_ms` | Audio included before the VAD-detected speech start. |
| `silence_duration_ms` | *"Duration of silence (in milliseconds) to detect speech stop. With shorter values turns will be detected more quickly."* |
| `create_response` | Conversation mode only. |
| `interrupt_response` | Conversation mode only. |

`idle_timeout_ms` is documented on `server_vad` by one search result and on `semantic_vad` by the
client-events reference. **The two sources disagree; treat its placement as unverified.** Its
described behaviour: applied after the last model response's audio finishes playing; if VAD does
not fire within it, the server emits `input_audio_buffer.timeout_triggered`, commits an empty
segment and triggers a response. Meaningless in transcription mode.

### `semantic_vad`

Uses a turn-detection model *"to semantically estimate whether the user has finished speaking,
then dynamically sets a timeout based on this probability."*

`eagerness`:

| Value | Behaviour |
|---|---|
| `auto` | Default. *Equivalent to `medium`.* |
| `low` | *"will let the user take their time to speak"* |
| `medium` | — |
| `high` | *"will chunk the audio as soon as possible"* |

*"In transcription mode, even if the model doesn't reply, it affects how the audio is chunked."*

**No per-eagerness timeout values are published.** Do not quote any.

### `null`

Manual commit via `input_audio_buffer.commit`. Required for `gpt-realtime-whisper`.

---

## 5. Events

Client → server (Ansa sends two): `session.update`, `input_audio_buffer.append`
(`{ type, audio: <base64> }`). Also available: `input_audio_buffer.commit`,
`input_audio_buffer.clear`, `conversation.item.create`, `conversation.item.truncate`,
`conversation.item.delete`, `conversation.item.retrieve`, `response.create`, `response.cancel`,
`output_audio_buffer.clear`.

Server → client, the ones Ansa parses:

| Type | Payload field used |
|---|---|
| `session.updated` | — (readiness) |
| `error` | `error.message` |
| `input_audio_buffer.speech_started` | `audio_start_ms` |
| `input_audio_buffer.speech_stopped` | `audio_end_ms` |
| `conversation.item.input_audio_transcription.delta` | `delta` |
| `conversation.item.input_audio_transcription.completed` | `transcript` (and `languages` on `gpt-transcribe`) |

Also in the SDK's server-event union and worth knowing: `input_audio_buffer.committed`,
`input_audio_buffer.timeout_triggered`, `conversation.item.input_audio_transcription.failed`,
`conversation.item.input_audio_transcription.segment`, `rate_limits.updated`.

Beta emitted transcription events under a different prefix. `parseEvent` keeps a `endsWith`
suffix match beside the exact GA name for exactly that reason.

---

## 6. Tools (conversation sessions)

Realtime uses the **flat** function shape:

```json
{
  "type": "function",
  "name": "function_name",
  "description": "…",
  "parameters": { "type": "object", "properties": {} }
}
```

The model emits `response.output[0].type: "function_call"` carrying `name`, `arguments` (a JSON
string) and `call_id`. Results go back as:

```json
{
  "type": "conversation.item.create",
  "item": { "type": "function_call_output", "call_id": "…", "output": "{…}" }
}
```

Chat Completions nests the same thing under `function`. They are not interchangeable.

---

## 7. Interruption and truncation

```json
{ "type": "conversation.item.truncate", "item_id": "item_1234",
  "content_index": 0, "audio_end_ms": 1500 }
```

Removes unplayed audio from the item so the model's context matches what the caller actually
heard. `{"type": "response.cancel"}` stops generation in progress.

Ansa's equivalent lives in the orchestrator against ElevenLabs — but the *principle* is the one
`CLAUDE.md` states: the unplayed portion of the agent's turn never happened, and must not stay
in history.

Out-of-band responses: `conversation: "none"` in `response.create`, with optional `metadata`.

---

## 8. Model ids

Realtime (speech-to-speech): `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, `gpt-realtime-2`,
`gpt-realtime-1.5`, `gpt-realtime`, `gpt-realtime-mini`, `gpt-4o-realtime-preview`,
`gpt-4o-mini-realtime-preview`.

The prompting guide describes only two: `gpt-realtime-2` ("advanced reasoning voice model",
start at `reasoning.effort: "low"`) and `gpt-realtime-1.5` ("fast, reliable non-reasoning
speech-to-speech"). The WebSocket example uses `gpt-realtime-2.1`. The models catalogue lists all
of the above. **The catalogue and the guides do not agree on which are current** — check the
catalogue before pinning one.

Transcription: `gpt-live-transcribe`, `gpt-transcribe`, `gpt-4o-transcribe`,
`gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize`, `gpt-realtime-whisper`, `whisper-1`.

Voices (speech-to-speech only): `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`,
`verse`, `marin`, `cedar`. Docs recommend `marin` and `cedar`. Custom voice objects
(`{ "id": "voice_1234" }`) are accepted. Voice cannot change once the model has produced audio.

**No documentation exists on which voices degrade over μ-law.** Unverified.

---

## 9. File-transcription limits (for the eval harness, not the call path)

- 25 MB max, formats mp3/mp4/mpeg/mpga/m4a/wav/webm.
- `stream=true` supported by `gpt-transcribe`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`,
  `gpt-4o-transcribe-diarize`; **not** `whisper-1`. Emits `transcript.text.delta` then
  `transcript.text.done`.
- `response_format`: `json` (default), `text`, `verbose_json` (whisper-1 only),
  `diarized_json` (diarize only).
- `timestamp_granularities` is whisper-1 only.
- whisper-1's `prompt` is capped at 224 tokens and it takes `language` (singular), not
  `languages`.
