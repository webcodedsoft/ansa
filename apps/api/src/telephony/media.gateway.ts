import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";

import {
  asCallId,
  asOrganizationId,
  TELEPHONY_AUDIO,
  type AudioChunk,
  type AudioFormat,
  type CallDirection,
  type CallId,
  type HandoffDestination,
  type Logger,
  type OrganizationId,
} from "@ansa/shared";
import type { CallMediaStream, TelephonyProvider } from "@ansa/telephony";
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
import { forSpeech, GREETING_TEXT, outboundOpener } from "./greeting";
import { cacheKey, createAudioCache, type AudioCache } from "./prerender";
import { createWarmScheduler } from "./warm-scheduler";
import { openIntronSession, type IntronLanguage } from "@ansa/intron-listen";

import { composeListen, type TranscriptSource } from "./composite-listen";
import { openIntronSocket } from "./ws-intron-socket";
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
  /** False when a call arrived mid-render and the rest was left for later. */
  readonly complete: boolean;
}

/** Nothing rendered yet, and the call must not wait for it (R6.2). */
/** One carrier frame of 8kHz audio. Its timestamps advance by this much when nothing is lost. */
const FRAME_MS = 20;

const NOT_WARM: WarmAudio = { greeting: null, leads: new Map(), fillers: new Map(), complete: false };

/** A gap this size or smaller reads as a dropped packet rather than a pause in speech. */
const SHORT_GAP_MS = 200;

/** How often the loop is sampled for lateness. Half a frame, so a lost frame is visible. */
const LOOP_SAMPLE_MS = 10;

/**
 * Nanoseconds from the histogram to milliseconds *late*.
 *
 * `monitorEventLoopDelay` records the whole interval between samples, so a perfectly idle
 * loop reads as the sampling resolution rather than as zero — a first run reported a p50 of
 * 21ms on an idle process and looked alarming. Subtracting the resolution makes the number
 * mean what its name says.
 */
const overSample = (nanoseconds: number): number =>
  Math.max(0, Math.round(nanoseconds / 1e6) - LOOP_SAMPLE_MS);

/**
 * Phrases per batch when warming.
 *
 * Rendered concurrently because sequentially is what made the warm long enough to matter:
 * ~60 awaited round trips took a measured 7.7 seconds. Batched, the same work is a
 * fraction of that, and the batch boundary is also where the warm checks whether a call
 * has arrived — so a smaller number yields sooner and a larger one finishes sooner.
 */
