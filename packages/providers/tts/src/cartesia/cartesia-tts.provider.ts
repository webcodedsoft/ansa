import { Buffer } from "node:buffer";

import type { AudioFormat } from "@ansa/shared";

import { durationMs } from "../audio-duration";
import { VendorSynthesisStream } from "../synthesis-stream";
import type { SynthesisRequest, SynthesisStream, TtsProvider } from "../types";

/**
 * Cartesia Sonic, as the second half of a TTS A/B.
 *
 * Here to be compared against ElevenLabs on real Nigerian calls, not to replace it. The
 * case for looking: Cartesia publishes first-byte times in the 40-90ms range against
 * Flash's ~75, which is close to a wash — but a much tighter spread under load, and
 * consistency is what a caller notices. One slow turn in twenty is the one that gets
 * remembered; a better average with a fatter tail is worse on a phone line than a slightly
 * slower, flatter one.
 *
 * Whether that holds from Lagos is the whole question, and neither vendor's documentation
 * can answer it — both measure from US datacentres. The percentiles from Phase 3a are the
 * instrument: `tts_first_byte` carries `provider`, so a week of mixed traffic reads as two
 * distributions rather than one blended number.
 *
 * **Switching provider means republishing the voice.** Voice ids are per-vendor and both
 * are uuids, so nothing can tell them apart by shape: an agent still carrying an
 * ElevenLabs id will be refused here on its first turn. That surfaces as the recovery line
 * rather than as silence, which is the correct failure — but it is a failure, and TASKS.md
 * records what a production A/B would need instead.
 */

