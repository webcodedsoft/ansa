import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, PageHeader } from "@/components/ui";
import { findCall } from "@/features/calls/calls.service";
import { CallFlags } from "@/features/calls/components/call-flags";
import { CallStats, computeCallStats } from "@/features/calls/components/call-stats";
import { CallTimeline, EventTable, linesOf } from "@/features/calls/components/call-timeline";
import { duration, humanise, when } from "@/lib/format";

export const dynamic = "force-dynamic";

const CallDetailPage = async ({
  params,
}: {
  readonly params: Promise<{ readonly callId: string }>;
}) => {
  const { callId } = await params;
  const call = await findCall(callId);
  if (call === null) notFound();

  const lines = linesOf(call);
  const stats = computeCallStats(call);

  return (
    <>
      <PageHeader
        title={call.direction === "outbound" ? call.dialled : (call.caller ?? "Unknown caller")}
        actions={
          <Link
            href="/calls"
            className="text-sm text-[var(--ink-3)] hover:text-[var(--ink)] hover:underline"
          >
            All calls
          </Link>
        }
        meta={`${when(call.createdAt)} · ${call.direction} · ${duration(
          call.durationSeconds,
        )} · ${call.endedAt === null ? "in progress" : humanise(call.endReason)}${
          call.configVersion === null ? "" : ` · configuration version ${call.configVersion}`
        }`}
      />

      <CallFlags call={call} />

      <CallStats stats={stats} />

      <Card
        title="Transcript"
        description={`${lines.length} lines${
          stats.interruptions === 0
            ? ""
            : ` · the caller interrupted ${stats.interruptions} ${
                stats.interruptions === 1 ? "time" : "times"
              }`
        }`}
      >
        <CallTimeline callId={call.id} lines={lines} />
      </Card>

      <Card title="Events" description="What the orchestrator did, in order." className="mt-3.5">
        <EventTable events={call.events} />
      </Card>
    </>
  );
};

export default CallDetailPage;
