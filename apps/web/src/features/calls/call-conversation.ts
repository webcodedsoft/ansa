import { humanise } from "@/lib/format";

import type { CallDetail, CallTranscript } from "./calls.service";

/**
 * One line of the call, from either side.
 *
 * Turns and transcripts arrive as separate arrays because they come from separate places —
 * a turn is what the orchestrator did, a transcript is what a listen provider heard, and the
 * two are correlated by offset rather than by identity. Merging them here, rather than
 * pretending they were ever one stream, is the same decision the orchestrator makes.
 */
export interface TimelineLine {
  readonly key: string;
  readonly at: number;
  /** `caller`, `agent`, or `tool` — a thing that happened between two turns. */
  readonly speaker: string;
  readonly transcript: CallTranscript | null;
  readonly bargedInAtMs: number | null;
  /** Set on a `tool` line: what ran, and how it went. */
  readonly aside: string | null;
}

/**
 * The tool calls, placed where they happened.
 *
 * A conversation with a two-second gap in it and no reason for the gap reads as the agent
 * hesitating. It was usually checking the diary. These events already carry a `tool` in the
 * allowlisted detail, so showing them publishes nothing new.
 */
const TOOL_KINDS = new Set(["tool dispatched", "tool_invoked", "tool_result", "tool_failed"]);

export const linesOf = (call: CallDetail): readonly TimelineLine[] => {
  /* Both sides come from `transcripts` now (0076). The agent's words used to exist only as a
     `call_events` payload the API strips, so this merged caller transcripts with bare agent
     *turns* and rendered the word "spoke" where a reply belonged. */
  const spoken: readonly TimelineLine[] = call.transcripts.map((transcript) => ({
    key: `t:${transcript.id}`,
    at: transcript.offsetMs,
    speaker: transcript.speaker,
    transcript,
    /* An agent turn carries the moment the caller cut in. Matched to its line by the offset
       it started at, which is the same clock both were stamped from.
       Guarded on the line's own speaker too: a caller line can share an offset with an agent
       turn — that is what a barge-in *is* — and without this the interruption would be drawn
       on the words that did the interrupting. */
    bargedInAtMs:
      transcript.speaker !== "agent"
        ? null
        : (call.turns.find(
            (turn) => turn.speaker === "agent" && turn.startedOffsetMs === transcript.offsetMs,
          )?.bargedInAtMs ?? null),
    aside: null,
  }));

  const tools: readonly TimelineLine[] = call.events
    .filter((event) => TOOL_KINDS.has(event.kind) && event.detail.tool !== null)
    .map((event, index) => ({
      key: `x:${index}:${event.at}`,
      at: event.offsetMs ?? 0,
      speaker: "tool",
      transcript: null,
      bargedInAtMs: null,
      aside: [
        event.detail.tool,
        humanise(event.detail.outcome),
        event.detail.ms === null ? null : `${event.detail.ms}ms`,
      ]
        .filter((part): part is string => part !== null && part !== "")
        .join(" · "),
    }));

  /* A turn that made a sound but left no words — cut off before a whole word landed, or its
     transcript is still in flight. Kept, because a gap in the record reads worse than a line
     saying only that somebody spoke. */
  const wordless: readonly TimelineLine[] = call.turns
    .filter(
      (turn) =>
        turn.speaker !== "caller" &&
        !call.transcripts.some(
          (t) => t.speaker === "agent" && t.offsetMs === turn.startedOffsetMs,
        ),
    )
    .map((turn) => ({
      key: `a:${turn.seq}`,
      at: turn.startedOffsetMs,
      speaker: turn.speaker,
      transcript: null,
      bargedInAtMs: turn.bargedInAtMs,
      aside: null,
    }));

  return [...spoken, ...wordless, ...tools].sort((left, right) => left.at - right.at);
};