export interface CartesiaOptions {
  readonly apiKey: string;
  readonly modelId?: string;
  readonly baseUrl?: string;
  /**
   * Deployment default, used only for agents that published no rate of their own.
   *
   * Cartesia accepts 0.6-1.5 where ElevenLabs accepts 0.7-1.2, and the console validates
   * the narrower pair — so every rate an agent can publish is valid for both vendors, and
   * the A/B is not quietly comparing two different speaking speeds.
   */
  readonly speed?: number;
  /** Injected in tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.cartesia.ai";

/**
 * `sonic-3`, and the brief's bare "Sonic" is no longer a model id.
 *
 * The current line is `sonic-3.5`, `sonic-3` and `sonic-latest`; `sonic-2` and
 * `sonic-turbo` are gone. `sonic-latest` is deliberately not the default — a floating tag
 * moves the thing being measured underneath the measurement, and this adapter exists to
 * produce a comparison. Pin it, and change the pin on purpose.
 */
const DEFAULT_MODEL_ID = "sonic-3";

/**
 * Cartesia dates its API rather than numbering it, and the header is required on every
 * request. Pinned for the same reason the model is: an undated client gets whatever the
 * vendor ships next, which is how a working integration breaks with no deploy.
 */
const API_VERSION = "2026-08-14";

/** The same budget as the other adapters: a hung connection fails loudly rather than hanging the turn. */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Our format as Cartesia's `output_format` object.
 *
 * `container: "raw"` throughout — a WAV header on a stream would reach the carrier as
 * forty-four bytes of audio. Narrow on purpose: an unsupported format throws rather than
 * falling back to something that needs a transcoding hop, which is the cost R4.2.4 exists
 * to keep visible.
 */
const CARTESIA_SAMPLE_RATES: readonly number[] = [8000, 16000, 22050, 24000, 44100, 48000];

export const toCartesiaOutputFormat = (format: AudioFormat): Record<string, unknown> => {
  /* mu-law is 8kHz and nothing else, on the wire and at this vendor. Letting another rate
     through would produce audio the carrier plays at the wrong speed rather than an error,
     which is the worst of the three outcomes. */
  if (format.encoding === "mulaw" && format.sampleRate === 8000) {
    return { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 };
  }
  if (format.encoding === "linear16" && CARTESIA_SAMPLE_RATES.includes(format.sampleRate)) {
    return { container: "raw", encoding: "pcm_s16le", sample_rate: format.sampleRate };
  }
  throw new Error(`Cartesia has no native output for ${format.encoding}@${format.sampleRate}Hz`);
};

interface CartesiaFrame {
  readonly type: string;
  readonly data?: unknown;
  readonly message?: unknown;
  readonly errorCode?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * One SSE line as a frame, or null for anything that is not one.
 *
 * Comment lines, the `event:` half of a frame and the blank separators all arrive here and
 * none of them matters: Cartesia puts the discriminator inside the JSON rather than on the
 * `event:` line, so `data:` is the only line worth reading.
 */
export const parseCartesiaLine = (line: string): CartesiaFrame | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice("data:".length).trim();
  if (payload === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    /* A frame we cannot read is not a reason to fail the turn. The stream carries timestamp
       and phoneme frames nobody here asked for, and the vendor is free to add more; dropping
       what we do not recognise is the behaviour that survives that. */
    return null;
  }
  if (!isRecord(parsed) || typeof parsed["type"] !== "string") return null;
  return {
    type: parsed["type"],
    data: parsed["data"],
    message: parsed["message"],
    errorCode: parsed["error_code"],
  };
};

const describeError = (frame: CartesiaFrame): string => {
  const message = typeof frame.message === "string" ? frame.message : "";
  const code = typeof frame.errorCode === "string" ? ` (${frame.errorCode})` : "";
  return message === "" ? `Cartesia sent an error frame${code}` : `Cartesia: ${message}${code}`;
};

export const createCartesiaTts = (options: CartesiaOptions): TtsProvider => {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: "cartesia",

    synthesize(request: SynthesisRequest): SynthesisStream {
      const stream = new VendorSynthesisStream();

      const run = async (): Promise<void> => {
        try {
          const outputFormat = toCartesiaOutputFormat(request.format);
          /* The agent's own published rate wins over the deployment default — one is a
             property of this agent's voice, the other a fallback for agents with none.
             The same precedence as the ElevenLabs adapter, deliberately: an A/B whose two
             sides resolve the speaking rate differently is measuring the adapters. */
          const speed = request.speakingRate ?? options.speed;

          const response = await doFetch(`${baseUrl}/tts/sse`, {
            method: "POST",
            signal: AbortSignal.any([stream.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Cartesia-Version": API_VERSION,
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify({
              model_id: modelId,
              transcript: request.text,
              voice: request.voiceId,
              output_format: outputFormat,
              /* Base language only. A locale is where Nigerian English would be asked for
                 if Cartesia offered one; it does not, which is a finding for the comparison
                 rather than something to work around here. */
              language: "en",
              // Omitted entirely when nothing was set, so the model keeps its own pace.
              ...(speed === undefined ? {} : { generation_config: { speed } }),
            }),
          });

          if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error(
              `Cartesia returned ${response.status}${detail.length > 0 ? `: ${detail.slice(0, 200)}` : ""}`,
            );
          }
          if (response.body === null) throw new Error("Cartesia returned no response body");

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let bytes = 0;
          let finished = false;

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (stream.isCancelled) {
              await reader.cancel().catch(() => undefined);
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            /* SSE frames are newline-delimited and one read can split a frame mid-line, so
               the trailing partial stays in the buffer until the rest arrives. Decoding half
               a base64 payload would put a burst of noise on the call. */
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const frame = parseCartesiaLine(line);
              if (frame === null) continue;

              if (frame.type === "error") throw new Error(describeError(frame));

              if (frame.type === "done") {
                finished = true;
                break;
              }

              if (frame.type !== "chunk" || typeof frame.data !== "string") continue;
              const audio = Buffer.from(frame.data, "base64");
              if (audio.length === 0) continue;

              // The offset is where this chunk starts inside the utterance, so it is
              // stamped before the chunk's own bytes are counted.
              stream.emitAudio({
                data: audio,
                offsetMs: Math.round(durationMs(bytes, request.format)),
              });
              bytes += audio.length;
            }

            if (finished) {
              // Nothing further is coming. Cancelling now closes the connection rather than
              // leaving it draining a body we have finished reading.
              await reader.cancel().catch(() => undefined);
              break;
            }
          }

          /* A `done` frame is the vendor saying the utterance is complete; the body simply
             ending is the connection closing, which after audio means the same thing and
             before any audio means a turn that produced nothing. Both settle here, because
             a synthesis that never calls back is a silent call — the one failure this
             layer exists to prevent. */
          stream.emitDone();
        } catch (error: unknown) {
          // An abort is a barge-in, not a fault. Nothing downstream should hear about it.
          if (stream.isCancelled) return;
          stream.emitError(error instanceof Error ? error : new Error(String(error)));
        }
      };

      /* Deferred by a microtask so the caller's onAudio/onDone/onError, registered
         synchronously after this returns, are attached before anything can be emitted.
         Without it a failure raised before the first await — an unsupported format, say —
         reaches nobody and the turn goes silent with no error anywhere. */
      queueMicrotask(() => {
        void run();
      });

      return stream;
    },
  };
};
