import { Buffer } from "node:buffer";

import type { AudioFormat } from "@ansa/shared";

import { durationMs } from "../audio-duration";
import { VendorSynthesisStream } from "../synthesis-stream";
import type { SynthesisRequest, SynthesisStream, TtsProvider } from "../types";

/**
 * How the voice is driven, when the deployment wants to say.
 *
 * Every field is optional and omitted when unset — deliberately, and it is the one thing
 * to understand before adding to this. ElevenLabs merges a `voice_settings` object over
 * the voice's *stored* settings, so sending a partial object silently overrides whatever
 * was tuned on the voice itself in their console. A cloned brand voice carries settings
 * somebody chose; sending `stability` from an env default would quietly replace them.
 *
 * So: nothing here is sent unless it was configured, and the object is not sent at all
 * when none of it was.
 */
export interface VoiceSettings {
  /** 0-1. Lower is more expressive; too low is erratic on an 8kHz line. */
  readonly stability?: number;
  readonly similarityBoost?: number;
  readonly style?: number;
  readonly useSpeakerBoost?: boolean;
  /**
   * 0.7-1.2, and outside that the request fails rather than clamping — which on a call is
   * a silent turn. The agent's own published rate wins over this; this is the fallback for
   * agents that set none.
   */
  readonly speed?: number;
}

export interface ElevenLabsOptions {
  readonly apiKey: string;
  readonly modelId?: string;
  readonly baseUrl?: string;
  readonly voiceSettings?: VoiceSettings;
  /** Injected in tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";

/**
 * `eleven_flash_v2_5` — roughly 75ms of model inference, and the only sensible default for
 * a live call.
 *
 * This was `eleven_turbo_v2_5`, which is now deprecated: the vendor's own position is to
 * use Flash over Turbo in all cases, and Turbo costs 250-300ms against Flash's 75. On a
 * budget where the whole turn is meant to land under a second, that is a quarter of it
 * spent on nothing.
 *
 * What Flash gives up is graceful handling of numbers, currency and dates — it is a
 * smaller model. That is not a problem here, because nothing reaches TTS unnormalised:
 * `@ansa/normalizer` has already turned twenty thousand naira into words before this
 * adapter sees it, so the model is never asked to interpret a numeral.
 *
 * Not `eleven_v3` and not `eleven_multilingual_v2`. Both are far too slow for a call, and
 * finding either here would be a defect rather than a preference.
 */
const DEFAULT_MODEL_ID = "eleven_flash_v2_5";

/* No `optimize_streaming_latency`. It is deprecated on the streaming endpoint, with no
   replacement parameter — model choice and transport are what replaced it. The brief asks
   for `optimize_streaming_latency=3`; sending a deprecated parameter buys nothing and
   dates the code. */

/** See the LLM adapter: a hung connection must fail loudly rather than hang the turn. */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Map our format onto the vendor's name for it. Deliberately narrow: an unsupported
 * format throws rather than falling back to something that would need transcoding,
 * because a silent transcoding hop is exactly the cost R4.2.4 exists to avoid.
 */
export const toOutputFormat = (format: AudioFormat): string => {
  if (format.encoding === "mulaw" && format.sampleRate === 8000) return "ulaw_8000";
  if (format.encoding === "linear16" && format.sampleRate === 16000) return "pcm_16000";
  if (format.encoding === "linear16" && format.sampleRate === 22050) return "pcm_22050";
  throw new Error(
    `ElevenLabs has no native output for ${format.encoding}@${format.sampleRate}Hz`,
  );
};

/**
 * The vendor's snake-case body, or nothing at all.
 *
 * Returns undefined when neither the deployment nor the agent set anything, so the request
 * carries no `voice_settings` key and the voice keeps its own.
 */
const toVoiceSettingsBody = (
  configured: VoiceSettings | undefined,
  agentSpeakingRate: number | undefined,
): Record<string, unknown> | undefined => {
  const speed = agentSpeakingRate ?? configured?.speed;
  const body: Record<string, unknown> = {};
  if (configured?.stability !== undefined) body["stability"] = configured.stability;
  if (configured?.similarityBoost !== undefined) {
    body["similarity_boost"] = configured.similarityBoost;
  }
  if (configured?.style !== undefined) body["style"] = configured.style;
  if (configured?.useSpeakerBoost !== undefined) {
    body["use_speaker_boost"] = configured.useSpeakerBoost;
  }
  if (speed !== undefined) body["speed"] = speed;
  return Object.keys(body).length === 0 ? undefined : body;
};

export const createElevenLabsTts = (options: ElevenLabsOptions): TtsProvider => {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;
  const configured = options.voiceSettings;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: "elevenlabs",

    synthesize(request: SynthesisRequest): SynthesisStream {
      const stream = new VendorSynthesisStream();

      const run = async (): Promise<void> => {
        try {
          const outputFormat = toOutputFormat(request.format);
          /* The agent's own published rate wins over the deployment default: one is a
             property of this agent's voice, the other is a fallback for agents with none. */
          const voiceSettingsBody = toVoiceSettingsBody(configured, request.speakingRate);
          const url =
            `${baseUrl}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}/stream` +
            `?output_format=${outputFormat}`;

          const response = await doFetch(url, {
            method: "POST",
            signal: AbortSignal.any([stream.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
            headers: {
              "xi-api-key": options.apiKey,
              "Content-Type": "application/json",
              Accept: "audio/*",
            },
            body: JSON.stringify({
              text: request.text,
              model_id: modelId,
              /* Omitted entirely when nothing was set, rather than sent with defaults. The
                 two are not the same to ElevenLabs: a `voice_settings` object is merged
                 over the voice's own stored settings, so sending one made of defaults
                 replaces whatever was tuned on a cloned voice. Absence leaves it alone. */
              ...(voiceSettingsBody === undefined ? {} : { voice_settings: voiceSettingsBody }),
            }),
          });

          if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error(
              `ElevenLabs returned ${response.status}${detail.length > 0 ? `: ${detail.slice(0, 200)}` : ""}`,
            );
          }
          if (response.body === null) {
            throw new Error("ElevenLabs returned no response body");
          }

          const reader = response.body.getReader();
          let bytes = 0;

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (stream.isCancelled) {
              await reader.cancel().catch(() => undefined);
              return;
            }
            if (value === undefined || value.length === 0) continue;

            // Offset is where this chunk starts inside the utterance, so it is stamped
            // before the chunk's own bytes are counted.
            stream.emitAudio({
              data: Buffer.from(value),
              offsetMs: Math.round(durationMs(bytes, request.format)),
            });
            bytes += value.length;
          }

          stream.emitDone();
        } catch (error: unknown) {
          // An abort is a barge-in, not a fault. Nothing downstream should hear about it.
          if (stream.isCancelled) return;
          stream.emitError(error instanceof Error ? error : new Error(String(error)));
        }
      };

      // Deferred by a microtask so the caller's onAudio/onDone/onError, registered
      // synchronously after this returns, are attached before anything can be emitted.
      // Without it, a failure raised before the first await — an unsupported format,
      // say — is emitted to nobody and the turn goes silent with no error anywhere.
      queueMicrotask(() => {
        void run();
      });

      return stream;
    },
  };
};
