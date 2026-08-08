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
export const composeListen = (parts: {
  /** Supplies transcripts. Its own turn events are ignored. */
  readonly words: ListenSession;
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
  });

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
