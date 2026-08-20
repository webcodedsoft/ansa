import type { Buffer } from "node:buffer";

import type { AudioChunk } from "@ansa/shared";
import type { Transcript, TranscriberSession, Word } from "@ansa/transcriber";
import type { TurnEvent, TurnSession } from "@ansa/turn-detector";

import { buildUrl, parseEvent, type DeepgramWord } from "./protocol";

/**
 * A duplex socket carrying JSON text one way and raw binary audio the other.
 *
 * Deliberately not the same shape as the OpenAI adapter's socket: Deepgram takes μ-law
 * bytes as binary WebSocket frames with no base64 and no JSON envelope, so `send` has to
 * accept a Buffer. Sharing one interface would mean widening the other adapter's
 * contract for a capability it does not have.
 */
export interface DeepgramSocket {
  onOpen(listener: () => void): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: (reason: string) => void): void;
  onError(listener: (error: Error) => void): void;
  send(data: Buffer): void;
  close(): void;
}

/**
 * One connection, two interfaces — the same shape the OpenAI adapter exposes, so which
 * provider is listening is a construction detail rather than a code change.
 *
 * Flux carries the transcript, per-word confidence and end-of-turn confidence in the
 * same frame, so a second socket for turn events would double the listen bill (R4.1.9)
 * for data already in hand.
 */
export interface DeepgramListenSession {
  readonly transcripts: TranscriberSession;
  readonly turns: TurnSession;
  write(chunk: AudioChunk): void;
  onFailure(listener: (reason: string) => void): void;
  onVendorError(listener: (message: string) => void): void;
  close(): void;
}

const BYTES_PER_MS_MULAW_8K = 8;

/** Three seconds of μ-law. A socket that never opens must not buffer without bound. */
const MAX_PENDING_BYTES = 24_000;

const toWords = (words: readonly DeepgramWord[]): Word[] =>
  words.map((w) => ({
    text: w.text,
    // Flux reports confidence per word but not word timings. Absent boundaries are left
    // at the turn offset rather than invented.
    startMs: 0,
    endMs: 0,
    confidence: w.confidence,
  }));

/** Mean of the per-word confidences, or null when the provider reported none. */
const meanConfidence = (words: readonly DeepgramWord[]): number | null =>
  words.length === 0 ? null : words.reduce((n, w) => n + w.confidence, 0) / words.length;

/** Waits between redials. Four attempts, then the call is deaf and has to say so. */
const BACKOFF_MS: readonly number[] = [250, 500, 1000, 2000];

export interface DeepgramSessionOptions {
  /** Injected so the backoff can be driven in a test without waiting for it. */
  readonly schedule?: (run: () => void, ms: number) => void;
}

/**
 * Dials Deepgram, and dials again if the socket drops mid-call.
 *
 * Takes a factory rather than a socket because of the reconnect: a dropped WebSocket
 * cannot be reopened, only replaced, and the URL — model, keyterms, thresholds, built
 * once by the caller with `buildUrl` — has to survive the replacement.
 *
 * A drop used to end the call's hearing outright. Flux is now the only source of turn
 * events, so a socket that closes at second forty of a two-minute call takes the agent's
 * ability to know the caller has stopped talking with it; there is no degraded mode to
 * fall back to. Four redials on a 250ms–2s backoff cover a transient close without
 * making a genuinely dead connection look alive for long.
 *
 * Audio written while the socket is down goes into the same bounded buffer that already
 * covers the pre-open window, and is flushed on reopen — so a caller mid-sentence during
 * a blip is heard rather than lost. The bound stays three seconds: past that the words
 * are too old to act on and dropping the oldest is the honest failure.
 */
