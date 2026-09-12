import { Sparkles, UserRound } from "lucide-react";

import { EmptyState, Table, Td, Th, Tr } from "@/components/ui";
import { cn } from "@/lib/cn";
import { offset } from "@/lib/format";

import type { CallEvent } from "../calls.service";
import { type TimelineLine } from "../call-conversation";
import { notableEvents } from "../event-log";
import { HearAt } from "./recording-context";
import { TranscriptLine } from "./transcript-line";

export const CallTimeline = ({
  callId,
  lines,
  callerInitials,
  agentWordsKept,
}: {
  readonly callId: string;
  readonly lines: readonly TimelineLine[];
  /**
   * Two letters for the caller's circle when we know their name. Null when we do not — the
   * circle then carries a person glyph rather than the number's last digits, which read as a
   * count of something and named nobody.
   */
  readonly callerInitials: string | null;
  /**
   * Whether this call stored the agent's words at all.
   *
   * False on every call before 0076, where "spoke, too briefly to transcribe" under each
   * agent turn read as the transcriber failing forty times in a row. It did not fail; nothing
   * was asked to keep the words. Two different absences, two different sentences.
   */
  readonly agentWordsKept: boolean;
}) => {
  if (lines.length === 0) {
    return (
      <div className="grid min-h-[26rem] place-items-center">
        <EmptyState title="Nothing was recorded">
          This call may have been answered and dropped before anybody spoke.
        </EmptyState>
      </div>
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
    /* A floor and a ceiling. The floor: a three-line call beside a rail of three cards left
       the main column shorter than its sidebar, and the empty space read as the call being
       cut off. The ceiling: a forty-line call made the page itself the scroll, so the summary
       and its citations were a screen away from the words they cite. The conversation scrolls
       inside its card; the rail stays where it is. `scrollIntoView` from a citation finds the
       nearest scrolling ancestor, so a click still lands on its line. */
    <div className="flex max-h-[calc(100vh-22rem)] min-h-[26rem] flex-col gap-2.5 overflow-y-auto pr-1">
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
                "grid size-7 flex-none place-items-center rounded-full border font-mono text-[10px] font-semibold",
                line.speaker === "agent"
                  ? "border-transparent bg-[var(--accent)] text-[var(--accent-on)]"
                  : "border-[var(--hairline)] bg-[var(--surface-2)] text-[var(--ink-2)]",
              )}
            >
              {line.speaker === "agent" ? (
                <Sparkles className="size-3.5" />
              ) : callerInitials === null ? (
                <UserRound className="size-3.5" />
              ) : (
                callerInitials
              )}
            </span>

            {/* `flex-1`, and it matters: the bubble's width is a percentage, and a percentage
                of a column that is itself sized to its content is a circle the browser breaks
                by guessing small. Every bubble wrapped at about a hundred pixels — "Yeah. My
                name is / Sikiru." — and the page read as a column of index cards. The column
                takes the row; the bubble hugs its text inside it, up to most of the width. */}
            <div
              className={cn(
                "flex min-w-0 flex-1 flex-col",
                line.speaker === "agent" ? "items-end" : "items-start",
              )}
            >
              <HearAt
                offsetMs={line.at}
                className={cn(
                  "max-w-[min(40rem,72%)] rounded-[14px] border px-3.5 py-2 shadow-[var(--shadow-s)]",
                  line.speaker === "agent"
                    ? "rounded-br-[4px] border-[var(--accent)]/30 bg-[var(--accent-soft)]"
                    : "rounded-bl-[4px] border-[var(--hairline)] bg-[var(--surface-2)]",
                  /* The cut edge. Only ever on an agent bubble, because only the agent can
                     be talked over. */
                  line.bargedInAtMs !== null && "border-b-2 border-b-dashed border-b-[var(--warn)]",
                )}
              >
                {line.transcript === null ? (
                  <span className="text-[13px] text-[var(--ink-3)]">
                    {line.speaker === "agent" && !agentWordsKept
                      ? "the agent's words were not kept on this call"
                      : "spoke, too briefly to transcribe"}
                  </span>
                ) : (
                  <TranscriptLine callId={callId} transcript={line.transcript} />
                )}
              </HearAt>

              <div className="mt-0.5 flex items-center gap-2 px-1">
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

/**
 * What the agent did on this call, as a person would list it.
 *
 * Curated by `notableEvents`, not filtered by font size: the several hundred events the
 * orchestrator writes per call are still in the API for whoever is taking the call apart,
 * and this is the dozen that say it was interrupted, it read a value back, it used a tool,
 * it handed over.
 */
export const EventTable = ({
  events,
  startedAt,
}: {
  readonly events: readonly CallEvent[];
  /** When the call began — the media clock's zero for events that carry only a wall time. */
  readonly startedAt: string;
}) => {
  const rows = notableEvents(events, startedAt);
  if (rows.length === 0) {
    return (
      <p className="m-0 text-[12.5px] text-[var(--ink-3)]">
        Nothing to note. The call ran without an interruption, a tool, a readback or a handover.
      </p>
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th className="w-[86px]">At</Th>
          <Th className="w-[260px]">What happened</Th>
          <Th>Detail</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <Tr key={row.key}>
            <Td className="font-mono text-[13px] tabular-nums">{offset(row.offsetMs)}</Td>
            <Td>{row.label}</Td>
            <Td className="text-[var(--ink-3)]">{row.detail === "" ? "—" : row.detail}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
};
