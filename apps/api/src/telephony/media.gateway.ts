import type { Server } from "node:http";

import { TELEPHONY_AUDIO, type AudioChunk, type AudioFormat, type Logger } from "@ansa/shared";
import type { CallMediaStream, TelephonyProvider } from "@ansa/telephony";
import type { LlmProvider } from "@ansa/llm";
import { buildUrl, openDeepgramSession } from "@ansa/deepgram-listen";
import { openListenSession } from "@ansa/openai-listen";
import type { TtsProvider } from "@ansa/tts";
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { WebSocketServer, type WebSocket } from "ws";

import type { AppConfig } from "../config/env";
import { ACKNOWLEDGEMENTS, ALL_FILLERS, PROGRESS, STILL_WORKING } from "./filler";
import { forSpeech, GREETING_TEXT } from "./greeting";
import { createAudioCache } from "./prerender";
import { composeListen } from "./composite-listen";
import { BASE_KEYTERMS } from "../tenancy/defaults";
import type { TenantRegistry } from "../tenancy/tenant-registry";
import { runConversation, type ListenSession } from "../orchestrator/orchestrator";
import { openDeepgramSocket } from "./ws-deepgram-socket";
import { openListenSocket } from "./ws-listen-socket";
import {
  APP_CONFIG,
  LLM_PROVIDER,
  LOGGER,
  MEDIA_STREAM_PATH,
  TELEPHONY_PROVIDER,
  TENANT_PARAM,
  TENANT_REGISTRY,
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
  /** Keyed by phrase so the orchestrator picks a register, not a queue position. */
  private fillers: ReadonlyMap<string, readonly AudioChunk[]> = new Map();

  constructor(
    @Inject(TELEPHONY_PROVIDER) private readonly telephony: TelephonyProvider,
    @Inject(TTS_PROVIDER) private readonly tts: TtsProvider,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(TENANT_REGISTRY) private readonly tenants: TenantRegistry,
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

    const rendered = new Map<string, readonly AudioChunk[]>();
    for (const phrase of ALL_FILLERS) {
      const chunks = await cache.render(phrase, voiceId);
      if (chunks !== null) rendered.set(phrase, chunks);
    }
    this.fillers = rendered;

    this.log.info("audio warmed", {
      greeting: this.greetingAudio !== null,
      fillers: rendered.size,
    });
  }


  /**
   * One provider's session. Composition happens above this, so a vendor is named in
   * exactly one place per vendor and nowhere else.
   */
  private openOne(
    provider: string,
    format: AudioFormat,
    keyterms: readonly string[],
  ): ListenSession {
    if (provider === "deepgram") {
      const url = buildUrl({
        format,
        model: this.config.deepgramModel,
        keyterms,
        eotThreshold: this.config.deepgramEotThreshold,
        eotTimeoutMs: this.config.deepgramEotTimeoutMs,
        host: this.config.deepgramHost,
      });
      this.log.info("listening via deepgram", {
        model: this.config.deepgramModel,
        host: this.config.deepgramHost,
        keyterms: keyterms.length,
      });
      return openDeepgramSession(openDeepgramSocket(url, this.config.deepgramApiKey));
    }

    this.log.info("listening via openai", { model: this.config.transcriptionModel });
    return openListenSession(openListenSocket(this.config.openAiApiKey), {
      format,
      model: this.config.transcriptionModel,
      turnDetection:
        this.config.turnDetectionMode === "server_vad"
          ? { type: "server_vad", silenceMs: this.config.vadSilenceMs }
          : {
              type: "semantic_vad",
              eagerness: this.config.vadEagerness as "auto" | "low" | "medium" | "high",
            },
      // Carried for interface parity; this provider cannot act on them.
      keyterms,
    });
  }

  private openListen(format: AudioFormat, keyterms: readonly string[]): ListenSession {
    if (this.config.listenProvider !== "composite") {
      return this.openOne(this.config.listenProvider, format, keyterms);
    }

    // Two connections, two bills. Gate A decides whether the result earns it.
    return composeListen({
      words: this.openOne(this.config.listenWords, format, keyterms),
      turns: this.openOne(this.config.listenTurns, format, keyterms),
      log: this.log,
      wordsName: this.config.listenWords,
      turnsName: this.config.listenTurns,
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

    // One connection per call, serving both listen interfaces. Which vendor is behind
    // it is a config value: both stay available so they can be compared on real calls.
    // Synchronous by design: ingress resolved the tenant a moment ago and warmed the
    // cache, so this is a map read. If it somehow missed, the call proceeds on the base
    // vocabulary rather than waiting on a database — configuration must never become
    // silence on the line (R6.2).
    const tenantId = stream.parameters[TENANT_PARAM];
    const tenant = tenantId === undefined ? null : this.tenants.cached(tenantId);
    if (tenantId !== undefined && tenant === null) {
      log.warn("tenant config not cached at stream start, using base vocabulary", { tenantId });
    }
    const keyterms = tenant?.keyterms ?? BASE_KEYTERMS;
    log.info("tenant for call", {
      tenantId: tenant?.tenantId ?? null,
      name: tenant?.name ?? "unknown",
      configVersion: tenant?.configVersion ?? 0,
    });

    const listen = this.openListen(stream.format, keyterms);

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
      // Acknowledge first, then report progress, then acknowledge the wait itself.
      fillerTiers: [ACKNOWLEDGEMENTS, PROGRESS, STILL_WORKING],
    });
  }
}