const WARM_BATCH = 8;

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
   * Open media sockets, and the warms waiting for them to close.
   *
   * Rendering a voice is ~60 ElevenLabs round trips. Done while a call is up it competes
   * with the call for the same event loop, and the carrier does not wait: Twilio discards
   * inbound media it cannot hand over. A measured call lost its first 6.6 seconds of audio
   * to exactly this, warming a voice for the caller who was already talking.
   *
   * So warming yields. It runs when nothing is on the line, stops between phrases when
   * something arrives, and resumes when the last socket closes. The cost is that a voice
   * nobody has used yet stays cold for the call that first needs it — which is the
   * fallback that has always existed, and is much cheaper than degrading the live call.
   */
  private readonly warmer = createWarmScheduler();
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
   * What to leave on an answering machine, per live call.
   *
   * Composed here because this is where the organisation is known. The answering-machine
   * verdict arrives on its own webhook holding nothing but a carrier id, and looking the
   * organisation up from there would be a second resolution path for something already in
   * hand — the same reasoning that keeps the caller history in a map rather than re-read.
   */
  private readonly voicemail = new Map<string, string>();

  /** What to say to a machine on this call, or null to hang up silently instead. */
  voicemailFor(callId: string): string | null {
    return this.voicemail.get(callId) ?? null;
  }
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
    keepGoing: () => boolean,
  ): Promise<WarmAudio> {
    const cache = (this.audio ??= createAudioCache({
      tts: this.tts,
      format: TELEPHONY_AUDIO,
      forSpeech,
      log: this.log,
      maxConcurrent: this.config.ttsMaxConcurrent,
    }));

    /* The greeting first and alone. It is the one phrase the next call certainly needs,
       and rendering it before the batches means an interrupted warm still leaves the
       thing that matters most. */
    const greetingAudio = await cache.render(greeting, voiceId, speakingRate);

    const into = async (
      phrases: readonly string[],
      target: Map<string, readonly AudioChunk[]>,
    ): Promise<boolean> => {
      for (let at = 0; at < phrases.length; at += WARM_BATCH) {
        // Between batches, not within one: a call that lands mid-batch waits out the few
        // requests already in flight, which is bounded and short.
        if (!keepGoing()) return false;
        const batch = phrases.slice(at, at + WARM_BATCH);
        const rendered = await Promise.all(
          batch.map(async (phrase) => [phrase, await cache.render(phrase, voiceId, speakingRate)] as const),
        );
        for (const [phrase, chunks] of rendered) if (chunks !== null) target.set(phrase, chunks);
      }
      return true;
    };

    const leads = new Map<string, readonly AudioChunk[]>();
    const fillers = new Map<string, readonly AudioChunk[]>();
    const complete = (await into(ALL_GREETING_LEADS, leads)) && (await into(ALL_FILLERS, fillers));
    return { greeting: greetingAudio, leads, fillers, complete };
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

    /* Handed to the scheduler rather than started here: whether this is a safe moment to
       spend ~60 round trips on ElevenLabs is its question, not this one's. */
    this.warming.add(key);
    this.warmer.submit({
      key,
      run: async (keepGoing) => {
        try {
          const rendered = await this.render(voiceId, greeting, speakingRate, keepGoing);
          /* A partial render is still kept. Every phrase in it is one the next call does
             not have to synthesise, and the scheduler re-queues the remainder. */
          this.warm.set(key, rendered);
          this.log.info("audio warmed", {
            voiceId,
            speakingRate: speakingRate ?? null,
            greeting: rendered.greeting !== null,
            leads: rendered.leads.size,
            fillers: rendered.fillers.size,
            complete: rendered.complete,
          });
          /* Cleared only once it is whole, so a resumed warm re-renders into the same
             entry instead of handing the partial back and returning early. */
          if (rendered.complete) this.warming.delete(key);
          return rendered.complete;
        } catch (error: unknown) {
          // Never fatal. The next call synthesises live and tries again.
          this.log.error("could not warm audio for a voice", {
            voiceId,
            error: error instanceof Error ? error.message : String(error),
          });
          this.warming.delete(key);
          return true;
        }
      },
    });

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
    // Ingress does not yet know the direction, so warm both. Warming one leaves the other
    // synthesising live on the first turn.
    this.warmed(settings.voiceId, outboundOpener(settings.name), settings.speakingRate);
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
    if (this.config.listenWords === "intron") return this.openIntronWords(format);

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

  /**
   * Intron: the accent-tuned transcriber, and the reason the words half is swappable.
   *
   * Measured 2026-08-23 on `recordings/control-sikiru.ulaw`, clean and noisy: Intron
   * returned "Sikiru" from both. On live calls the same name came back from Flux as
   * "Abijo" and then "BQ BQ", each at confidence 1.000.
   *
   * What it costs is in the adapter, not here: no word confidence, no keyterms, and a
   * socket per turn because COMMIT closes the connection.
   */
  private openIntronWords(format: AudioFormat): TranscriptSource {
    if (this.config.intronApiKey === "") {
      // Louder than a 401 mid-call. A missing key is a deployment mistake and belongs at
      // the moment the choice is made, not in a caller's silence.
      throw new Error("LISTEN_WORDS=intron requires INTRON_API_KEY");
    }
    this.log.info("transcription via intron", {
      host: this.config.intronHost,
      language: this.config.intronLanguage,
      sampleRate: format.sampleRate,
    });
    return openIntronSession((url) => openIntronSocket(url, this.config.intronApiKey), {
      host: this.config.intronHost,
      format,
      language: this.config.intronLanguage as IntronLanguage,
      log: this.log,
      startedAtMs: Date.now(),
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
    /* Whether *we* were the reason frames went missing.
     *
       `missingMs` proves the carrier numbered frames we never received, and stops there —
       it cannot tell a packet lost between Lagos and us from one Twilio discarded because
       this process was too busy to read the socket. Twilio drops inbound media it cannot
       deliver rather than buffering it, so a stalled event loop and a bad international
       leg produce byte-identical accounting. This is the discriminator: a loop that stays
       responsive while audio disappears puts the loss on the network, and a loop that
       stalls for seconds puts it here. */
    const loopDelay = monitorEventLoopDelay({ resolution: LOOP_SAMPLE_MS });
    loopDelay.enable();
    /* Counted here rather than at ingress because this is where the competition actually
       is: the socket is what warming starves. */
    this.warmer.callStarted();
    let frames = 0;
    /** The carrier's clock on the previous frame, for spotting frames it numbered but never delivered. */
    let previousOffsetMs: number | null = null;
    /** Milliseconds of audio the carrier numbered and we never received. */
    let missingMs = 0;
    /**
     * The shape of what went missing, which is the part `missingMs` cannot tell you.
     *
     * A total says how much is absent and nothing about why. Steady packet loss on a bad
     * leg arrives as many gaps of a frame or two; a network that suppresses silence — most
     * mobile carriers do, and stop sending RTP entirely when nobody is talking — arrives as
     * a handful of gaps seconds long, aligned with the pauses. Both produce the same
     * `missingMs`, and reading it as loss cost several calls' worth of wrong conclusions.
     */
    let gaps = 0;
    let shortGaps = 0;
    let longGapMs = 0;
    let largestGapMs = 0;
    let bytes = 0;
    let firstFrameLogged = false;
    let firstOffsetMs: number | null = null;

    log.info("media stream started", {
      encoding: stream.format.encoding,
      sampleRate: stream.format.sampleRate,
    });

    stream.onAudio((chunk) => {
      frames += 1;
      bytes += chunk.data.length;

      if (!firstFrameLogged) {
        firstFrameLogged = true;
        firstOffsetMs = chunk.offsetMs;
        log.info("first inbound audio frame", {
          bytes: chunk.data.length,
          msSinceStreamStart: Date.now() - openedAt,
          // The carrier's own clock on that first frame. Ours says when we saw it; this
          // says when the carrier believes the caller said it, and the two answer
          // different questions when audio goes missing.
          carrierOffsetMs: chunk.offsetMs,
        });
      }

      /* Whether the carrier's own timestamps are contiguous.
       *
       * Every frame is 20ms, so consecutive timestamps advance by 20. A larger step means
       * frames the carrier numbered and we never received; a step of 20 throughout means
       * we received everything it sent and any shortfall is audio it never sent at all.
       * Those are opposite problems with opposite fixes, and four calls were spent
       * arguing about which one this is. */
      if (previousOffsetMs !== null) {
        const step = chunk.offsetMs - previousOffsetMs;
        if (step > FRAME_MS) {
          const lost = step - FRAME_MS;
          missingMs += lost;
          gaps += 1;
          if (lost <= SHORT_GAP_MS) shortGaps += 1;
          else longGapMs += lost;
          largestGapMs = Math.max(largestGapMs, lost);
        }
      }
      previousOffsetMs = chunk.offsetMs;

      // The carrier sends a 20ms frame every 20ms, so this is one line per second.
      if (frames % 50 === 0) {
        log.debug("inbound audio", { frames, bytes, carrierOffsetMs: chunk.offsetMs, missingMs });
      }
    });

    stream.onClosed((reason) => {
      loopDelay.disable();
      this.warmer.callEnded();
      log.info("media stream closed", {
        reason,
        /* Milliseconds late, not milliseconds elapsed — see `overSample`. Healthy is
           single digits; anything approaching a frame means we were not reading the
           socket when the carrier needed us to. */
        loopDelayP50Ms: overSample(loopDelay.percentile(50)),
        loopDelayP99Ms: overSample(loopDelay.percentile(99)),
        loopDelayMaxMs: overSample(loopDelay.max),
        /* `missingMs` is the verdict. Zero with a short call means the carrier stopped
           sending; a large number means it sent and the frames were lost on the way. */
        missingMs,
        /* Where the missing milliseconds actually went. Many short gaps is a lossy leg;
           a few long ones is a caller who was not talking. */
        gaps,
        shortGaps,
        longGapMs,
        largestGapMs,
        /* Nothing arrived before this, and it is not counted in `missingMs` — which only
           measures between frames it saw. A large value here is its own finding. */
        silentLeadInMs: firstOffsetMs ?? 0,
        carrierSpanMs: previousOffsetMs ?? 0,
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
    // Read before the pre-render, because it decides what gets rendered.
    const direction: CallDirection =
      stream.parameters[DIRECTION_PARAM] === "outbound" ? "outbound" : "inbound";

    const opening =
      direction === "outbound" ? outboundOpener(settings.name) : settings.greeting;

    // Keyed on the text, so the two openings are two entries and neither evicts the other.
    const warm = this.warmed(settings.voiceId, opening, settings.speakingRate);

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

    /**
     * What a machine hears, if one answers.
     *
     * Only what identifies us and how to ring back. **Never an amount, a balance, an
     * account detail, or anything about why we called** — an answerphone is played out
     * loud in a room, and whoever is in it did not consent to hearing somebody else's
     * business. That constraint is why this is composed from two fields and not from the
     * call's own context.
     *
     * Composed only when both halves exist. A message that cannot say who rang or how to
     * call back is worse than the silence it replaces, so a missing one falls back to
     * hanging up — which is what every call did before this.
     */
    const callbackNumber = stream.parameters[DIALLED_PARAM] ?? null;
    if (settings.name !== "" && callbackNumber !== null) {
      this.voicemail.set(
        stream.callId,
        `Hello, this is ${settings.name}. We tried to reach you. Please call us back on ${callbackNumber} when you get a chance. Thank you.`,
      );
      stream.onClosed(() => this.voicemail.delete(stream.callId));
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
      const plain = { text: opening, audio: warm.greeting };
      if (warm.greeting === null) return plain;

      // The leads sit in front of an inbound greeting. `outboundOpener` brings its own, so
      // prepending one says "Good afternoon. Good day, this is Oakhaven Properties calling."
      if (direction === "outbound") return plain;

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
      return { text: `${lead} ${opening}`, audio: [...leadAudio, ...warm.greeting] };
    })();

    runConversation(stream, {
      // The answering agent's own switch (migration 0020), resolved with its config at
      // ingress so this costs no extra round trip on the answer path.
      bargeIn: settings.bargeIn,
      // The form this agent conducts, resolved with its config at ingress so the
      // director costs no extra round trip on the answer path.
      fields: settings.capturedFields,
      /* And the graph, for an agent drawn as one. Resolved at the same moment and from the
         same document, so what the agent asks and the order it asks in cannot come from two
         different reads of the configuration. Null for every agent authored as a form, which
         is every agent that existed before the canvas did. */
      flow: settings.flow,
      listen,
      facts,
      // Off unless the deployment turned it on. See `AppConfig.backchannel`.
      backchannel: this.config.backchannel,
      /* The same `direction` the recorder is given, so what the agent is told and what the
         call is written down as cannot disagree. Outbound loads a layer of prohibitions
         inbound does not — chiefly that a stranger must never be asked to verify
         themselves — and getting this wrong is the worst single thing here. */
      direction,
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
        /* On the call as well as on the list. The suppression row is global and carries no
           call and no direction, so this is the only thing that can attribute a request to
           the call that produced it — which is what makes a rising rate visible before it
           is visible in complaints. */
        record.event("do_not_call_recorded", { saidWhat });
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
          crisisDestination: settings.crisisHandoff,
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
