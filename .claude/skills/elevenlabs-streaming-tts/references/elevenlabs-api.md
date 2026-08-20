# ElevenLabs — full API reference for Ansa

Verified against elevenlabs.io/docs on **2026-08-20**. Sources fetched: `/docs/models`,
`/docs/api-reference/text-to-speech/stream`, `/docs/api-reference/text-to-speech/convert`,
`/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input`,
`/docs/api-reference/voices/search`, `/docs/api-reference/voices/get`,
`/docs/api-reference/voices/voice-library/get-shared`,
`/docs/api-reference/user/subscription/get`, `/docs/best-practices/latency-optimization`,
`/docs/best-practices/prompting/controls`.

## Models

| Model id | Latency | Languages | Real-time | Notes |
|---|---|---|---|---|
| `eleven_flash_v2_5` | ~75ms † | 32 | ✅ recommended | Agents Platform, interactive apps, bulk |
| `eleven_flash_v2` | ~75ms † | English only | ✅ recommended | |
| `eleven_v3_conversational` | ~280ms | 70+ | ✅ recommended | "most expressive model for realtime speech synthesis" |
| `eleven_multilingual_v2` | not stated | 29 | ❌ | Professional content, audiobooks, narration |
| `eleven_v3` | not stated | 70+ | ❌ | Character dialogue, audiobook production |
| `eleven_turbo_v2_5` | — | — | deprecated | Use `eleven_flash_v2_5` |
| `eleven_turbo_v2` | — | — | deprecated | Use `eleven_flash_v2` |

† "Excluding application & network latency."

Deprecation wording, verbatim:

> "The `eleven_turbo_v2_5` and `eleven_turbo_v2` models are functionally equivalent to the
> `eleven_flash_v2_5` and `eleven_flash_v2` models respectively, except the latency on the
> Flash models is lower on average. We recommend using the Flash models over Turbo models
> in all use cases."

No sunset date is published.

Other ids present in the models table (not TTS-for-telephony): `eleven_ttv_v3`,
`eleven_multilingual_sts_v2`, `eleven_multilingual_ttv_v2`, `eleven_english_sts_v2`,
`scribe_v2_realtime`, `scribe_v2`, `eleven_text_to_sound_v2`, `music_v2`, `music_v1`.

## `POST /v1/text-to-speech/{voice_id}/stream`

Auth header: `xi-api-key`.

### Query parameters

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `enable_logging` | boolean | `true` | |
| `optimize_streaming_latency` | integer, nullable | — | **deprecated** |
| `output_format` | enum | `mp3_44100_128` | see below |

### Body

| Field | Type | Default |
|---|---|---|
| `text` | string | required |
| `model_id` | string | `eleven_multilingual_v2` |
| `language_code` | string, nullable | — |
| `voice_settings` | object, nullable | — |
| `voice_settings.stability` | double | `0.5` |
| `voice_settings.similarity_boost` | double | `0.75` |
| `voice_settings.style` | double | `0` |
| `voice_settings.use_speaker_boost` | boolean | `true` |
| `voice_settings.speed` | double | `1` |
| `previous_text` / `next_text` | string, nullable | — |
| `seed` | integer, nullable | — |
| `apply_text_normalization` | enum `auto` \| `on` \| `off` | `auto` |

`speed` range, from the prompting-controls page, verbatim:

> "The default value is 1.0, which means that the speed is not adjusted. Values below 1.0
> will slow the voice down, to a minimum of 0.7. Values above 1.0 will speed up the voice,
> to a maximum of 1.2."

`stability` on v3 is described as three options — Creative, Natural, Robust — rather than a
free slider. Ranges for `similarity_boost`, `style` and `use_speaker_boost` are given only
as schema defaults; the docs do not state explicit bounds. **Unverified.**

`apply_text_normalization` is an ElevenLabs-side feature. Ansa does not rely on it —
`packages/normalizer` owns number and currency handling, and prompting or a vendor flag is
not a substitute for it.

### `output_format` values (stream endpoint)

`mp3_22050_32`, `mp3_24000_48`, `mp3_44100_32`, `mp3_44100_64`, `mp3_44100_96`,
`mp3_44100_128`, `mp3_44100_192`, `pcm_8000`, `pcm_16000`, `pcm_22050`, `pcm_24000`,
`pcm_32000`, `pcm_44100`, `pcm_48000`, **`ulaw_8000`**, `alaw_8000`, `opus_48000_32`,
`opus_48000_64`, `opus_48000_96`, `opus_48000_128`, `opus_48000_192`

The non-streaming `/v1/text-to-speech/{voice_id}` endpoint additionally offers `wav_8000`
… `wav_48000`.

Tier gating, verbatim from the `output_format` description:

