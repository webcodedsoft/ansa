import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";

import {
  asCallId,
  asOrganizationId,
  TELEPHONY_AUDIO,
  type AudioChunk,
  type AudioFormat,
  type CallId,
  type HandoffDestination,
  type Logger,
  type OrganizationId,
} from "@ansa/shared";
import type { CallDirection, CallMediaStream, TelephonyProvider } from "@ansa/telephony";
import type { LlmProvider } from "@ansa/llm";
import {
  readCallerHistory,
  recordDoNotCall,
  recordKnowledgeRetrieval,
  searchKnowledge,
  withOrganization,
} from "@ansa/db";
import { buildUrl, openDeepgramSession } from "@ansa/deepgram-listen";
import { openListenSession } from "@ansa/openai-listen";
import type { TtsProvider } from "@ansa/tts";
import {
  callControlTools,
  createCircuitBreaker,
  createToolDispatcher,
  createToolRegistry,
  registerInternalTools,
} from "@ansa/tools";
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { WebSocketServer, type WebSocket } from "ws";

import type { AppConfig } from "../config/env";
import { ACKNOWLEDGEMENTS, ALL_FILLERS, PROGRESS, STILL_WORKING } from "./filler";
import { ALL_GREETING_LEADS, chooseGreetingLead } from "./greeting-lead";
/* The same clock the situation block reads. Asking it here rather than deriving the hour
   again keeps one definition of what "morning" means on a call. */
import { describeSituation } from "../conversation/situation";
import { forSpeech, GREETING_TEXT } from "./greeting";
import { cacheKey, createAudioCache, type AudioCache } from "./prerender";
import { composeListen, type TranscriptSource } from "./composite-listen";
import { createHandoff } from "../handoff/handoff";
import { withHandoffJournal } from "../handoff/journal";
import { withEventPublisher } from "../events/publisher";
import { HANDOFF_DESTINATION, WHISPER_REGISTRY } from "../handoff/tokens";
import type { WhisperRegistry } from "../handoff/whisper";
import { confirmedFact, createCallFacts } from "../conversation/call-facts";
import { KNOWLEDGE_TOOL_NAME, knowledgeTools, type Retrieval } from "../orchestrator/knowledge";
import { createCallRecorder } from "./event-log";
import type { CallerHistory, Db } from "@ansa/db";
import { callSettings, type PlatformDefaults } from "../tenancy/call-settings";
import type { CallAgent, AgentRegistry } from "../tenancy/agent-registry";
import { runConversation, type ListenSession } from "../orchestrator/orchestrator";
import { openDeepgramSocket } from "./ws-deepgram-socket";
import { openListenSocket } from "./ws-listen-socket";
import {
  APP_CONFIG,
  LLM_PROVIDER,
  LOGGER,
  CALLER_PARAM,
  DATA_SOURCE,
  DIALLED_PARAM,
  DIRECTION_PARAM,
  MEDIA_STREAM_PATH,
  TELEPHONY_PROVIDER,
  ORGANIZATION_PARAM,
  ORGANIZATION_REGISTRY,
  TTS_PROVIDER,
} from "./tokens";
import { fromWebSocket } from "./ws-media-socket";

/**
 * The fixed phrases of one call, in the voice that call is answered in.
 *
 * One of these per (voice, greeting) pair rather than one per process. Two organizations with
 * two voices need two sets, and the fillers matter as much as the greeting: an
 * acknowledgement rendered in the platform's default voice, played in the middle of a turn
 * spoken in the organization's, is one organisation's voice audibly appearing on another's call.
 */
interface WarmAudio {
  /** Null when the render failed; the greeting is then synthesised live. */
  readonly greeting: readonly AudioChunk[] | null;
  /**
   * The openers that may be spoken before the greeting, by phrase.
   *
   * Rendered here rather than per call for exactly the reason the greeting is: this plays
   * in the first half-second, and a network round trip there is the whole cost this cache
   * exists to avoid. A phrase missing from the map simply is not chosen.
   */
  readonly leads: ReadonlyMap<string, readonly AudioChunk[]>;
  /** Keyed by phrase so the orchestrator picks a register, not a queue position. */
  readonly fillers: ReadonlyMap<string, readonly AudioChunk[]>;
}

/** Nothing rendered yet, and the call must not wait for it (R6.2). */
const NOT_WARM: WarmAudio = { greeting: null, leads: new Map(), fillers: new Map() };

