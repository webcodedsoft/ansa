import { humanise } from "@/lib/format";

import type { CallEvent } from "./calls.service";

/**
 * The events on a call that a person running the business would want to know happened.
 *
 * The orchestrator writes several hundred events per call: every partial transcript, every
 * latency sample, every state-machine edge. That log is for taking a call apart, and it is
 * still in the API. This is the other reading of it — the dozen or so moments that say what
 * the agent *did*: it was interrupted, it read a value back, it called a tool, it handed the
 * call to a person. Everything not on the list is left out, not shown in a smaller font.
 *
 * Kinds are matched exactly against what the orchestrator writes, and a kind nobody has
 * looked at yet stays hidden rather than appearing with its internal name — the same rule
 * as `outcomeOf`.
 */
export interface LogRow {
  readonly key: string;
  readonly offsetMs: number | null;
  readonly label: string;
  readonly detail: string;
}

type Detail = CallEvent["detail"];

const join = (parts: readonly (string | null | undefined)[]): string =>
  parts
    .filter((part): part is string => part !== null && part !== undefined && part !== "" && part !== "—")
    .join(" · ");

const turn = (detail: Detail): string | null => (detail.seq === null ? null : `turn ${detail.seq}`);
const took = (detail: Detail): string | null => (detail.ms === null ? null : `${detail.ms} ms`);
const nth = (detail: Detail): string | null =>
  detail.attempt === null || detail.attempt <= 1 ? null : `attempt ${detail.attempt}`;

const NOTABLE: Readonly<
  Record<string, { readonly label: string; readonly detail: (d: Detail) => string }>
> = {
  "barge-in": { label: "Caller interrupted", detail: (d) => join([turn(d)]) },
  confirmation_requested: {
    label: "Read back to confirm",
    detail: (d) => join([humanise(d.subject), nth(d)]),
  },
  "value confirmed": { label: "Value confirmed", detail: (d) => join([humanise(d.subject)]) },
  "value rejected by pattern": {
    label: "Value did not match the expected format",
    detail: (d) => join([humanise(d.subject), humanise(d.reason)]),
  },
  tool_call: { label: "Tool used", detail: (d) => join([d.tool, humanise(d.outcome), took(d)]) },
  escalation_required: { label: "Needed a person", detail: (d) => join([humanise(d.reason)]) },
  "escalated to a human": { label: "Handed to a human", detail: () => "" },
  handoff_started: { label: "Transfer started", detail: (d) => join([humanise(d.reason)]) },
  end_call_requested: { label: "Agent asked to end the call", detail: (d) => join([d.reason]) },
  end_call_cancelled: {
    label: "Call carried on",
    detail: () => "the caller spoke again, so the agent did not hang up",
  },
  "call ended by the agent": { label: "Call ended by the agent", detail: (d) => join([d.reason]) },
  "outcome recorded": { label: "Outcome recorded", detail: (d) => join([humanise(d.outcome)]) },
  do_not_call_recorded: { label: "Added to do-not-call", detail: () => "" },
};

/**
 * @param startedAt When the call began, so an event that carries only a wall-clock time can
 *   still be placed on the media clock. Most of the notable kinds are written by the
 *   orchestrator without an offset; the transcript stages, which have one, are the kinds this
 *   list leaves out.
 */
export const notableEvents = (events: readonly CallEvent[], startedAt: string): readonly LogRow[] => {
  const start = Date.parse(startedAt);
  return events.flatMap((event, index) => {
    const rule = NOTABLE[event.kind];
    if (rule === undefined) return [];
    const fromClock = Number.isNaN(start) ? null : Math.max(0, Date.parse(event.at) - start);
    return [
      {
        key: `${event.kind}:${event.at}:${index}`,
        offsetMs: event.offsetMs ?? fromClock,
        label: rule.label,
        detail: rule.detail(event.detail),
      },
    ];
  });
};
