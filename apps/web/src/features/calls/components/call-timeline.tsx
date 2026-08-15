import { EmptyState, Table, Tag, Td, Th, Tr } from "@/components/ui";
import { humanise, offset } from "@/lib/format";

import type { CallDetail, CallEvent, CallTranscript } from "../calls.service";
import { TranscriptLine } from "./transcript-line";

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
  readonly speaker: string;
  readonly transcript: CallTranscript | null;
  readonly bargedInAtMs: number | null;
}

export const linesOf = (call: CallDetail): readonly TimelineLine[] => {
  const spoken: readonly TimelineLine[] = call.transcripts.map((transcript) => ({
    key: `t:${transcript.id}`,
    at: transcript.offsetMs,
    speaker: "caller",
    transcript,
    bargedInAtMs: null,
  }));

  const acted: readonly TimelineLine[] = call.turns
    .filter((turn) => turn.speaker !== "caller")
    .map((turn) => ({
      key: `a:${turn.seq}`,
      at: turn.startedOffsetMs,
      speaker: turn.speaker,
      transcript: null,
      bargedInAtMs: turn.bargedInAtMs,
    }));

  return [...spoken, ...acted].sort((left, right) => left.at - right.at);
};

export const CallTimeline = ({
  callId,
  lines,
}: {
  readonly callId: string;
  readonly lines: readonly TimelineLine[];
}) => {
  if (lines.length === 0) {
    return (
      <EmptyState title="Nothing was recorded">This call may have been answered and dropped before anybody spoke.</EmptyState>
    );
  }

  return (
    <div>
      {lines.map((line) => (
        <div
          key={line.key}
          className="grid grid-cols-[64px_1fr] gap-3 border-b border-[var(--surface-line)] py-3 last:border-b-0"
        >
          <div className="pt-0.5 font-mono text-xs text-[var(--ink-3)] tabular-nums">
            {offset(line.at)}
          </div>
          <div>
            <div className="mb-0.5 text-xs font-semibold tracking-wide text-[var(--ink-3)] uppercase">
              {line.speaker}
            </div>
            {line.transcript === null ? (
              <div className="flex flex-wrap items-center gap-2 text-[var(--ink-3)]">
                {/* The agent's words are not stored — only that it took a turn. What it said
                    is reconstructible from the configuration version on the call. */}
                spoke
                {line.bargedInAtMs !== null && (
                  <Tag>interrupted at {offset(line.bargedInAtMs)}</Tag>
                )}
              </div>
            ) : (
              <TranscriptLine callId={callId} transcript={line.transcript} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

/** The parts of an event worth reading, joined. Absent parts are dropped, not left blank. */
const eventDetail = (detail: CallEvent["detail"]): string =>
  [
    detail.stage,
    detail.tool,
    detail.subject,
    detail.outcome,
    detail.reason,
    detail.ms === null ? null : `${detail.ms}ms`,
    detail.attempt === null ? null : `attempt ${detail.attempt}`,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ") || "—";

export const EventTable = ({ events }: { readonly events: readonly CallEvent[] }) => {
  if (events.length === 0) return <EmptyState title="No events recorded" />;

  return (
    <Table>
      <thead>
        <tr>
          <Th>At</Th>
          <Th>Event</Th>
          <Th>Detail</Th>
        </tr>
      </thead>
      <tbody>
        {events.map((event, index) => (
          <Tr key={`${event.kind}:${event.at}:${index}`}>
            <Td className="font-mono text-[13px] tabular-nums">{offset(event.offsetMs)}</Td>
            <Td>{humanise(event.kind)}</Td>
            <Td className="text-[var(--ink-3)]">{eventDetail(event.detail)}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
};
