import { Table, Td, Th, Tr } from "@/components/ui";

import type { CallMetrics } from "../calls.service";
import { msLabel, percent } from "../format";

interface MetricRow {
  readonly label: string;
  readonly value: string;
  readonly meaning: string;
}

/**
 * The same fourteen numbers the internal viewer's metrics page shows, in the same order —
 * this is a second audience for one arithmetic, not a second set of numbers.
 */
const rowsOf = (metrics: CallMetrics): readonly MetricRow[] => [
  {
    label: "STT exact match",
    value: percent(metrics.sttExactMatch),
    meaning: `reviewed turns the transcriber got word-for-word right (${metrics.reviewed} reviewed)`,
  },
  {
    label: "STT word accuracy",
    value: percent(metrics.sttWordAccuracy),
    meaning: "1 minus word error rate, against the reviewer's own text",
  },
  {
    label: "Correction rate",
    value: percent(metrics.correctionRate),
    meaning: "reviewed turns a human had to change",
  },
  {
    label: "Confirmation rate",
    value: percent(metrics.confirmationRate),
    meaning: "caller turns that triggered a readback",
  },
  {
    label: "Readback rejection",
    value: percent(metrics.readbackRejectionRate),
    meaning: "readbacks the caller said no to",
  },
  {
    label: "Capture completion",
    value: percent(metrics.captureCompletionRate),
    meaning: "readbacks that ended in a confirmed value",
  },
  {
    label: "Barge-in rate",
    value: percent(metrics.bargeInRate),
    meaning: "agent turns the caller interrupted",
  },
  {
    label: "Response latency p50",
    value: msLabel(metrics.responseLatencyMs.p50),
    meaning: `caller stopped talking to first reply audio, target 800ms (${metrics.responseLatencyMs.samples} turns)`,
  },
  {
    label: "Response latency p95",
    value: msLabel(metrics.responseLatencyMs.p95),
    meaning: "the tail is what a caller remembers",
  },
  {
    label: "Transfer rate",
    value: percent(metrics.transferRate),
    meaning: "calls that escalated to a human",
  },
  {
    label: "Abandonment",
    value: percent(metrics.abandonmentRate),
    meaning: "calls where the caller never took a turn",
  },
  {
    label: "Hallucinations discarded",
    value: String(metrics.hallucinationsDiscarded),
    meaning: "transcripts invented from silence and thrown away — any at all is worth reading",
  },
  {
    label: "Silence recovered",
    value: percent(metrics.recoveryRate),
    meaning: `caller turns that produced nothing and needed an apology (${metrics.recoveryLines} of them)`,
  },
  {
    label: "Tool failure rate",
    value: percent(metrics.toolFailureRate),
    meaning: `tool calls that timed out or errored (${metrics.toolCalls} dispatched)`,
  },
];

export const MetricsTable = ({ metrics }: { readonly metrics: CallMetrics }) => (
  <Table>
    <thead>
      <tr>
        <Th>Metric</Th>
        <Th>Value</Th>
        <Th>What it means</Th>
      </tr>
    </thead>
    <tbody>
      {rowsOf(metrics).map((row) => (
        <Tr key={row.label}>
          <Td className="font-medium">{row.label}</Td>
          <Td className="tabular-nums">{row.value}</Td>
          <Td className="text-[var(--ink-3)]">{row.meaning}</Td>
        </Tr>
      ))}
    </tbody>
  </Table>
);
