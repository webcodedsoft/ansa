import { muLawToPcm } from "@ansa/shared";
import type { AudioChunk, AudioFormat } from "@ansa/shared";
import type { Transcript, TranscriberSession } from "@ansa/transcriber";
import type { TurnEvent, TurnSession } from "@ansa/turn-detector";

import { encodeAudioAppend, encodeSessionUpdate, parseEvent, type TurnDetection, PCM_RATE } from "./protocol";

/**
 * A duplex text-frame transport. Injected so the session can be tested without a
 * network, and so this package never names a WebSocket library.
 */
export interface ListenSocket {
  onOpen(listener: () => void): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: (reason: string) => void): void;
  onError(listener: (error: Error) => void): void;
  send(data: string): void;
  close(): void;
}

export interface ListenConnectOptions {
  readonly format: AudioFormat;
  readonly model: string;
  readonly turnDetection: TurnDetection;
  readonly keyterms: readonly string[];
  /**
   * Transcode the carrier's mu-law to 24kHz PCM before sending.
   *
   * The provider documents audio/pcm at 24kHz and merely accepts audio/pcmu. Off by
   * default: this is a hypothesis about an already-poor channel, and Gate A settles it
   * with a measurement rather than a preference.
   */
  readonly sendAsPcm?: boolean;
}

/**
 * One connection, two interfaces.
 *
 * `transcripts` and `turns` are the separate streams the orchestrator consumes, exactly
 * as if they came from different vendors — which they may, after Gate A. They are
 * correlated by `offsetMs` and nothing here lets the orchestrator assume otherwise
 * (R4.1.7). Sharing a socket is this provider's implementation detail, not a contract.
 *
 * `write` is the single audio fan-out point (CLAUDE.md): the caller writes once.
 */
export interface OpenAiListenSession {
  readonly transcripts: TranscriberSession;
  readonly turns: TurnSession;
  write(chunk: AudioChunk): void;
  /**
   * The connection is gone and this session will never produce another transcript.
   * Fires at most once, and never for a close the caller asked for.
   *
   * Without this the agent goes silently deaf: the caller keeps talking to a line that
   * will never answer, which is the failure CLAUDE.md forbids above all others.
   */
  onFailure(listener: (reason: string) => void): void;
  /**
   * A non-fatal complaint from the vendor. Realtime `error` events are routinely
   * recoverable (a buffer too small to commit, say), so these must NOT end the call —
   * they are worth logging and nothing more.
   */
  onVendorError(listener: (message: string) => void): void;
  close(): void;
}

/** Three seconds of μ-law. A socket that never becomes ready must not grow forever. */
const MAX_PENDING_BYTES = 24_000;

/**
 * A session that has not confirmed its configuration by now never will, and a session
 * that is not configured produces no transcripts at all — an agent that cannot hear.
 */
const READY_TIMEOUT_MS = 6_000;

const BYTES_PER_MS_MULAW_8K = 8;

