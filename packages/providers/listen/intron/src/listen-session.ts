import { muLawToPcm, type AudioChunk, type Logger } from "@ansa/shared";
import type { Transcript, TranscriberSession } from "@ansa/transcriber";

import {
  buildUrl,
  encodeAudioChunk,
  encodeCommit,
  padToFloor,
  parseEvent,
  splitForSend,
  SESSION_LIMIT_MS,
  type IntronOptions,
} from "./protocol";

/**
 * Intron as the words half of the listen layer. It has no turn events, by design and by
 * vendor: this implements the transcriber and nothing else, so the mistake of letting a
 * words provider decide when a caller stopped cannot be made from a config file.
 *
 * Everything below follows from three things probed against the live API on 2026-08-23:
 *
 * - **8000 Hz is accepted** and echoed back in `SESSION_CREATED.configs`, so telephony
 *   audio is transcoded from mu-law to PCM16 at its own rate and never upsampled.
 * - **COMMIT closes the socket.** Not the utterance — the connection, with close code
 *   1000. One committed transcript per connection, so a call needs one connection per
 *   turn.
 * - **A new session takes 659ms at the median** to reach `SESSION_CREATED`. That is three
 *   times the whole current turn-to-audio budget, so it can never be paid while a caller
 *   waits. The next socket is opened as soon as the previous one commits, which is while
 *   the agent is still speaking its reply.
 */

export interface IntronSocket {
  onOpen(listener: () => void): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: (reason: string) => void): void;
  onError(listener: (error: Error) => void): void;
  send(data: string): void;
  close(): void;
}

export interface IntronConnectOptions extends IntronOptions {
  readonly host: string;
  readonly log: Logger;
  /** Milliseconds since the media stream opened, for `Transcript.offsetMs`. */
  readonly startedAtMs: number;
}

/**
 * The transcriber, plus the one thing a transcriber does not normally have.
 *
 * `commit` exists because this vendor's final only arrives when the client asks for it,
 * and only the composite layer knows when a turn ended. Widening the type is the honest
 * move: hiding it behind a silence timer here would be this package inventing endpointing,
 * which is the exact fusion the two-interface split exists to prevent.
 */
export interface IntronListenSession {
  readonly transcripts: TranscriberSession;
  write(chunk: AudioChunk): void;
  /** End the current turn and ask for its transcript. Rotates to the next socket. */
  commit(): void;
  onFailure(listener: (reason: string) => void): void;
  onVendorError(listener: (message: string) => void): void;
  close(): void;
}

/** One socket's worth of state. A call goes through many of these. */
interface Leg {
  readonly socket: IntronSocket;
  ready: boolean;
  /** Audio written before `SESSION_CREATED`, replayed on ready so no word is lost. */
  backlog: Buffer;
  /** Bytes not yet at the 1 KB floor. */
  pending: Buffer;
  ack: number;
  committed: boolean;
  openedAtMs: number;
}

