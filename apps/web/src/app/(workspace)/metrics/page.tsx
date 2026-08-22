import type { Metadata } from "next";

import { Card, PageHeader, Stat } from "@/components/ui";
import { callMetrics, callTrends, outboundMetrics } from "@/features/calls/calls.service";
import { LatencyTable } from "@/features/calls/components/latency-table";
import { MetricsTable } from "@/features/calls/components/metrics-table";
import { OutboundTable } from "@/features/calls/components/outbound-table";
import { TrendsTable } from "@/features/calls/components/trends-table";
import { msLabel, percent } from "@/features/calls/format";

export const metadata: Metadata = { title: "Metrics · Ansa" };
export const dynamic = "force-dynamic";

const MetricsPage = async () => {
  /* Settled rather than awaited outright for the outbound figures alone: they are a panel on
     a page about everything, and an organisation that has never placed a call should not get
     an error screen instead of its inbound metrics. */
  const [metrics, trends] = await Promise.all([callMetrics(), callTrends()]);
  const placed = await outboundMetrics().catch(() => null);

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Metrics"
        meta={`Computed over the last ${metrics.calls} calls · ${metrics.callerTurns} caller turns · ${metrics.agentTurns} agent turns.`}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Calls" value={metrics.calls} />
        <Stat label="Response time" value={msLabel(metrics.responseLatencyMs.p50)} unit="p50" />
        <Stat label="Transfer rate" value={percent(metrics.transferRate)} />
      </div>

      <Card
        title="Where the time goes"
        description={`Over ${metrics.responseLatencyMs.samples} response turns.`}
        className="mt-3.5"
      >
        <LatencyTable metrics={metrics} />
      </Card>

      <Card
        title="Quality"
        description="The same arithmetic the internal viewer uses, over the calls above."
        className="mt-3.5"
      >
        <MetricsTable metrics={metrics} />
      </Card>

      {placed !== null && (
        <Card
          title="Calls we placed"
          description="Outbound only. An inbound call is answered by definition, so every rate here computed across both would mostly measure how much inbound traffic there was."
          className="mt-3.5"
        >
          <OutboundTable metrics={placed} />
        </Card>
      )}

      <Card
        title="By configuration version"
        description="Movement between versions is evidence something changed, not evidence of what — provider, model and endpointing are deployment settings and do not appear here."
        className="mt-3.5"
      >
        <TrendsTable trends={trends} />
      </Card>
    </>
  );
};

export default MetricsPage;
