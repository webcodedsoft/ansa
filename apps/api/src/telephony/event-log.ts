import {
  recordCallEnded,
  recordCallEvents,
  recordCallStarted,
  recordTranscripts,
  type Db,
  type RecordedTranscript,
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
   * caller's mishearing into a keyterm and a test case for every tenant.
   */
  transcript(transcript: RecordedTranscript): void;
  ended(reason: string, carrierStatus?: string | null, durationSeconds?: number | null): void;
}

/** Used when there is no database. The call path must not care which it has. */
export const nullRecorder: CallRecorder = {
  started: () => undefined,
  event: () => undefined,
  transcript: () => undefined,
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

  let tenantId: StartedCall["tenantId"] | null = null;
  let callRowId: string | null = null;
  // Buffered before the insert returns an id as well as after: the first seconds of a
  // call are the ones worth having, and dropping them because the row did not exist yet
  // would lose the greeting and the first caller turn every time.
  let buffer: { kind: string; offsetMs?: number | null; detail?: Readonly<Record<string, unknown>> }[] = [];
  let transcripts: RecordedTranscript[] = [];
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const flush = (): void => {
    if (callRowId === null || tenantId === null) return;

    if (transcripts.length > 0) {
      const words = transcripts;
      transcripts = [];
      void recordTranscripts(dataSource, tenantId, callRowId, words).catch((error: unknown) => {
        log.error("could not write transcripts", {
          dropped: words.length,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    void recordCallEvents(dataSource, tenantId, callRowId, batch).catch((error: unknown) => {
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
      tenantId = call.tenantId;
      void recordCallStarted(dataSource, call)
        .then((id) => {
          callRowId = id;
          flush();
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

    ended: (reason, carrierStatus, durationSeconds) => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      flush();
      if (callRowId === null || tenantId === null) return;
      void recordCallEnded(dataSource, {
        tenantId,
        callRowId,
        endReason: reason,
        carrierStatus: carrierStatus ?? null,
        durationSeconds: durationSeconds ?? null,
      }).catch((error: unknown) => {
        log.error("could not close the call record", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  };
};