export const openIntronSession = (
  connect: (url: string) => IntronSocket,
  options: IntronConnectOptions,
): IntronListenSession => {
  const { log } = options;
  const url = buildUrl(options.host, options);

  const interim: ((t: Transcript) => void)[] = [];
  const finals: ((t: Transcript) => void)[] = [];
  const failures: ((reason: string) => void)[] = [];
  const vendorErrors: ((message: string) => void)[] = [];

  let current: Leg | null = null;
  let next: Leg | null = null;
  let closed = false;
  let failed = false;

  const fail = (reason: string): void => {
    if (closed || failed) return;
    failed = true;
    log.error("intron listen failed", { reason });
    for (const listener of failures) listener(reason);
  };

  const transcript = (text: string): Transcript => ({
    text,
    // This provider reports neither word timings nor confidence. Null is not low — see
    // the Transcript docs — and inventing either would be worse than the gap.
    words: [],
    confidence: null,
    offsetMs: Date.now() - options.startedAtMs,
  });

  const flush = (leg: Leg): void => {
    const { send, rest } = splitForSend(leg.pending);
    leg.pending = rest;
    for (const chunk of send) {
      leg.ack += 1;
      leg.socket.send(encodeAudioChunk(chunk, leg.ack));
    }
  };

  const openLeg = (): Leg => {
    const socket = connect(url);
    const leg: Leg = {
      socket,
      ready: false,
      backlog: Buffer.alloc(0),
      pending: Buffer.alloc(0),
      ack: 0,
      committed: false,
      openedAtMs: Date.now(),
    };

    socket.onMessage((raw) => {
      const event = parseEvent(raw);
      if (event === null || event.kind === "ack") return;

      switch (event.kind) {
        case "ready": {
          leg.ready = true;
          if (event.sampleRate !== (options.sampleRate ?? options.format.sampleRate)) {
            // Not fatal, but it means the audio is being read at a rate it was not sent
            // at, which is heard as the wrong pitch and transcribed as nonsense.
            log.warn("intron applied a different sample rate", {
              asked: options.sampleRate ?? options.format.sampleRate,
              applied: event.sampleRate,
            });
          }
          leg.pending = Buffer.concat([leg.backlog, leg.pending]);
          leg.backlog = Buffer.alloc(0);
          flush(leg);
          return;
        }
        case "interim": {
          if (leg !== current) return;
          for (const listener of interim) listener(transcript(event.text));
          return;
        }
        case "final": {
          if (leg !== current) return;
          for (const listener of finals) listener(transcript(event.text));
          return;
        }
        case "desynced": {
          /* The counter is out of step and nothing sent on this leg will be accepted
             again. Replacing it is the only recovery, and the pre-opened leg is what
             makes that cost nothing the caller can hear. */
          log.warn("intron rejected a chunk; replacing the leg", { detail: event.detail });
          for (const listener of vendorErrors) listener(`intron: ${event.detail}`);
          if (leg === current) rotate();
          return;
        }
        case "expired": {
          // The 300s ceiling with no resume. Rotating early is what stops a caller
          // mid-sentence falling into a closed socket.
          log.warn("intron session hit its lifetime ceiling", { ageMs: Date.now() - leg.openedAtMs });
          rotate();
          return;
        }
        default: {
          for (const listener of vendorErrors) listener(`intron: ${event.type}`);
        }
      }
    });

    socket.onError((error) => {
      for (const listener of vendorErrors) listener(`intron: ${error.message}`);
    });

    socket.onClose((reason) => {
      if (closed) return;
      // A close after our own COMMIT is the documented end of a leg, not a failure.
      if (leg.committed) return;
      if (leg === current || leg === next) fail(`socket closed: ${reason}`);
    });

    return leg;
  };

  /**
   * Promote the pre-opened socket and start warming another.
   *
   * The promotion is why the 659ms is invisible: by the time the caller speaks again the
   * next leg has been connecting for as long as the agent has been talking.
   */
  const rotate = (): void => {
    if (closed) return;
    const promoted = next ?? openLeg();
    current = promoted;
    next = openLeg();
  };

  current = openLeg();
  next = openLeg();

  return {
    transcripts: {
      write: () => {
        // The session's own `write` is the fan-out point. A second one here would let a
        // caller feed the transcriber without the turn detector seeing the same audio.
        throw new Error("write audio through the session, not through transcripts");
      },
      onInterim: (listener) => interim.push(listener),
      onFinal: (listener) => finals.push(listener),
      close: () => {},
    },

    write: (chunk: AudioChunk) => {
      if (closed || current === null) return;
      const pcm =
        options.format.encoding === "mulaw"
          ? muLawToPcm(chunk.data, options.format.sampleRate, options.sampleRate ?? options.format.sampleRate)
          : chunk.data;

      // Both legs are fed. The next one is already connected and its audio is what makes
      // it useful the instant it is promoted — a socket promoted cold would start the
      // turn deaf to whatever the caller said while it was being opened.
      for (const leg of [current, next]) {
        if (leg === null) continue;
        if (!leg.ready) {
          leg.backlog = Buffer.concat([leg.backlog, pcm]);
          continue;
        }
        leg.pending = Buffer.concat([leg.pending, pcm]);
        flush(leg);
      }

      /* The ceiling is 300s and there is no resume, so rotate on age rather than waiting
         for the server to say so. A rotation the caller cannot hear is the whole point. */
      if (Date.now() - current.openedAtMs > SESSION_LIMIT_MS - 30_000) rotate();
    },

    commit: () => {
      if (closed || current === null || current.committed) return;
      const leg = current;
      leg.committed = true;
      // Everything under the floor still has to go, or the tail of the turn — which is
      // where the answer usually is — never reaches the model.
      if (leg.pending.length > 0) {
        leg.ack += 1;
        // Padded, never short. A sub-floor chunk is refused and the refusal takes the
        // whole session with it — see MIN_CHUNK_BYTES.
        leg.socket.send(encodeAudioChunk(padToFloor(leg.pending), leg.ack));
        leg.pending = Buffer.alloc(0);
      }
      leg.socket.send(encodeCommit());
      // Not rotated yet: the final still arrives on this leg, and `current` is what
      // decides whether a transcript is delivered.
    },

    onFailure: (listener) => failures.push(listener),
    onVendorError: (listener) => vendorErrors.push(listener),

    close: () => {
      if (closed) return;
      closed = true;
      for (const leg of [current, next]) {
        try {
          leg?.socket.close();
        } catch {
          // Closing a socket that is already gone is not an error worth surfacing.
        }
      }
      current = null;
      next = null;
    },
  };
};
