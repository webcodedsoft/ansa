import Link from "next/link";

import { DataTable, Tag, type Column, type Tone } from "@/components/ui";
import { humanise, when } from "@/lib/format";

import type { FlaggedCall } from "../calls.service";

/** Severity orders the list and means nothing else — this only decides how loud the tag looks. */
const severityTone = (severity: number): Tone =>
  severity >= 15 ? "bad" : severity >= 8 ? "warn" : "neutral";

const COLUMNS: readonly Column<FlaggedCall>[] = [
  {
    key: "severity",
    header: "Severity",
    width: "w-[100px]",
    cell: (call) => <Tag tone={severityTone(call.severity)}>{call.severity}</Tag>,
  },
  { key: "when", header: "When", className: "tabular-nums", cell: (call) => when(call.createdAt) },
  {
    key: "call",
    header: "Call",
    className: "font-mono text-[13px]",
    cell: (call) => (
      <Link
        href={`/calls/${call.id}`}
        className="font-medium text-[var(--accent)] hover:underline"
      >
        {call.carrierCallId}
      </Link>
    ),
  },
  {
    key: "ended",
    header: "Ended",
    className: "text-[var(--ink-3)]",
    cell: (call) => (call.endReason === null ? "in progress" : humanise(call.endReason)),
  },
  {
    key: "reviewed",
    header: "Reviewed",
    className: "tabular-nums",
    cell: (call) => `${call.reviewed}/${call.reviewed + call.unreviewed}`,
  },
  {
    key: "why",
    header: "Why",
    cell: (call) => (
      <div className="flex flex-col gap-1">
        {call.signals.map((signal) => (
          <div key={signal.kind} className="text-[12.5px]">
            <span className="font-medium">{humanise(signal.kind)}</span>
            {signal.count > 1 && <span className="text-[var(--ink-3)]"> ×{signal.count}</span>}
            <span className="ml-1.5 text-[var(--ink-3)]">{signal.why}</span>
          </div>
        ))}
      </div>
    ),
  },
];

export const ReviewQueueTable = ({ calls }: { readonly calls: readonly FlaggedCall[] }) => (
  <DataTable
    rows={calls}
    columns={COLUMNS}
    rowKey={(call) => call.id}
    empty={{
      title: "Nothing flagged",
      description: "Every call in the scanned window cleared the review heuristics.",
    }}
  />
);
