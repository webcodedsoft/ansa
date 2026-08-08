import type { CallRecorder } from "../telephony/event-log";
import type { LoggedEvent } from "./summary";

/**
 * A read-through copy of the call's own events, for use while the call is still running.
 *
 * This is not a second store and it must never become one. The recorder batches to
 * Postgres — twenty-five events or five seconds, whichever comes first — because a
 * database round trip on the conversation's critical path is the thing it exists to
 * avoid. That batching is correct and it means the last few seconds of a call are not yet
 * in `call_events` when the transfer is dialled, which is precisely the window where the
 * caller said the thing that caused the escalation.
 *
 * So the journal tees the same event objects on their way to the same table. Nothing is
 * added, nothing is derived, and nothing is written here that is not also written there:
 * a summary built from this and a summary built by reading the rows back afterwards are
 * the same summary, which is what makes the stored call auditable against what the person
 * answering was told.
 */
export interface HandoffJournal {
  /** Wrap this around the real recorder and pass it to the orchestrator. */
  readonly recorder: CallRecorder;
  readonly events: () => readonly LoggedEvent[];
}

/**
 * Only the kinds the summary reads.
 *
 * A call produces hundreds of latency and partial-transcript events and none of them
 * belongs in a handoff. Filtering here rather than at read time keeps a long call's memory
 * flat instead of proportional to its length.
 */
const KEPT = new Set([
  "caller said",
  "entity_candidate",
  "value confirmed",
  "escalated to a human",
  "tool_result",
  "tool_invoked",
  "tool_failed",
  "tool dispatched",
]);

/**
 * A hard ceiling anyway. A caller who has said four hundred things is having a worse
 * problem than a truncated summary, and the oldest turns are the ones the summary is
 * least interested in — except the confirmed values, which are compacted separately below.
 */
const MAX_EVENTS = 400;

export const withHandoffJournal = (inner: CallRecorder): HandoffJournal => {
  const kept: LoggedEvent[] = [];

  return {
    events: () => kept,
    recorder: {
      started: (call) => {
        inner.started(call);
      },
      event: (kind, detail, offsetMs) => {
        inner.event(kind, detail, offsetMs);
        if (!KEPT.has(kind)) return;
        kept.push({ kind, detail: detail ?? {}, offsetMs: offsetMs ?? null });
        if (kept.length <= MAX_EVENTS) return;
        // Drop the oldest plain caller turns first and never a captured value: the name
        // the caller spelled at minute one is the single thing a handoff must not lose,
        // and it is the oldest event in the call.
        const index = kept.findIndex((e) => e.kind === "caller said");
        kept.splice(index === -1 ? 0 : index, 1);
      },
      transcript: (t) => {
        inner.transcript(t);
      },
      turn: (t) => {
        inner.turn(t);
      },
      ended: (reason, carrierStatus, durationSeconds) => {
        inner.ended(reason, carrierStatus, durationSeconds);
      },
    },
  };
};
