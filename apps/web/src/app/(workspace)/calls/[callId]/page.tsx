import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, PageHeader } from "@/components/ui";
import { findCall } from "@/features/calls/calls.service";
import { CallFlags } from "@/features/calls/components/call-flags";
import { CallRecording } from "@/features/calls/components/call-recording";
import { CallStats, computeCallStats } from "@/features/calls/components/call-stats";
import { linesOf } from "@/features/calls/call-conversation";
import { CallTimeline, EventTable } from "@/features/calls/components/call-timeline";
import { CollectedValues } from "@/features/calls/components/collected-values";
import { directionLabel, duration, humanise, when } from "@/lib/format";

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
        meta={`${when(call.createdAt)} · ${directionLabel(call.direction)} · ${duration(
          call.durationSeconds,
        )} · ${call.endedAt === null ? "in progress" : humanise(call.endReason)}${
          call.configVersion === null ? "" : ` · configuration version ${call.configVersion}`
        }`}
      />

      <CallFlags call={call} />

      {/* The conversation leads, with what it produced beside it.
       *
       * The order used to be flags, timings, collected values, then the transcript — on the
       * reasoning that "what did we get" is the question an operator opens a call with. That
       * held while the transcript was one-sided and could not answer anything. Now that both
       * halves are stored (0076) the conversation *is* the answer, and the values read better
       * as its result than as its preface.
       */}
      <div className="grid items-start gap-3.5 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <Card
          title="What was said"
          description={`${lines.length} lines${
            stats.interruptions === 0
              ? ""
              : ` · the caller interrupted ${stats.interruptions} ${
                  stats.interruptions === 1 ? "time" : "times"
                }`
          }`}
        >
          {/* Above the words, because it is the evidence they are checked against — and a
              button rather than a player, because asking for the audio is logged. */}
          <div className="mb-3.5 border-b border-[var(--surface-line)] pb-3.5">
            <CallRecording callId={call.id} />
          </div>
          <CallTimeline callId={call.id} lines={lines} />
        </Card>

        <div className="flex flex-col gap-3.5">
          <CollectedValues call={call} />
          <CallStats stats={stats} />
        </div>
      </div>

      {/* Demoted, not deleted. The event log is how a call is debugged; it is not what
          somebody asking what was said should have to read past to get there. */}
      <details className="group mt-3.5">
        <summary className="cursor-pointer list-none rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-3.5 py-2.5 text-[13px] text-[var(--ink-2)] hover:border-[var(--ink-3)]">
          <span className="group-open:hidden">
            Show what the orchestrator did — {call.events.length} events
          </span>
          <span className="hidden group-open:inline">Hide what the orchestrator did</span>
        </summary>
        <Card
          title="Events"
          description="Every step, in order, on the media clock."
          className="mt-3.5"
        >
          <EventTable events={call.events} />
        </Card>
      </details>
    </>
  );
};

export default CallDetailPage;