/**
 * Owns the media WebSocket server. It knows about sockets and nothing about the
 * carrier's wire format; the adapter knows the wire format and nothing about sockets.
 */
@Injectable()
export class MediaGateway implements OnApplicationShutdown {
  private server: WebSocketServer | null = null;
  /** Built on first use: nothing should synthesise before the server is up. */
  private audio: AudioCache | null = null;
  /** Rendered phrases per voice, pace and greeting, and the renders in flight. */
  private readonly warm = new Map<string, WarmAudio>();
  private readonly warming = new Set<string>();
  /**
   * What each caller has done before, fetched at ingress and collected when their socket
   * opens.
   *
   * Keyed by the carrier's call id rather than by the number: a call id is unique, so two
   * people ringing at once cannot collect each other's history, and the entry is deleted on
   * collection rather than lingering as a per-number cache of who has rung recently.
   *
   * Exists because the greeting needs this and the greeting plays first. Reading it on the
   * media socket — which is where the read used to start — meant it arrived a beat after
   * the words it was supposed to change. Ingress is early enough and costs nothing: the
   * carrier still has to fetch TwiML and open a WebSocket, which is the same gap
   * `warmForOrganization` already spends rendering audio.
   */
  private readonly history = new Map<string, CallerHistory>();
  /**
   * R5.2.3. Per process, and keyed inside by organization and tool.
   *
   * It has to outlive a call to be worth anything — the point is that the fourth call to
   * a dead endpoint does not wait three seconds like the first three did.
   */
  private readonly toolBreaker = createCircuitBreaker();

  constructor(
    @Inject(TELEPHONY_PROVIDER) private readonly telephony: TelephonyProvider,
    @Inject(TTS_PROVIDER) private readonly tts: TtsProvider,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(ORGANIZATION_REGISTRY) private readonly organizations: AgentRegistry,
    @Inject(DATA_SOURCE) private readonly dataSource: Db | null,
    @Inject(HANDOFF_DESTINATION) private readonly destination: HandoffDestination | null,
    @Inject(WHISPER_REGISTRY) private readonly whisper: WhisperRegistry,
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
    this.warmed(this.platform().voiceId, this.platform().greeting, undefined);
  }

  /** What the platform supplies when an organisation has not. */
  private platform(): PlatformDefaults {
    return {
      voiceId: this.config.elevenLabsVoiceId,
      greeting: GREETING_TEXT,
      handoff: this.destination,
    };
  }

  /**
   * Renders one voice's fixed phrases: the greeting it answers with, and the thinking-gap
   * acknowledgements. Deterministic given the voice, the pace and the words, so paying for
   * it per call is pure latency — a measured 959ms cold at the moment the caller is
   * listening hardest.
   */
  private async render(
    voiceId: string,
    greeting: string,
    speakingRate: number | undefined,
  ): Promise<WarmAudio> {
    const cache = (this.audio ??= createAudioCache({
      tts: this.tts,
      format: TELEPHONY_AUDIO,
      forSpeech,
      log: this.log,
    }));

    const greetingAudio = await cache.render(greeting, voiceId, speakingRate);
    const leads = new Map<string, readonly AudioChunk[]>();
    for (const phrase of ALL_GREETING_LEADS) {
      const chunks = await cache.render(phrase, voiceId, speakingRate);
      if (chunks !== null) leads.set(phrase, chunks);
    }
    const fillers = new Map<string, readonly AudioChunk[]>();
    for (const phrase of ALL_FILLERS) {
      const chunks = await cache.render(phrase, voiceId, speakingRate);
      if (chunks !== null) fillers.set(phrase, chunks);
    }
    return { greeting: greetingAudio, leads, fillers };
  }