export const openDeepgramSession = (
  connect: () => DeepgramSocket,
  options: DeepgramSessionOptions = {},
): DeepgramListenSession => {
  const schedule = options.schedule ?? ((run, ms) => void setTimeout(run, ms));
  const interim: ((t: Transcript) => void)[] = [];
  const final: ((t: Transcript) => void)[] = [];
  const speechStart: ((e: TurnEvent) => void)[] = [];
  const endOfTurn: ((e: TurnEvent) => void)[] = [];
  const eager: ((e: TurnEvent) => void)[] = [];
  const resumed: ((e: TurnEvent) => void)[] = [];
  const failureListeners: ((reason: string) => void)[] = [];
  const vendorErrorListeners: ((message: string) => void)[] = [];

  let socket: DeepgramSocket;
  let open = false;
  let closed = false;
  let failed = false;
  let redials = 0;
  let bytesWritten = 0;
  let pendingBytes = 0;
  const pending: Buffer[] = [];

  /**
   * Our own byte counter, not Deepgram's `audio_window_end`.
   *
   * Measured on the live API: their audio clock runs 270–300ms behind bytes written,
   * consistently. The orchestrator correlates transcripts against turn events on this
   * number and matches echo-suppressed segments by exact equality, so a drifting clock
   * would break both.
   */
  const streamOffsetMs = (): number => Math.round(bytesWritten / BYTES_PER_MS_MULAW_8K);

  const fail = (reason: string): void => {
    if (failed || closed) return;
    failed = true;
    for (const listener of failureListeners) listener(reason);
  };

  /**
   * A close we did not ask for.
   *
   * Redials while attempts remain, and only reports failure once they are spent — the
   * orchestrator treats a listen failure as the call being deaf, so announcing it for a
   * blip that recovers in 250ms would end calls that were fine.
   *
   * `redials` is deliberately never reset on a successful reopen. A socket that drops
   * four times in a call is not having four transient blips, and continuing to redial a
   * connection that keeps dying hides a real outage behind an agent that hears every
   * other sentence.
   */
  const dropped = (reason: string): void => {
    if (closed || failed) return;
    open = false;

    const wait = BACKOFF_MS[redials];
    if (wait === undefined) {
      fail(`${reason} (gave up after ${BACKOFF_MS.length} redials)`);
      return;
    }
    redials += 1;
    schedule(() => {
      if (closed || failed) return;
      dial();
    }, wait);
  };

  const dial = (): void => {
    socket = connect();

    socket.onOpen(() => {
      open = true;
      // Whatever the caller said while we were down, in order. The bound above has
      // already dropped anything too old to be worth acting on.
      for (const buffered of pending) socket.send(buffered);
      pending.length = 0;
      pendingBytes = 0;
    });

    socket.onClose(dropped);
    socket.onError((error) => {
      dropped(error.message);
    });

    socket.onMessage((raw) => {
      const event = parseEvent(raw);
      if (event === null) return;

      switch (event.kind) {
        case "connected":
          return;
        case "speechStart":
          for (const l of speechStart) l({ offsetMs: streamOffsetMs() });
          return;
        case "interim": {
          if (event.text.length === 0) return;
          const t: Transcript = {
            text: event.text,
            words: toWords(event.words),
            confidence: meanConfidence(event.words),
            offsetMs: streamOffsetMs(),
          };
          for (const l of interim) l(t);
          return;
        }
        case "endOfTurn": {
          const t: Transcript = {
            text: event.text,
            words: toWords(event.words),
            confidence: meanConfidence(event.words),
            offsetMs: streamOffsetMs(),
          };
          // Turn event first, then the transcript.
          //
          // Flux delivers both in the same frame, so the order is ours to choose — and the
          // orchestrator starts its stt_final timer on the turn event and stops it on the
          // transcript. Emitting the transcript first measured each turn against the
          // previous one: a live call reported 12.7s for a stage that actually takes none.
          // It also arms the thinking-filler at the wrong moment.
          //
          // Getting the transcript at end-of-turn with no wait is this provider's real
          // advantage over one that transcribes afterwards; the ordering should show that
          // as ~0ms rather than hide it.
          for (const l of endOfTurn) l({ offsetMs: streamOffsetMs() });
          if (event.text.length > 0) for (const l of final) l(t);
          return;
        }
        case "error":
          for (const l of vendorErrorListeners) l(event.message);
          return;
      }
    });
  };

  dial();

  const write = (chunk: AudioChunk): void => {
    if (closed) return;
    bytesWritten += chunk.data.length;
    if (!open) {
      pending.push(chunk.data);
      pendingBytes += chunk.data.length;
      while (pendingBytes > MAX_PENDING_BYTES) {
        const oldest = pending.shift();
        if (oldest === undefined) break;
        pendingBytes -= oldest.length;
      }
      return;
    }
    // Raw binary. Verified: the carrier's own 20ms/160-byte frames transcribe identically
    // to coalesced 80ms chunks, so they are forwarded untouched.
    socket.send(chunk.data);
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
      // Only fire when eager_eot_threshold is set, which it deliberately is not:
      // R4.1.8 forbids speculative work without proven cancellation, and Deepgram's own
      // guidance puts the cost at 50-70% more LLM calls to save ~200ms.
      onEagerEndOfTurn: (l) => eager.push(l),
      onEndOfTurn: (l) => endOfTurn.push(l),
      onTurnResumed: (l) => resumed.push(l),
      close,
    },
    write,
    onFailure: (l) => failureListeners.push(l),
    onVendorError: (l) => vendorErrorListeners.push(l),
    close,
  };
};

export { buildUrl };