> "MP3 with 192kbps bitrate requires you to be subscribed to Creator tier or above. PCM and
> WAV formats with 44.1kHz sample rate requires you to be subscribed to Pro tier or above.
> Note that the μ-law format (sometimes written mu-law, often approximated as u-law) is
> commonly used for Twilio audio inputs."

`ulaw_8000` carries **no tier restriction**.

**Repo verification (2026-08-07):** `output_format=ulaw_8000` returns raw μ-law 8kHz —
`content-type: audio/ulaw`, no container, 13 003 bytes = 1.63s at 8000 B/s.

## WebSocket TTS (`stream-input`) — not used by Ansa

```
wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
```

Query params: `model_id`, `output_format`, `inactivity_timeout`, `auto_mode`,
`sync_alignment`, `apply_text_normalization`, `authorization`, `single_use_token`,
`language_code`, `enable_logging`, `seed`, `enable_ssml_parsing`.

Initial message must set `text` to `" "` (a single space) and may carry `voice_settings`,
`generation_config.chunk_length_schedule` (default `[120, 160, 250, 290]`) and `xi-api-key`.
Flush with `"flush": true`. Close by sending `text: ""`.

Latency caveat, verbatim:

> "If you set a chunk schedule of 125 characters but only 50 arrive, the model stalls until
> additional characters come in."

`auto_mode` avoids that. No multi-context WebSocket endpoint is documented on this page.

## Latency guidance

- "Flash models deliver ~75ms inference speeds, making them ideal for real-time
  applications."
- "Higher audio quality output formats can increase latency. Be sure to balance your
  latency requirements with audio fidelity needs."
- TTFB by region: 100–150ms in North America, Europe, Southeast Asia; 150–200ms in South
  Asia and Northeast Asia.
- Three transports described: the regular endpoint (complete audio in one response),
  streaming endpoints ("progressively return audio as it is being generated in real-time"),
  and WebSockets ("perfect for applications with real-time text input (e.g. LLM outputs)").
- The latency-optimization page does **not** mention `optimize_streaming_latency` at all —
  its deprecation is recorded on the endpoint reference.

## Voices

### `GET /v1/voices/{voice_id}`
Still v1, still current. Only query param is `with_settings` (boolean, default `true`,
**deprecated — now ignored and will be removed**). The docs do not state the status code
for an unknown id; this repo treats **404 and only 404** as "no such voice".

### `GET /v2/voices` (list)
Current list endpoint.

| Param | Notes |
|---|---|
| `search` | name, description, labels, category |
| `page_size` | default 10, **max 100** |
| `voice_type` | `personal`, `community`, `default`, `workspace`, … |
| `category` | `premade`, `cloned`, `generated`, `professional` |
| `sort` | `created_at_unix`, `name` |
| `language`, `gender`, `age`, `accent` | metadata filters |
| `next_page_token` | cursor |

Response: `{ voices: [{ voice_id, name, category, settings, sharing, samples, … }],
has_more, total_count, next_page_token }`.

No deprecation banner sits on `/v1/voices`, but v2 is what the docs present. Ansa currently
calls `/v1/voices`.

### `GET /v1/shared-voices` (public library)
Current.

| Param | Default | Notes |
|---|---|---|
| `page_size` | 30 | **max 100** |
| `category` | — | `professional`, `famous`, `high_quality` |
| `gender`, `age`, `accent`, `language`, `search` | — | nullable |
| `sort` | `created_date` | also `usage_character_count_1y`, `trending`, `cloned_by_count` |
| `page` | 0 | |
| `use_cases` | — | list |
| `featured` | `false` | |

Confirmed fields on each voice: `free_users_allowed` (boolean, required),
`is_added_by_user` (boolean, nullable), `preview_url` (string, nullable), `use_case`
(string, required), `descriptive` (string, required). Plus `voice_id`, `name`, `accent`,
`gender`, `age`, `language`.

Note: Voice Library voices are not available via the API to free-tier users — which is what
`free_users_allowed` gates, and why reading it as "paid voice" on a paid plan would grey out
most of the library for an account that can add all of it.

### `GET /v1/user/subscription`
Current, not deprecated. `tier` values include `free`, `starter`, `creator`, `pro`,
`growing_business`, `scale_2024_08_10`, `grant_tier_1_2025_07_23`,
`grant_tier_2_2025_07_23`, `trial`, `enterprise`.

## Not verified

- Whether omitting `voice_settings` entirely falls back to the voice's *stored* settings
  rather than the schema defaults. Search results assert it; no ElevenLabs page fetched this
  session states it. Test on a real voice before relying on it.
- Explicit min/max for `similarity_boost`, `style`.
- Per-character or per-minute pricing (not fetched).
- Behaviour of `ulaw_8000` on `eleven_v3` / `eleven_v3_conversational` specifically.
