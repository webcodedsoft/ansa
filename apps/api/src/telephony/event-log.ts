import {
  recordCallEnded,
  recordCallEvents,
  recordCallStarted,
  recordLatencies,
  recordTranscripts,
  recordTurns,
  type Db,
  type RecordedLatency,
  type RecordedTranscript,
  type RecordedTurn,
  type StartedCall,
} from "@ansa/db";
import type { Logger } from "@ansa/shared";

/**
 * The call recorder, as the call path sees it.
 *
 * Two properties matter more than anything it stores.
 *
 * **A write failing must never affect the call.** The caller is mid-conversation and a
 * database hiccup is not their problem, so nothing here rejects, nothing here throws, and
 * every failure is reported to the logger and swallowed. This is the one place in the
 * codebase where swallowing an error is correct rather than lazy.
 *
 * **Events are buffered, not written one by one.** A call produces hundreds of them and
 * a round trip to Ohio is a fifth of a second; writing each as it happens would put the
 * database on the conversation's critical path, which is exactly what a recorder must
 * never be.
 */
export interface CallRecorder {
  /** Fire and forget. Every later call is a no-op until this resolves. */
  started(call: StartedCall): void;
  event(kind: string, detail?: Readonly<Record<string, unknown>>, offsetMs?: number): void;
  /**
   * A final transcript, as the transcriber produced it.
   *
   * Its own table rather than an event, because this is where the R9.2 loop lives:
   * `corrected_text` alongside it is a human's correction, and the pair is what turns one
   * caller's mishearing into a keyterm and a test case for every organization.
   */
  transcript(transcript: RecordedTranscript): void;
  /**
   * One side's turn, once it is over.
   *
   * Recorded at the end rather than the start, because a turn's most interesting property
   * is how it finished — played out, or cut off mid-sentence by the caller — and neither
   * is known when it begins.
   */
  turn(turn: RecordedTurn): void;
  /**
   * One stage of one turn, timed.
   *
   * The same number also goes to the event log as a `latency` event, and that is not an
   * oversight. The event log keeps the per-call story and every call recorded before this
   * table was written to; this keeps it in a shape a range across a week can index. Both
   * come off one `measure()` call, so they cannot disagree.
   */
  latency(latency: RecordedLatency): void;
  ended(reason: string, carrierStatus?: string | null, durationSeconds?: number | null): void;
}

/** Used when there is no database. The call path must not care which it has. */
export const nullRecorder: CallRecorder = {
  started: () => undefined,
  event: () => undefined,
  transcript: () => undefined,
  turn: () => undefined,
  latency: () => undefined,
  ended: () => undefined,
};

/** How many events to hold before writing. Bounded so a long call cannot grow without limit. */
const FLUSH_AT = 25;
const FLUSH_EVERY_MS = 5_000;

