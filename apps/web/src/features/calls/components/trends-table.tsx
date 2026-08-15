import { EmptyState, Table, Td, Th, Tr } from "@/components/ui";

import type { CallTrends } from "../calls.service";
import { msLabel, percent } from "../format";
import { Sparkline } from "./sparkline";

const versionLabel = (version: number | null): string => (version === null ? "not recorded" : `v${version}`);

export const TrendsTable = ({ trends }: { readonly trends: CallTrends }) => {
  if (trends.versions.length === 0) {
    return (
      <EmptyState title="No calls yet">
        Trends appear once calls have run against this organisation&apos;s configuration.
      </EmptyState>
    );
  }

  // The API hands these back newest version first, which is right for the table below but
  // backwards for a trend line — a sparkline reads left-to-right as time moving forward.
  const chronological = [...trends.versions].reverse();
  const severityTrend = chronological.map((version) =>
    version.severityPerCall === null ? null : Number(version.severityPerCall),
  );

  return (
    <>
      <div className="mb-3.5 flex items-center gap-3">
        <span className="text-[12.5px] text-[var(--ink-3)]">Severity per call, oldest to newest</span>
        <Sparkline values={severityTrend} />
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Config</Th>
            <Th>Calls</Th>
            <Th>Flagged</Th>
            <Th>Severity/call</Th>
            <Th>Corrections</Th>
            <Th>STT accuracy</Th>
            <Th>Latency p50</Th>
            <Th>Transfers</Th>
          </tr>
        </thead>
        <tbody>
          {trends.versions.map((row) => (
            <Tr key={`${row.configVersion ?? "none"}:${row.firstCallAt}`}>
              <Td className="font-mono text-[13px]">{versionLabel(row.configVersion)}</Td>
              <Td className="tabular-nums">{row.calls}</Td>
              <Td className="tabular-nums">{percent(row.flaggedRate)}</Td>
              <Td className="tabular-nums">
                {row.severityPerCall === null ? "—" : Number(row.severityPerCall).toFixed(1)}
              </Td>
              <Td className="tabular-nums">{percent(row.correctionRate)}</Td>
              <Td className="tabular-nums">{percent(row.sttWordAccuracy)}</Td>
              <Td className="tabular-nums">{msLabel(row.responseLatencyP50Ms)}</Td>
              <Td className="tabular-nums">{percent(row.transferRate)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </>
  );
};
