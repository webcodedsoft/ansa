import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { WidePage } from "@/components/shell/wide-page";
import { Card, Tabs, buttonClass } from "@/components/ui";
import { findCall } from "@/features/calls/calls.service";
import { CallDirection } from "@/features/calls/components/call-direction";
import { CallFlags } from "@/features/calls/components/call-flags";
import { CallRecording } from "@/features/calls/components/call-recording";
import { CallStats, computeCallStats } from "@/features/calls/components/call-stats";
import { CallSummary } from "@/features/calls/components/call-summary";
import { linesOf } from "@/features/calls/call-conversation";
import { CallTimeline, EventTable } from "@/features/calls/components/call-timeline";
import { NeedsALook } from "@/features/calls/components/needs-a-look";
import { OutcomeTag } from "@/features/calls/components/outcome-tag";
import { outcomeOf } from "@/features/calls/outcome";
import { CollectedValues } from "@/features/calls/components/collected-values";
import { initialsOf } from "@/features/contacts/contacts.display";
import { cn } from "@/lib/cn";
import { duration, phone, when } from "@/lib/format";

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

  const counterparty = call.direction === "outbound" ? call.dialled : call.caller;
  const outcome = outcomeOf(call.endReason, call.endedAt !== null);
  /* The circle beside each caller bubble: initials when we know a name, the number's last two
     digits when we do not — the same rule as the directory row, so the face matches. */
  const agentWordsKept = call.transcripts.some((line) => line.speaker === "agent");
  const callerInitials = initialsOf({
    displayName: call.contact?.name ?? null,
    phone: counterparty ?? "",
    values: [],
  });

  return (
    <>
      <WidePage />

      {/* The way back goes to the person when there is one. A call is opened from a contact
          more often than from the list, and "← Amaka Obi" says where you are in a way that
          "All calls" does not. */}
      <Link
        href={call.contact === null ? "/calls" : `/contacts/${call.contact.id}`}
        className={cn(buttonClass("secondary", "sm"), "mb-4 inline-flex items-center gap-1.5")}
      >
        <ArrowLeft aria-hidden className="size-3.5" />
        {call.contact === null ? "All calls" : (call.contact.name ?? "Unnamed caller")}
      </Link>

      {/* The moment is the title. A call is "the one at 14:12 on the sixth", and the number is
          how you recognise who it was with — so the number sits in the meta line, formatted,
          beside the person's name and what the call came to. */}
      <header className="mb-5">
        <div className="mb-1 flex items-center gap-2 font-mono text-[10.5px] font-semibold tracking-[0.11em] text-[var(--ink-3)] uppercase">
          <CallDirection direction={call.direction} className="normal-case tracking-normal font-sans text-[12px] font-medium text-[var(--ink-2)]" />
        </div>
        <h1 className="m-0 text-[27px] leading-tight font-[680] tracking-[-0.025em]">
          {when(call.createdAt)}
        </h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-[var(--ink-3)]">
          {counterparty !== null && (
            <>
              <span className="font-mono text-[12.5px]">{phone(counterparty)}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <span>{duration(call.durationSeconds)}</span>
          {call.contact !== null && call.contact.name !== null && (
            <>
              <span aria-hidden>·</span>
              <Link href={`/contacts/${call.contact.id}`} className="hover:text-[var(--accent)] hover:underline">
                {call.contact.name}
              </Link>
            </>
          )}
          <OutcomeTag outcome={outcome} />
        </div>
      </header>

      <CallFlags call={call} />

      {/* Three tabs, because three people open a call for three reasons. Somebody asking what
          was said reads the conversation with its summary beside it; somebody filing what it
          produced wants the values; somebody debugging wants the timings and the event log
          and nothing in front of them. One page had all three stacked, and each reader had
          to scroll past the other two. */}
      <Tabs
        tabs={[
          {
            id: "conversation",
            label: "Conversation",
            panel: (
              <div className="grid items-start gap-3.5 lg:grid-cols-[minmax(0,1fr)_20rem]">
                <Card
                  title="What was said"
                  actions={
                    <span className="text-[12px] text-[var(--ink-3)]">
                      {lines.length} lines
                      {stats.interruptions === 0
                        ? ""
                        : ` · interrupted ${stats.interruptions} ${
                            stats.interruptions === 1 ? "time" : "times"
                          }`}
                    </span>
                  }
                >
                  {/* Above the words, because it is the evidence they are checked against —
                      and a button rather than a player, because asking for the audio is
                      logged. */}
                  <div className="mb-3.5 border-b border-[var(--surface-line)] pb-3.5">
                    <CallRecording callId={call.id} />
                    {!agentWordsKept && (
                      <p className="mt-2 mb-0 text-[11.5px] text-[var(--ink-3)]">
                        Only the caller&apos;s words are here. This call was recorded before the
                        agent&apos;s side was kept; every call since carries both.
                      </p>
                    )}
                  </div>
                  <CallTimeline
                    callId={call.id}
                    lines={lines}
                    callerInitials={callerInitials}
                    agentWordsKept={agentWordsKept}
                  />
                </Card>

                <div className="flex flex-col gap-3.5">
                  {/* First in the rail: it is the answer, and the conversation beside it is
                      the evidence. Its citations scroll to the line each sentence came from. */}
                  <CallSummary summary={call.summary} />
                  <CollectedValues call={call} />
                  <NeedsALook call={call} />
                </div>
              </div>
            ),
          },
          {
            id: "collected",
            label: "What it collected",
            panel: <CollectedValues call={call} />,
          },
          {
            id: "diagnostics",
            label: "Diagnostics",
            panel: (
              <div className="flex flex-col gap-3.5">
                <CallStats stats={stats} />
                <Card title="Events" description="Every step, in order, on the media clock.">
                  {/* The transport's own words for how this ended — "carrier sent stop",
                      "socket closed with code 1005". Everywhere else the console says
                      "ended"; here, where a call is being taken apart, the exact exit is the
                      point. So is the configuration version and the transcriber. */}
                  <p className="mb-3 text-[12.5px] text-[var(--ink-3)]">
                    {call.endReason !== null && (
                      <>
                        Ended because:{" "}
                        <code className="font-mono text-[12px] text-[var(--ink-2)]">{call.endReason}</code>
                        {" · "}
                      </>
                    )}
                    {call.configVersion !== null && <>configuration version {call.configVersion} · </>}
                    transcribed by{" "}
                    <code className="font-mono text-[12px] text-[var(--ink-2)]">
                      {[...new Set(call.transcripts.map((line) => line.provider))].join(", ") || "—"}
                    </code>
                  </p>
                  <EventTable events={call.events} />
                </Card>
              </div>
            ),
          },
        ]}
      />
    </>
  );
};

export default CallDetailPage;