export const createCallRecorder = (deps: {
  readonly dataSource: Db | null;
  readonly log: Logger;
}): CallRecorder => {
  if (deps.dataSource === null) return nullRecorder;
  const { dataSource, log } = deps;

  let organizationId: StartedCall["organizationId"] | null = null;
  let callRowId: string | null = null;
  // Buffered before the insert returns an id as well as after: the first seconds of a
  // call are the ones worth having, and dropping them because the row did not exist yet
  // would lose the greeting and the first caller turn every time.
  let buffer: { kind: string; offsetMs?: number | null; detail?: Readonly<Record<string, unknown>> }[] = [];
  let transcripts: RecordedTranscript[] = [];
  let turns: RecordedTurn[] = [];
  let latencies: RecordedLatency[] = [];
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  /**
   * An ending that arrived before the call row existed.
   *
   * Found by driving the real recorder against the real database: a call that ends before
   * the insert returns had its ending dropped outright — no end_reason, no duration, the
   * row left open forever. Unit tests missed it because they waited for the insert first,
   * which is exactly the kindness a test should not extend.
   *
   * On a normal call the insert wins the race easily. The calls that lose it are the short
   * ones — rang out, hung up immediately, database slow — and those are precisely the
   * calls worth being able to explain afterwards.
   */
  let pendingEnd: Parameters<CallRecorder["ended"]> | null = null;

  const closeRow = (reason: string, carrierStatus?: string | null, durationSeconds?: number | null): void => {
    if (callRowId === null || organizationId === null) return;
    void recordCallEnded(dataSource, {
      organizationId,
      callRowId,
      endReason: reason,
      carrierStatus: carrierStatus ?? null,
      durationSeconds: durationSeconds ?? null,
    }).catch((error: unknown) => {
      log.error("could not close the call record", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const flush = (): void => {
    if (callRowId === null || organizationId === null) return;

    if (transcripts.length > 0) {
      const words = transcripts;
      transcripts = [];
      void recordTranscripts(dataSource, organizationId, callRowId, words).catch((error: unknown) => {
        log.error("could not write transcripts", {
          dropped: words.length,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (turns.length > 0) {
      const batch = turns;
      turns = [];
      void recordTurns(dataSource, organizationId, callRowId, batch).catch((error: unknown) => {
        log.error("could not write turns", {
          dropped: batch.length,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (latencies.length > 0) {
      const batch = latencies;
      latencies = [];
      void recordLatencies(dataSource, organizationId, callRowId, batch).catch((error: unknown) => {
        log.error("could not write latencies", {
          dropped: batch.length,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    void recordCallEvents(dataSource, organizationId, callRowId, batch).catch((error: unknown) => {
      log.error("could not write call events", {
        dropped: batch.length,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const arm = (): void => {
    if (timer !== null || closed) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, FLUSH_EVERY_MS);
    timer.unref();
  };

  return {
    started: (call) => {
      organizationId = call.organizationId;
      void recordCallStarted(dataSource, call)
        .then((id) => {
          callRowId = id;
          flush();
          // The call may already be over. Apply the ending that had nowhere to go.
          if (pendingEnd !== null) {
            const [reason, carrierStatus, durationSeconds] = pendingEnd;
            pendingEnd = null;
            closeRow(reason, carrierStatus, durationSeconds);
          }
        })
        .catch((error: unknown) => {
          log.error("could not record the call, so nothing about it will be stored", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },

    event: (kind, detail, offsetMs) => {
      if (closed) return;
      buffer.push({ kind, detail: detail ?? {}, offsetMs: offsetMs ?? null });
      // Bounded rather than unbounded: a call that never flushes, because the row insert
      // failed, must not accumulate for its whole duration.
      if (buffer.length > FLUSH_AT * 4) buffer = buffer.slice(-FLUSH_AT * 4);
      if (buffer.length >= FLUSH_AT) flush();
      else arm();
    },

    transcript: (t) => {
      if (closed) return;
      transcripts.push(t);
      // Same bound as events: a call whose row never appeared must not accumulate.
      if (transcripts.length > FLUSH_AT * 4) transcripts = transcripts.slice(-FLUSH_AT * 4);
      if (transcripts.length >= FLUSH_AT) flush();
      else arm();
    },

    turn: (t) => {
      if (closed) return;
      turns.push(t);
      if (turns.length > FLUSH_AT * 4) turns = turns.slice(-FLUSH_AT * 4);
      if (turns.length >= FLUSH_AT) flush();
      else arm();
    },

    latency: (l) => {
      if (closed) return;
      latencies.push(l);
      if (latencies.length > FLUSH_AT * 4) latencies = latencies.slice(-FLUSH_AT * 4);
      if (latencies.length >= FLUSH_AT) flush();
      else arm();
    },

    ended: (reason, carrierStatus, durationSeconds) => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      flush();
      if (callRowId === null) {
        // Held rather than dropped. The insert is still in flight and will apply this.
        pendingEnd = [reason, carrierStatus, durationSeconds];
        return;
      }
      closeRow(reason, carrierStatus, durationSeconds);
    },
  };
};
