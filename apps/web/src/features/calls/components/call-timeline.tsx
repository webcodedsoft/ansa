import { EmptyState, Table, Td, Th, Tr } from "@/components/ui";
import { cn } from "@/lib/cn";
import { humanise, offset } from "@/lib/format";

import type { CallEvent } from "../calls.service";
import { type TimelineLine } from "../call-conversation";
import { TranscriptLine } from "./transcript-line";

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

  /* A chat rather than a table of rows.
   *
   * Both sides are stored now (0076), and two columns of alternating text is how a
   * conversation is read everywhere else. It also earns something a table could not: an
   * interrupted turn is a bubble with its bottom edge cut, which says "she never heard the
   * rest" faster than a tag saying so.
   *
   * The agent sits on the right in the accent, as the organisation's own voice — the same
   * side "me" sits on in any messaging app, and the console is read by the organisation.
   */
  return (
    <div className="flex flex-col gap-3">
      {lines.map((line) =>
        line.speaker === "tool" ? (
          <div key={line.key} className="flex justify-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-dashed border-[var(--hairline)] bg-[var(--surface-2)] px-2.5 py-1 text-[12px] text-[var(--ink-3)]">
              <span className="font-mono text-[11px] tabular-nums">{offset(line.at)}</span>
              {line.aside}
            </span>
          </div>
        ) : (
          <div
            key={line.key}
            /* What a summary's citation scrolls to. A React key is not a DOM id, and the
               difference between them is a click that silently does nothing. */
            id={line.transcript === null ? undefined : `line-${line.transcript.id}`}
            className={cn(
              "flex scroll-mt-24 items-end gap-2",
              line.speaker === "agent" ? "flex-row-reverse" : "flex-row",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "grid size-7 flex-none place-items-center rounded-full border text-[10px] font-semibold",
                line.speaker === "agent"
                  ? "border-transparent bg-[var(--accent)] text-[var(--accent-on)]"
                  : "border-[var(--hairline)] bg-[var(--surface-2)] text-[var(--ink-3)]",
              )}
            >
              {line.speaker === "agent" ? "AI" : "☏"}
            </span>

            <div
              className={cn(
                "flex min-w-0 flex-col",
                line.speaker === "agent" ? "items-end" : "items-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[min(34rem,78%)] rounded-[14px] border px-3 py-2 shadow-[var(--shadow-s)]",
                  line.speaker === "agent"
                    ? "rounded-br-[4px] border-[var(--accent)]/30 bg-[var(--accent-soft)]"
                    : "rounded-bl-[4px] border-[var(--hairline)] bg-[var(--surface-2)]",
                  /* The cut edge. Only ever on an agent bubble, because only the agent can
                     be talked over. */
                  line.bargedInAtMs !== null && "border-b-2 border-b-dashed border-b-[var(--warn)]",
                )}
              >
                {line.transcript === null ? (
                  /* Rare now: a turn that made a sound and left no words. Before 0076 this
                     was every agent turn on every call. */
                  <span className="text-[13px] text-[var(--ink-3)]">
                    spoke, too briefly to transcribe
                  </span>
                ) : (
                  <TranscriptLine callId={callId} transcript={line.transcript} />
                )}
              </div>

              <div className="mt-1 flex items-center gap-2 px-1">
                <span className="font-mono text-[11px] text-[var(--ink-3)] tabular-nums">
                  {offset(line.at)}
                </span>
                {line.bargedInAtMs !== null && (
                  <span className="text-[11.5px] text-[var(--warn)]">
                    cut off {offset(line.bargedInAtMs)} in — the rest was never heard
                  </span>
                )}
              </div>
            </div>
          </div>
        ),
      )}
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
    /* Humanised like the event kind above it. These are slugs the dispatcher writes —
       `outbound-write-refused`, `stale-confirmation` — and rendering them raw beside a
       readable kind makes the reason look like an internal code rather than the answer to
       "why did that not run". */
    humanise(detail.reason),
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
