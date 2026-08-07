import { Buffer } from "node:buffer";

import type { AudioChunk, AudioFormat } from "@ansa/shared";

import { durationMs } from "../audio-duration";
import type { SynthesisRequest, SynthesisStream, TtsProvider } from "../types";

export interface ElevenLabsOptions {
  readonly apiKey: string;
  readonly modelId?: string;
  readonly baseUrl?: string;
  /** Injected in tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
// The low-latency model. Gate A revisits this alongside the provider itself.
const DEFAULT_MODEL_ID = "eleven_turbo_v2_5";

/**
 * Map our format onto the vendor's name for it. Deliberately narrow: an unsupported
 * format throws rather than falling back to something that would need transcoding,
 * because a silent transcoding hop is exactly the cost R4.2.4 exists to avoid.
 */
export function toOutputFormat(format: AudioFormat): string {
  if (format.encoding === "mulaw" && format.sampleRate === 8000) return "ulaw_8000";
  if (format.encoding === "linear16" && format.sampleRate === 16000) return "pcm_16000";
  if (format.encoding === "linear16" && format.sampleRate === 22050) return "pcm_22050";
  throw new Error(
    `ElevenLabs has no native output for ${format.encoding}@${format.sampleRate}Hz`,
  );
}

class ElevenLabsSynthesisStream implements SynthesisStream {
  private readonly audioListeners: ((chunk: AudioChunk) => void)[] = [];
  private readonly doneListeners: (() => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];
  private readonly controller = new AbortController();
  private cancelled = false;
  private settled = false;

  onAudio(listener: (chunk: AudioChunk) => void): void {
    this.audioListeners.push(listener);
  }

  onDone(listener: () => void): void {
    this.doneListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  cancel(): void {
    if (this.settled) return;
    this.cancelled = true;
    this.settled = true;
    // Aborts the in-flight request so the vendor stops billing for audio nobody hears.
    this.controller.abort();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  emitAudio(chunk: AudioChunk): void {
    if (this.settled) return;
    for (const listener of this.audioListeners) listener(chunk);
  }

  emitDone(): void {
    if (this.settled) return;
    this.settled = true;
    for (const listener of this.doneListeners) listener();
  }

  emitError(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    for (const listener of this.errorListeners) listener(error);
  }
}

export function createElevenLabsTts(options: ElevenLabsOptions): TtsProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: "elevenlabs",

    synthesize(request: SynthesisRequest): SynthesisStream {
      const stream = new ElevenLabsSynthesisStream();

      // Deferred by a microtask so the caller's onAudio/onDone/onError, registered
      // synchronously after this returns, are attached before anything can be emitted.
      // Without it, a failure raised before the first await — an unsupported format,
      // say — is emitted to nobody and the turn goes silent with no error anywhere.
      queueMicrotask(() => {
        void run();
      });

      async function run(): Promise<void> {
        try {
          const outputFormat = toOutputFormat(request.format);
          const url =
            `${baseUrl}/v1/text-to-speech/${encodeURIComponent(request.voiceId)}/stream` +
            `?output_format=${outputFormat}`;

          const response = await doFetch(url, {
            method: "POST",
            signal: stream.signal,
            headers: {
              "xi-api-key": options.apiKey,
              "Content-Type": "application/json",
              Accept: "audio/*",
            },
            body: JSON.stringify({ text: request.text, model_id: modelId }),
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
      }

      return stream;
    },
  };
}
