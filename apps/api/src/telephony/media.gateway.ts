import type { Server } from "node:http";

import { TELEPHONY_AUDIO, type AudioChunk, type Logger } from "@ansa/shared";
import type { CallMediaStream, TelephonyProvider } from "@ansa/telephony";
import type { LlmProvider } from "@ansa/llm";
import { openListenSession } from "@ansa/openai-listen";
import type { TtsProvider } from "@ansa/tts";
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { WebSocketServer, type WebSocket } from "ws";

import type { AppConfig } from "../config/env";
import { FILLER_PHRASES } from "./filler";
import { forSpeech, GREETING_TEXT } from "./greeting";
import { createAudioCache } from "./prerender";
import { runConversation } from "../orchestrator/orchestrator";
import { openListenSocket } from "./ws-listen-socket";
import {
  APP_CONFIG,
  LLM_PROVIDER,
  LOGGER,
  MEDIA_STREAM_PATH,
  TELEPHONY_PROVIDER,
  TTS_PROVIDER,
} from "./tokens";
import { fromWebSocket } from "./ws-media-socket";

/**
 * Owns the media WebSocket server. It knows about sockets and nothing about the
 * carrier's wire format; the adapter knows the wire format and nothing about sockets.
 */
@Injectable()
export class MediaGateway implements OnApplicationShutdown {
  private server: WebSocketServer | null = null;
  /** Fixed phrases, rendered once at boot rather than per call. */
  private greetingAudio: readonly AudioChunk[] | null = null;
  private fillers: readonly (readonly AudioChunk[])[] = [];

  constructor(
    @Inject(TELEPHONY_PROVIDER) private readonly telephony: TelephonyProvider,
    @Inject(TTS_PROVIDER) private readonly tts: TtsProvider,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  /**
   * Called once the HTTP server is listening, since ws attaches to it. Nest's
   * lifecycle hooks fire before listen(), so main.ts drives this explicitly.
   */
  attachTo(httpServer: Server): void {
    const server = new WebSocketServer({ server: httpServer, path: MEDIA_STREAM_PATH });
    this.server = server;

    // Same hazard as the per-call sockets: an unhandled 'error' here would take the
    // process down and with it every call in progress.
    server.on("error", (error: Error) => {
      this.log.error("media ws server error", { error: error.message });
    });

    server.on("connection", (socket: WebSocket) => {
      this.log.debug("media socket opened");
      this.telephony.attachMediaStream(fromWebSocket(socket), {
        onStream: (stream) => {
          this.observe(stream);
        },
        onError: (error) => {
          this.log.error("media stream error", { error: error.message });
        },
      });
    });

    this.log.info("media stream gateway listening", { path: MEDIA_STREAM_PATH });

    // Off the critical path: calls that arrive before this finishes fall back to
    // synthesising live, which is slower but never silent.
    void this.warmAudio();
  }

  /**
   * Renders the greeting and the thinking-gap acknowledgements once. Everything here is
   * a compile-time constant in a fixed voice at a fixed format, so the result is
   * identical on every call and paying for it per call is pure latency.
   */
  private async warmAudio(): Promise<void> {
    const cache = createAudioCache({
      tts: this.tts,
      format: TELEPHONY_AUDIO,
      forSpeech,
      log: this.log,
    });
    const voiceId = this.config.elevenLabsVoiceId;

    this.greetingAudio = await cache.render(GREETING_TEXT, voiceId);
    const rendered = await Promise.all(FILLER_PHRASES.map((p) => cache.render(p, voiceId)));
    this.fillers = rendered.filter((c): c is readonly AudioChunk[] => c !== null);
    this.log.info("audio warmed", {
      greeting: this.greetingAudio !== null,
      fillers: this.fillers.length,
    });
  }

  onApplicationShutdown(): void {
    this.server?.close();
    this.server = null;
  }

  /**
   * Slice 1 counts inbound audio and speaks one sentence. The transcriber and turn
   * detector subscribe to this same stream in Slice 3.
   */
  private observe(stream: CallMediaStream): void {
    const log = this.log.child({ callId: stream.callId });
    const openedAt = Date.now();
    let frames = 0;
    let bytes = 0;
    let firstFrameLogged = false;

    log.info("media stream started", {
      encoding: stream.format.encoding,
      sampleRate: stream.format.sampleRate,
    });

    stream.onAudio((chunk) => {
      frames += 1;
      bytes += chunk.data.length;

      if (!firstFrameLogged) {
        firstFrameLogged = true;
        log.info("first inbound audio frame", {
          bytes: chunk.data.length,
          msSinceStreamStart: Date.now() - openedAt,
        });
      }

      // The carrier sends a 20ms frame every 20ms, so this is one line per second.
      if (frames % 50 === 0) {
        log.debug("inbound audio", { frames, bytes, carrierOffsetMs: chunk.offsetMs });
      }
    });

    stream.onClosed((reason) => {
      log.info("media stream closed", {
        reason,
        frames,
        bytes,
        durationMs: Date.now() - openedAt,
      });
    });

    // One realtime connection per call, serving both listen interfaces.
    const listen = openListenSession(openListenSocket(this.config.openAiApiKey), {
      format: stream.format,
      model: this.config.transcriptionModel,
      turnDetection:
        this.config.turnDetectionMode === "server_vad"
          ? { type: "server_vad", silenceMs: this.config.vadSilenceMs }
          : {
              type: "semantic_vad",
              eagerness: this.config.vadEagerness as "auto" | "low" | "medium" | "high",
            },
      // Callers say the brand name back, and it must not be mangled (R4.1.3).
      keyterms: ["Ansa", "policy", "premium", "naira"],
    });

    runConversation(stream, {
      listen,
      llm: this.llm,
      tts: this.tts,
      voiceId: this.config.elevenLabsVoiceId,
      log: this.log,
      greeting: GREETING_TEXT,
      forSpeech,
      greetingAudio: this.greetingAudio,
      fillers: this.fillers,
    });
  }
}