  /**
   * This voice's phrases if they are ready, and starts rendering them if they are not.
   *
   * Synchronous on purpose. A caller has been connected and the answer cannot wait on
   * ElevenLabs, so an unwarmed voice answers by synthesising live — slower, audible, and
   * exactly the fallback the platform voice has always had before boot finished. What is
   * new is that a organization with their own voice hits it on the first call after a restart,
   * which is why `warmForOrganization` runs at ingress: the carrier still has to fetch TwiML and
   * open a socket, and that is usually enough.
   */
  private warmed(voiceId: string, greeting: string, speakingRate: number | undefined): WarmAudio {
    const key = cacheKey(voiceId, speakingRate, greeting);
    const ready = this.warm.get(key);
    if (ready !== undefined) return ready;
    if (this.warming.has(key)) return NOT_WARM;

    this.warming.add(key);
    void this.render(voiceId, greeting, speakingRate)
      .then((rendered) => {
        this.warm.set(key, rendered);
        this.log.info("audio warmed", {
          voiceId,
          speakingRate: speakingRate ?? null,
          greeting: rendered.greeting !== null,
          leads: rendered.leads.size,
          fillers: rendered.fillers.size,
        });
      })
      .catch((error: unknown) => {
        // Never fatal. The next call synthesises live and tries again.
        this.log.error("could not warm audio for a voice", {
          voiceId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => this.warming.delete(key));

    return NOT_WARM;
  }

  /**
   * Start rendering this organisation's voice, called from the voice webhook.
   *
   * The organization is resolved at ingress (R7.3) and the media socket opens a moment later, so
   * this is the only free head start available on a per-organization voice. It returns nothing
   * and is never awaited: the TwiML must go back to the carrier now.
   */
  warmForOrganization(organization: CallAgent): void {
    const settings = callSettings(organization, this.platform());
    this.warmed(settings.voiceId, settings.greeting, settings.speakingRate);
  }

  /**
   * Start reading what this caller has done before, at ingress.
   *
   * Never awaited, for the same reason the audio render is not: the carrier is waiting for
   * TwiML. If it has not landed by the time the socket opens, the greeting opens plainly
   * and the socket falls back to reading it itself — which is exactly what happened before
   * this method existed.
   *
   * Failure is swallowed to a log line. Losing this costs a returning caller a slightly
   * colder hello, which is not worth a single word of a real conversation.
   */
  warmCallerHistory(organizationId: OrganizationId, caller: string | null, callId: CallId): void {
    if (this.dataSource === null || caller === null) return;
    const dataSource = this.dataSource;

    void withOrganization(dataSource, organizationId, (scope) =>
      readCallerHistory(scope, { caller, carrierCallId: String(callId), now: new Date() }),
    ).then(
      (found) => {
        this.history.set(callId, found);
        /* Swept rather than left. A call whose socket never opens — the caller hangs up
           while it rings — would otherwise hold an entry naming a phone number for as long
           as the process lives. A minute is far longer than the gap it covers. */
        setTimeout(() => this.history.delete(callId), 60_000).unref();
      },
      (error: unknown) => {
        this.log.warn("could not read this caller's history at ingress", {
          callId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  /** Collected once, by the socket that was waiting for it. */
  private takeHistory(callId: string): CallerHistory | null {
    const found = this.history.get(callId) ?? null;
    this.history.delete(callId);
    return found;
  }


  /**
   * The turn detector. Always Deepgram Flux — there is no other option by design.
   *
   * It used to be selectable, and the selection was the defect: the deployment ran
   * OpenAI's `semantic_vad` for turn-taking while a complete, live-verified Flux adapter
   * sat unused behind a config value. A silence-or-semantics VAD decides the caller has
   * finished from a gap; Flux reads the words and the prosody and predicts turn
   * completion, which is the difference between waiting out someone reading a phone
   * number and cutting them off at the area code.
   *
   * Making it unselectable rather than defaulted is deliberate. A default is a thing that
   * gets overridden in an env file at three in the morning and never put back.
   */
  private openTurns(format: AudioFormat, keyterms: readonly string[]): ListenSession {
    const url = buildUrl({
      format,
      model: this.config.deepgramModel,
      keyterms,
      eotThreshold: this.config.deepgramEotThreshold,
      eotTimeoutMs: this.config.deepgramEotTimeoutMs,
      host: this.config.deepgramHost,
    });
    this.log.info("turn detection via deepgram flux", {
      model: this.config.deepgramModel,
      host: this.config.deepgramHost,
      eotThreshold: this.config.deepgramEotThreshold,
      eotTimeoutMs: this.config.deepgramEotTimeoutMs,
      keyterms: keyterms.length,
    });
    // A factory, not a socket: the session redials on a mid-call drop, and a closed
    // WebSocket cannot be reopened, only replaced.
    return openDeepgramSession(() => openDeepgramSocket(url, this.config.deepgramApiKey));
  }

  /** The transcriber, when it is not Flux itself. Swappable for an accent-tuned vendor. */
  private openWords(format: AudioFormat, keyterms: readonly string[]): TranscriptSource {
    this.log.info("transcription via openai", {
      model: this.config.transcriptionModel,
      sendAsPcm: this.config.openAiSendPcm,
    });
    return openListenSession(openListenSocket(this.config.openAiApiKey), {
      format,
      model: this.config.transcriptionModel,
      /* Still configured, and not dead config now that Flux owns turn-taking: this
         provider's `turn_detection` is also what makes it commit a buffer and emit a
         final transcript. Its turn events are simply never reachable — see
         `TranscriptSource`. */
      turnDetection:
        this.config.turnDetectionMode === "server_vad"
          ? { type: "server_vad", silenceMs: this.config.vadSilenceMs }
          : {
              type: "semantic_vad",
              eagerness: this.config.vadEagerness as "auto" | "low" | "medium" | "high",
            },
      // Carried for interface parity; this provider cannot act on them.
      keyterms,
      sendAsPcm: this.config.openAiSendPcm,
    });
  }

  private openListen(format: AudioFormat, keyterms: readonly string[]): ListenSession {
    const turns = this.openTurns(format, keyterms);

    // Flux carries the transcript in the same frame as the turn event, so when it is also
    // the transcriber there is one connection and one bill (R4.1.9).
    if (this.config.listenWords === "deepgram") return turns;

    // Two connections, two bills. Worth it only while a separate transcriber hears
    // Nigerian speech better than Flux does — which is a measurement, not an assumption.
    return composeListen({
      words: this.openWords(format, keyterms),
      turns,
      log: this.log,
      wordsName: this.config.listenWords,
      turnsName: "deepgram",
    });
  }

  /**
   * Writes the caller's audio to disk when RECORD_AUDIO_DIR is set.
   *
   * Off unless configured, and it should be turned off again after diagnosing: this is a
   * caller reading their policy number aloud. `organizations.audio_retention_days` exists and
   * nothing enforces it yet, so nothing here pretends otherwise.
   */
  private recordAudio(stream: CallMediaStream, log: Logger): void {
    const dir = this.config.recordAudioDir;
    if (dir === undefined) return;

    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      log.error("could not create the audio directory", {
        dir,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const path = join(dir, `${stream.callId}.ulaw`);
    const file = createWriteStream(path);
    // A recording failing must not affect the call, exactly as with the event log.
    file.on("error", (error: Error) => {
      log.error("could not write call audio", { path, error: error.message });
    });

    let bytes = 0;
    stream.onAudio((chunk) => {
      bytes += chunk.data.length;
      file.write(chunk.data);
    });
    stream.onClosed(() => {
      file.end();
      log.info("recorded caller audio", { path, bytes, seconds: Math.round(bytes / 8000) });
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
    // Synchronous by design: ingress resolved the organization a moment ago and warmed the
    // cache, so this is a map read. If it somehow missed, the call proceeds on the base
    // vocabulary rather than waiting on a database — configuration must never become
    // silence on the line (R6.2).
    // Buffering starts now, not after the organization lookup. The carrier begins delivering
    // frames immediately and the conversation cannot exist until configuration is known,
    // so without this the gap between the two is simply deaf.
    const early: AudioChunk[] = [];
    let buffering = true;
    stream.onAudio((chunk) => {
      if (buffering) early.push(chunk);
    });

    // Exactly what the carrier sent, unaltered: raw mu-law at 8kHz, no header. Replaying
    // a real call through two transcribers is the only way to tell a provider problem
    // from an encoding one, and every comparison so far has been a guess because the
    // audio was gone the moment it was transcribed.
    this.recordAudio(stream, log);

    const organizationId = stream.parameters[ORGANIZATION_PARAM];
    void this.startConversation(stream, log, organizationId, () => {
      buffering = false;
      return early;
    });
  }

  /**
   * Resolves configuration, then starts the conversation.
   *
   * Async because of outbound. Inbound warms the cache at the voice webhook and this is
   * a map read; outbound inlines its TwiML and never touches a webhook, so the first
   * time anyone asks about this organization is here. One round trip is worth paying — the
   * alternative, seen on the first outbound call, is answering a caller as "unknown"
   * with none of their organization's vocabulary.
   *
   * The greeting is pre-rendered and plays regardless, so the lookup happens behind
   * audio the caller is already hearing.
   */
  private async startConversation(
    stream: CallMediaStream,
    log: Logger,
    organizationId: string | undefined,
    /** Stops buffering and hands over whatever arrived while we were looking up config. */
    drainEarlyAudio: () => readonly AudioChunk[],
  ): Promise<void> {
    const organization =
      organizationId === undefined
        ? null
        : (this.organizations.cached(organizationId) ?? (await this.organizations.load(asOrganizationId(organizationId))));

    if (organizationId !== undefined && organization === null) {
      log.warn("organization on the media socket has no config, using base vocabulary", { organizationId });
    }

    /**
     * Every value on this call that depends on which organisation was dialled, derived in
     * one place (`tenancy/call-settings.ts`) rather than six times down this method. Two of
     * those six used to read the platform's value and ignore the organization's; nothing here
     * reaches past `settings` for one of them any more.
     */
    const settings = callSettings(organization, this.platform());
    const { keyterms } = settings;
    log.info("organization for call", {
      organizationId: settings.organizationId,
      name: settings.name,
      configVersion: settings.configVersion,
      keyterms: keyterms.length,
      voiceId: settings.voiceId,
      // Null is the voice's own pace, which is the default and is not 1.0.
      speakingRate: settings.speakingRate ?? null,
      // Whether they answer in their own words, not the words themselves: the greeting is
      // spoken on every call and a log line is not where it needs repeating.
      ownGreeting: settings.greeting !== this.platform().greeting,
      ownEscalation: settings.handoff !== this.platform().handoff,
    });
    const warm = this.warmed(settings.voiceId, settings.greeting, settings.speakingRate);

    const direction: CallDirection =
      stream.parameters[DIRECTION_PARAM] === "outbound" ? "outbound" : "inbound";

    // Only when the organization resolved. A call on an unconfigured number is already running
    // with base vocabulary and recording nothing; there is nothing to scope state to and
    // CLAUDE.md rule 3 does not admit a placeholder organization.
    //
    // Created before the recorder, because the event publisher below reads it when a call
    // ends: the identifiers a call established are both part of the payload and the
    // strongest signal a organization's redaction has to work with.
    const facts =
      settings.organizationId === null
        ? undefined
        : createCallFacts({
            organizationId: settings.organizationId,
            callId: asCallId(stream.callId),
            callDirection: direction,
          });

    // Created here rather than at stream start: the organization is what scopes every row,
    // and until the lookup above returned there was nothing to scope them to.
    const recorder = createCallRecorder({ dataSource: this.dataSource, log });
    // Tees the same events on their way to call_events. The recorder batches, so the last
    // few seconds of a call — the ones that caused the escalation — are not in the table
    // yet when the transfer is dialled.
    const journal = withHandoffJournal(recorder);
    const openedAt = Date.now();

    /**
     * A second tee, outside the journal, that queues an event webhook when the call ends
     * or is handed to a person (Slice 6a).
     *
     * Returns the journal's recorder unchanged unless this organization has configured a
     * receiver, so on every call today this line does nothing. When it does do something,
     * all it does is write a row: no request is made on the call path and no receiver's
     * outage can reach a conversation.
     *
     * Outside the journal rather than inside so the summary it sends is built from exactly
     * the events the person answering the phone was given.
     */
    const record =
      settings.organizationId === null
        ? journal.recorder
        : withEventPublisher(journal.recorder, {
            dataSource: this.dataSource,
            log,
            organizationId: settings.organizationId,
            events: settings.events,
            call: {
              callId: stream.callId,
              direction,
              dialled: stream.parameters[DIALLED_PARAM] ?? null,
              caller: stream.parameters[CALLER_PARAM] ?? null,
              startedAt: new Date(openedAt).toISOString(),
              configVersion: settings.configVersion,
            },
            facts: () => facts?.facts ?? null,
            journal: journal.events,
            callerNumber: stream.parameters[CALLER_PARAM] ?? null,
          });

    if (settings.organizationId !== null) {
      record.started({
        organizationId: settings.organizationId,
        carrierCallId: stream.callId,
        direction,
        dialled: stream.parameters[DIALLED_PARAM] ?? "unknown",
        caller: stream.parameters[CALLER_PARAM] ?? null,
        agentId: settings.agentId,
        configVersion: settings.configVersion,
      });
      stream.onClosed((reason) => {
        // Our own duration, not the carrier's. Inbound calls recorded none at all: a
        // status callback is configured on the number rather than set in TwiML, so
        // nothing reported one. This is the media stream's lifetime, which we always
        // know — and it is conversation time rather than billing time, which is the more
        // useful of the two for a reviewer anyway. The carrier's own figure still
        // overwrites it when the status callback arrives.
        record.ended(reason, null, Math.round((Date.now() - openedAt) / 1000));
      });
    }

    /**
     * Who this caller is to us, fetched while the greeting plays.
     *
     * Deliberately not awaited. The greeting is roughly two seconds of audio and this is
     * one indexed read, so on a healthy deployment it lands long before the caller
     * finishes their first sentence — but "usually" is not "always", and a call must never
     * be held open waiting for a nicety. The orchestrator reads whatever is here and
     * renders nothing when that is nothing.
     *
     * Failure is swallowed for the same reason the recorder swallows its own: the caller
     * is mid-conversation and a slow query is not their problem. The cost of losing this
     * is an agent that greets a returning caller as a new one, which is exactly how it
     * behaved before this existed.
     */
    /* Collected from the ingress prefetch, which usually beat us here. The read below is
       the fallback for when it did not — an outbound call, a restart between the two, or a
       slow query — and it still lands in time for every turn after the greeting. */
    let callerHistory: CallerHistory | null = this.takeHistory(stream.callId);
    const callerNumber = stream.parameters[CALLER_PARAM] ?? null;
    if (
      callerHistory === null &&
      this.dataSource !== null &&
      settings.organizationId !== null &&
      callerNumber !== null
    ) {
      const dataSource = this.dataSource;
      const organizationId = settings.organizationId;
      void withOrganization(dataSource, organizationId, (scope) =>
        readCallerHistory(scope, {
          caller: callerNumber,
          carrierCallId: stream.callId,
          now: new Date(),
        }),
      )
        .then((history) => {
          callerHistory = history;
        })
        .catch((error: unknown) => {
          log.warn("could not read this caller's history, treating them as new", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    const listen = this.openListen(stream.format, keyterms);

    /**
     * How this call opens, which is no longer one recording.
     *
     * A lead-in is chosen per call and spoken before the organisation's own greeting, which
     * is left exactly as they wrote it. Both halves come from the same warm cache, so this
     * costs no network time at the one moment that could not afford any.
     *
     * The audio is concatenated rather than re-synthesised as a single phrase. These are
     * raw mu-law frames with no header, so two sequences played back to back are one
     * sequence — and keeping the original chunking is what keeps barge-in cutting at the
     * same granularity it always did.
     *
     * Falls back to the greeting alone whenever anything is missing: no lead chosen, the
     * phrase never rendered, or the greeting itself did not. That fallback is exactly what
     * every call did before this existed.
     */
    const opener = ((): { text: string; audio: readonly AudioChunk[] | null } => {
      const plain = { text: settings.greeting, audio: warm.greeting };
      if (warm.greeting === null) return plain;

      const now = describeSituation({
        now: new Date(),
        callStartedAtMs: openedAt,
        businessHours: settings.businessHours,
        failedTurns: 0,
        escalationOffered: false,
        history: null,
      });
      const lead = chooseGreetingLead({
        partOfDay: now.partOfDay,
        openNow: now.openNow,
        callId: stream.callId,
        /* Whatever the ingress prefetch collected. Null here is a stranger's greeting,
           which is the right answer for a withheld number and for a read that lost the
           race alike. */
        history: callerHistory,
      });
      if (lead === null) return plain;

      const leadAudio = warm.leads.get(lead);
      if (leadAudio === undefined) return plain;
      return { text: `${lead} ${settings.greeting}`, audio: [...leadAudio, ...warm.greeting] };
    })();

    runConversation(stream, {
      // The answering agent's own switch (migration 0020), resolved with its config at
      // ingress so this costs no extra round trip on the answer path.
      bargeIn: settings.bargeIn,
      // The form this agent conducts, resolved with its config at ingress so the
      // director costs no extra round trip on the answer path.
      fields: settings.capturedFields,
      listen,
      facts,
      /* The same value the business-hours tool gets below. One source, so what the agent
         senses about the hour and what it answers when asked cannot disagree — two reads
         of the same config would be two places for one of them to go stale. */
      businessHours: settings.businessHours,
      callerHistory: () => callerHistory,
      /**
       * Somebody asking never to be called again, written down before the call ends.
       *
       * Not awaited: the caller is mid-sentence and the agent still has to say something
       * back. A failure is logged at error rather than swallowed quietly, and that is the
       * one difference from every other write here — losing a transcript costs a review,
       * losing this one means ringing somebody who asked us not to.
       *
       * A number we never learned cannot be suppressed. Logged loudly for the same reason:
       * it means a withheld-CLI caller asked and we could not comply, which somebody has to
       * be able to find afterwards.
       */
      recordDoNotCall: (saidWhat) => {
        if (this.dataSource === null || settings.organizationId === null) return;
        if (callerNumber === null) {
          log.error("caller asked not to be called again, but their number is withheld", {
            saidWhat,
          });
          return;
        }
        void recordDoNotCall(this.dataSource, settings.organizationId, callerNumber, saidWhat).then(
          () => {
            log.info("recorded a do-not-call request", { saidWhat });
          },
          (error: unknown) => {
            log.error("could not record a do-not-call request", {
              saidWhat,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        );
      },
      // Null for an unregistered number, and the orchestrator reads that as "no tools on
      // this call at all". Such a caller may hold a conversation and must not reach
      // anybody's systems (CLAUDE.md rule 3).
      organizationId: settings.organizationId,
      /**
       * Built per call, given the two things only the orchestrator knows: when to make a
       * noise while a tool runs, and when the caller has actually heard the goodbye.
       *
       * The registry is per call as well as the dispatcher, which is a deviation from
       * `packages/tools/WIRING.md`. It has to be: two of the three platform tools close
       * over this call's own effects, so a registry built once in the module could not
       * hold them. Three map writes per call is not a cost worth an indirection.
       *
       * The platform tools, plus whatever this organization has configured of their own — the
       * same registry and the same dispatcher for both, which is the whole of R5.2.0 at
       * the call site. A organization with nothing configured registers nothing and the call is
       * exactly what Slice 5 left: an agent that can end the call, ask for a person and
       * read the clock.
       */
      makeTools: (hooks) => {
        const registry = createToolRegistry();
        // Bound out of `this` here rather than inside the closure below, which runs per
        // tool call and must not depend on how it was invoked.
        const dataSource = this.dataSource;
        registerInternalTools(
          registry,
          callControlTools({
            endCall: hooks.endCall,
            // Null until the organization configures hours; the tool then says it does not know
            // rather than inventing a nine to five (R6.5, migration 0012).
            businessHours: settings.businessHours,
          }),
        );
        /* Registered only when the agent has sources, which `knowledgeTools` decides from
           the same availability the prompt was composed from — so the model is never told
           it can search something the registry does not hold.

           The search closes over the organisation scope rather than taking one: a scope is
           a transaction handle, and holding one open across a tool call would keep a
           connection for the length of a caller's pause. */
        registerInternalTools(
          registry,
          knowledgeTools({
            agentId: settings.agentId,
            hasSources: settings.hasKnowledgeSources,
            search: async (organizationId, agentId, query, limit) => {
              // An unregistered number never gets here — `knowledgeTools` refuses to
              // register without an agent — but the type admits it, and returning nothing
              // is the same answer the store would give.
              if (dataSource === null) return [];
              return withOrganization(dataSource, organizationId, (scope) =>
                searchKnowledge(scope, agentId, query, limit),
              );
            },
          }),
        );
        // Prepared when the organization's configuration was loaded, so this is map writes
        // rather than a handshake on the answer path.
        settings.connectors.register(registry);
        return {
          registry,
          dispatcher: createToolDispatcher({
            registry,
            log: log.child({ organizationId: settings.organizationId }),
            holding: hooks.holding,
            /**
             * Who the caller has been confirmed to be, read live rather than snapshotted:
             * a value confirmed three turns into the call has to open the tool that was
             * refused on turn one.
             *
             * `confirmedFact` is the only door to a value, and this is the second place
             * that matters — the first is the readback. Without `facts` (an unregistered
             * number) nothing is ever confirmed, which is the right answer for a call
             * that has no organization to look anything up in anyway.
             */
            /**
             * Which sources answered, written down after the fact.
             *
             * This is what the Knowledge tab's "used, 7d" column counts, and without it that
             * column reads zero for everything — a number that looks like measurement and is
             * really "nothing ever recorded it". Knowing which sources earn their place is
             * the only way an organisation can tell a FAQ that answers callers from one
             * nobody has ever matched.
             *
             * Deliberately not awaited. `onResult` runs on the turn the caller is waiting
             * through, and a bookkeeping row must never cost them a second or fail their
             * question — so it is fired, and a failure is logged and dropped.
             */
            onResult: (call, result) => {
              if (call.name !== KNOWLEDGE_TOOL_NAME || dataSource === null) return;
              const organizationId = settings.organizationId;
              if (organizationId === null) return;

              const passages = (result as Retrieval | undefined)?.passages ?? [];
              const sourceIds = [...new Set(passages.map((passage) => passage.sourceId))];
              if (sourceIds.length === 0) return;

              void withOrganization(dataSource, organizationId, (scope) =>
                recordKnowledgeRetrieval(scope, sourceIds, stream.callId),
              ).catch((error: unknown) => {
                log.warn("could not record which knowledge sources answered", {
                  organizationId,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
            },
            identity: {
              confirmed: (fact) => {
                const snapshot = facts?.facts;
                if (snapshot === undefined) return null;

                /* The agent's own form first. A tool naming `claimNumber` could never be
                   satisfied while this was a switch over three built-in names — it
                   answered `unconfirmed-identity` on every call, silently, and the only
                   way to find out was to make one. What an agent collects is configuration
                   now, so what can open a tool has to be too. */
                const collected = snapshot.captured.get(fact);
                if (collected !== undefined) return confirmedFact(collected);

                switch (fact) {
                  case "callerName":
                    return confirmedFact(snapshot.callerName);
                  case "policyNumber":
                    return confirmedFact(snapshot.policyNumber);
                  case "customerId":
                    return confirmedFact(snapshot.customerId);
                  default:
                    // A fact this call has neither collected nor built in is never
                    // confirmed, so a typo in a tool's `identifiers` disables it rather
                    // than opening it.
                    return null;
                }
              },
            },
            // R5.2.3, and the one thing here that outlives the call. A breaker built per
            // call would have nothing to remember and would never open.
            breaker: this.toolBreaker,
          }),
        };
      },
      // Built per call, and given `say` by the orchestrator: the departure line has to be
      // heard before `transferToNumber` replaces the carrier instruction and takes the
      // media stream with it.
      makeHandoff: (say) =>
        createHandoff({
          telephony: this.telephony,
          callId: asCallId(stream.callId),
          organizationId: settings.organizationId,
          callerNumber: stream.parameters[CALLER_PARAM] ?? null,
          // Theirs, falling back to the platform's. Before migration 0015 this was always
          // the platform's, which on a second organization is somebody else's staff phone.
          destination: settings.handoff,
          events: journal.events,
          record,
          log,
          say,
          hangUp: () => {
            stream.hangUp();
          },
          whisper: this.whisper,
          whisperBaseUrl: this.config.publicBaseUrl,
        }),
      // Drained last, immediately before the conversation starts, so no frame can slip
      // between the buffer closing and the orchestrator subscribing.
      initialAudio: drainEarlyAudio(),
      // The teed recorder, not the bare one: everything the orchestrator records has to
      // reach both the table and the summary the person answering will hear.
      recorder: record,
      // Which connections this call actually opened. `deepgram` alone means one socket
      // serving words and turns; `openai` means two sockets and two bills, which is the
      // number R4.1.9 exists to let somebody weigh against the transcript quality.
      listenProvider: this.config.listenWords === "deepgram" ? "deepgram" : "composite",
      transcriptionConfig: {
        // Flux is always here, because it is always the turn detector now.
        model: this.config.deepgramModel,
        host: this.config.deepgramHost,
        eotThreshold: this.config.deepgramEotThreshold,
        eotTimeoutMs: this.config.deepgramEotTimeoutMs,
        keyterms: keyterms.length,
        ...(this.config.listenWords === "deepgram"
          ? {}
          : {
              listenWords: this.config.listenWords,
              wordsModel: this.config.transcriptionModel,
              language: "en",
              turnDetection: this.config.turnDetectionMode,
              eagerness: this.config.vadEagerness,
              sendAsPcm: this.config.openAiSendPcm,
            }),
      },
      llm: this.llm,
      tts: this.tts,
      voiceId: settings.voiceId,
      speakingRate: settings.speakingRate,
      log: this.log,
      greeting: opener.text,
      // The organization's own persona and instructions, already composed and cached at config
      // load. An unregistered number gets the default composition, which is exactly what
      // every call got before this line existed.
      systemPrompt: settings.systemPrompt,
      forSpeech,
      // Rendered for this call's voice and this call's greeting, or null and synthesised
      // live. Never another voice's.
      greetingAudio: opener.audio,
      fillers: warm.fillers,
      // Acknowledge first, then report progress, then acknowledge the wait itself.
      fillerTiers: [ACKNOWLEDGEMENTS, PROGRESS, STILL_WORKING],
    });
  }
}
