import type { AudioChunk, Logger } from "@ansa/shared";

import type { ListenSession } from "../orchestrator/orchestrator";

/**
 * One listen session assembled from two providers: one for words, one for turns.
 *
 * CLAUDE.md's table calls this the likely outcome and it is why Transcriber and
 * TurnDetector were split in the first place. Understanding *what* the caller said and
 * knowing *when* they stopped are different problems, and today the best provider for
 * each is not the same one — Deepgram Flux has model-native end-of-turn detection,
 * while transcription of Nigerian speech is a separate contest it does not obviously win.
 * Fused, you can only ever pick the better of two compromises.
 *
 * The orchestrator needs no changes to use this: it already consumes transcripts and
 * turn events as separate streams correlated by offsetMs, and R4.1.7 forbids it from
 * assuming they share a connection. This is the first time that has been literally true.
 *
 * Two costs worth being honest about. Running two providers doubles the STT bill, so
 * usage is logged per role and Gate A decides whether the result justifies it. And there
 * are now two connections that can fail independently — either one failing makes the
 * agent deaf in a way it cannot work around, so both are surfaced as a session failure.
 */
/**
 * What a transcriber has to offer, and nothing more.
 *
 * Narrower than `ListenSession` on purpose. When both halves were full sessions, "its
 * own turn events are ignored" was a convention held up by one line inside this function
 * — and the deployment spent weeks taking turn events from the wrong provider because
 * selecting one was a config value away. A words provider now has no turn events to
 * ignore, so the mistake cannot be made from a config file.
 */
export interface TranscriptSource {
  readonly transcripts: ListenSession["transcripts"];
  write(chunk: AudioChunk): void;
  /**
   * Ask for a final now, for a provider whose final only arrives when the client asks.
   *
   * Absent on providers that decide for themselves. Intron is the reason it exists: its
   * COMMIT is what produces a `COMMITTED_TRANSCRIPT`, and only this layer knows a turn
   * ended — the words half is deliberately blind to turns. Putting a silence timer in the
   * adapter instead would be a transcriber inventing endpointing, which is the fusion the
   * two interfaces exist to prevent.
   */
  commit?(): void;
  onFailure(listener: (reason: string) => void): void;
  onVendorError(listener: (message: string) => void): void;
  close(): void;
}

export const composeListen = (parts: {
  /** Supplies transcripts. It has no turn events — that is the point of the type. */
  readonly words: TranscriptSource;
  /** Supplies turn events. Its own transcripts are ignored. */
  readonly turns: ListenSession;
  readonly log: Logger;
  readonly wordsName: string;
  readonly turnsName: string;
}): ListenSession => {
  const { words, turns, log } = parts;
  let closed = false;

  // A failure in either half is a failure of the whole: the agent cannot transcribe
  // without words, and without turn events it never learns the caller has stopped. There
  // is no useful degraded mode, so do not invent one.
  const failureListeners: ((reason: string) => void)[] = [];
  const announceFailure = (role: string, reason: string): void => {
    log.error("a listen provider failed", { role, reason });
    for (const listener of failureListeners) listener(`${role}: ${reason}`);
  };

  words.onFailure((reason) => announceFailure(parts.wordsName, reason));
  turns.onFailure((reason) => announceFailure(parts.turnsName, reason));

  log.info("listening via two providers", {
    words: parts.wordsName,
    turns: parts.turnsName,
    commitsOnTurnEnd: words.commit !== undefined,
  });

  /* The correlation, in the one place that holds both halves. `onEndOfTurn` pushes rather
     than replaces, so this does not take the listener the orchestrator registers later. */
  if (words.commit !== undefined) {
    turns.turns.onEndOfTurn(() => {
      words.commit?.();
    });
  }

  return {
    // The single fan-out point R4.1.7 asks for. Both providers see identical audio, so a
    // transcript and a turn event can be correlated by offsetMs across connections.
    write: (chunk: AudioChunk) => {
      words.write(chunk);
      turns.write(chunk);
    },

    transcripts: words.transcripts,
    turns: turns.turns,

    onFailure: (listener) => failureListeners.push(listener),

    onVendorError: (listener) => {
      // Recoverable complaints are labelled, because "invalid frame" means nothing when
      // two vendors are on the line and only one of them is wrong.
      words.onVendorError((message) => listener(`${parts.wordsName}: ${message}`));
      turns.onVendorError((message) => listener(`${parts.turnsName}: ${message}`));
    },

    close: () => {
      // Idempotent and both-or-nothing: a half-closed pair leaks a socket per call, and
      // a throw from the first close must not strand the second.
      if (closed) return;
      closed = true;
      try {
        words.close();
      } finally {
        turns.close();
      }
    },
  };
};