export const openListenSession = (
  socket: ListenSocket,
  options: ListenConnectOptions,
): OpenAiListenSession => {
  const interim: ((t: Transcript) => void)[] = [];
  const final: ((t: Transcript) => void)[] = [];
  const speechStart: ((e: TurnEvent) => void)[] = [];
  const endOfTurn: ((e: TurnEvent) => void)[] = [];
  const turnResumed: ((e: TurnEvent) => void)[] = [];
  const eagerEndOfTurn: ((e: TurnEvent) => void)[] = [];

  const failureListeners: ((reason: string) => void)[] = [];
  const vendorErrorListeners: ((message: string) => void)[] = [];

  let ready = false;
  let closed = false;
  let failed = false;
  let triedFallback = false;
  let bytesWritten = 0;
  let pendingBytes = 0;
  /**
   * Where the speech currently being transcribed began. A transcript's offset is then
   * "when this utterance started" rather than "when its text happened to arrive", which
   * is what R4.1.7 needs to correlate the two streams — and what lets the orchestrator
   * recognise a transcript as belonging to a speech segment it already judged to be echo.
   */
  let segmentStartMs: number | null = null;
  // Frames that arrive before the session is configured would be discarded by the
  // vendor, taking the first word of the call with them.
  const pending: Buffer[] = [];

  const streamOffsetMs = (): number => Math.round(bytesWritten / BYTES_PER_MS_MULAW_8K);

  const fail = (reason: string): void => {
    // A close we asked for is not a failure, and a failure is reported once.
    if (failed || closed) return;
    failed = true;
    for (const listener of failureListeners) listener(reason);
  };

  socket.onOpen(() => {
    socket.send(encodeSessionUpdate(options));

    // Configuration is not optional: without it there is no turn detection and no
    // transcript, ever. Seen on a live call — a transcription model that does not
    // support semantic turn detection left the agent deaf for the whole call while the
    // rejection was logged as a recoverable warning and nothing else happened.
    const readyTimer = setTimeout(() => {
      if (!ready) fail("listen session never confirmed its configuration");
    }, READY_TIMEOUT_MS);
    readyTimer.unref();
  });

  socket.onClose((reason) => {
    fail(reason);
  });

  socket.onError((error) => {
    fail(error.message);
  });

  socket.onMessage((raw) => {
    const event = parseEvent(raw);
    if (event === null) return;

    switch (event.kind) {
      case "ready": {
        if (ready) return;
        ready = true;
        for (const buffered of pending) socket.send(encodeAudioAppend(buffered));
        pending.length = 0;
        pendingBytes = 0;
        return;
      }
      case "speechStart": {
        const at = { offsetMs: event.offsetMs ?? streamOffsetMs() };
        segmentStartMs = at.offsetMs;
        for (const l of speechStart) l(at);
        return;
      }
      case "endOfTurn": {
        const at = { offsetMs: event.offsetMs ?? streamOffsetMs() };
        for (const l of endOfTurn) l(at);
        return;
      }
      case "interim": {
        const t: Transcript = {
          text: event.text,
          words: [],
          confidence: null,
          offsetMs: streamOffsetMs(),
        };
        for (const l of interim) l(t);
        return;
      }
      case "final": {
        const startedAt = segmentStartMs;
        segmentStartMs = null;
        const t: Transcript = {
          text: event.text,
          // This provider reports neither word timings nor confidence. That is a real
          // gap against R4.1.5 and belongs in the Gate A comparison, not hidden behind
          // an invented number.
          words: [],
          confidence: null,
          offsetMs: startedAt ?? streamOffsetMs(),
        };
        for (const l of final) l(t);
        return;
      }
      case "error": {
        for (const listener of vendorErrorListeners) listener(event.message);

        // Some models reject the turn-detection mode we asked for. Degrade to the
        // stopwatch rather than run deaf: worse turn-taking is recoverable, no turn
        // detection at all is not.
        if (!ready && !triedFallback && /turn detection/i.test(event.message)) {
          triedFallback = true;
          socket.send(
            encodeSessionUpdate({
              ...options,
              turnDetection: { type: "server_vad", silenceMs: 700 },
            }),
          );
          return;
        }

        // Otherwise not terminal: the vendor emits these for recoverable conditions,
        // and treating one as fatal would end calls that were fine.
        return;
      }
    }
  });

  /**
   * Carrier bytes to wire bytes. Identity unless the session was opened asking for PCM,
   * in which case every frame is decoded and resampled on the way out.
   */
  const toWire = (data: Buffer): Buffer =>
    options.sendAsPcm === true ? muLawToPcm(data, options.format.sampleRate, PCM_RATE) : data;

  const write = (chunk: AudioChunk): void => {
    if (closed) return;

    // Byte accounting stays in CARRIER bytes, always. It is how offsets and durations are
    // derived, and PCM at 24kHz is six times the size — counting those would silently
    // multiply every timing in the call by six.
    bytesWritten += chunk.data.length;

    const outgoing = toWire(chunk.data);
    if (!ready) {
      pending.push(outgoing);
      pendingBytes += outgoing.length;
      // Drop the oldest audio rather than grow without bound if readiness never comes.
      while (pendingBytes > MAX_PENDING_BYTES) {
        const dropped = pending.shift();
        if (dropped === undefined) break;
        pendingBytes -= dropped.length;
      }
      return;
    }
    socket.send(encodeAudioAppend(outgoing));
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    socket.close();
  };

  return {
    transcripts: {
      write,
      onInterim: (l) => interim.push(l),
      onFinal: (l) => final.push(l),
      close,
    },
    turns: {
      write,
      onSpeechStart: (l) => speechStart.push(l),
      // server_vad has no speculative end-of-turn, so these never fire. Registering
      // them is harmless; relying on them would not be. R4.1.6 makes eager EOT
      // optional precisely because providers differ here, and this is a mark against
      // this one at Gate A.
      onEagerEndOfTurn: (l) => eagerEndOfTurn.push(l),
      onEndOfTurn: (l) => endOfTurn.push(l),
      onTurnResumed: (l) => turnResumed.push(l),
      close,
    },
    write,
    onFailure: (listener) => failureListeners.push(listener),
    onVendorError: (listener) => vendorErrorListeners.push(listener),
    close,
  };
};
