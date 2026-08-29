import Link from "next/link";
import type { ReactNode } from "react";

import {
  Blip,
  EmptyState,
  Panel,
  SectionHead,
  Stack,
  Stat,
  Table,
  Tag,
  Td,
  Th,
  type Tone,
} from "@/components/ui";
import type { CallSummary } from "@/features/calls/calls.service";
import { duration, humanise, phone, timeOfDay } from "@/lib/format";

import { TestCallCard } from "./test-call-card";

/**
 * What this agent is doing, and what wants doing about it.
 *
 * Three figures, then the things that need a person, then the last few calls. That order
 * is the point: a figure tells you whether to worry, the attention list tells you what to
 * do, and the calls are the evidence under both. A readiness checklist used to lead here,
 * which answered a question nobody with a working agent was asking.
 */

/**
 * The line under a figure. Always drawn, so the three cards keep one shape.
 *
 * A card that loses its third line when there is nothing to compare against makes the row
 * ragged and reads as a rendering fault rather than as a young agent. `good: null` is that
 * case: the words say why, with no arrow and in muted ink.
 */
export interface Delta {
  /** Already worded — "8% on last week", "40 ms faster", "no calls last week". */
  readonly label: string;
  /** True improved, false worsened, null nothing to compare against. */
  readonly good: boolean | null;
}

export interface AgentStats {
  readonly calls7d: number;
  readonly callsDelta: Delta;
  /** Whole percent, or null when there were no calls to divide by. */
  readonly resolvedPercent: number | null;
  readonly resolvedDelta: Delta;
  readonly responseP50Ms: number | null;
  readonly p50Delta: Delta;
}

export interface AttentionItem {
  readonly id: string;
  /** The two or three words that say what kind of problem this is. */
  readonly label: string;
  readonly tone: Tone;
  readonly detail: ReactNode;
  readonly actionLabel: string;
  readonly href: string;
}

/**
 * The triangle means better, not bigger.
 *
 * That is worth stating because the two come apart on this very row: "40 ms faster" is a
 * fall in the number and a rise in quality, and it takes ▲ for the same reason "8% on last
 * week" does. Pointing the arrow at the arithmetic would have latency improving downwards
 * on a card sitting beside two where up is good, and nobody reads three cards that way.
 */
const Movement = ({ delta }: { readonly delta: Delta }) => {
  if (delta.good === null) return <span className="text-[var(--ink-3)]">{delta.label}</span>;
  return (
    <span className={delta.good ? "text-[var(--ok)]" : "text-[var(--bad)]"}>
      {delta.good ? "▲" : "▼"} {delta.label}
    </span>
  );
};

const OUTCOME_TONE: Record<string, Tone> = {
  completed: "ok",
  transferred: "warn",
  "no-answer": "warn",
  busy: "warn",
  voicemail: "bad",
  failed: "bad",
};

export const OverviewTab = ({
  stats,
  attention,
  recentCalls,
}: {
  readonly stats: AgentStats;
  readonly attention: readonly AttentionItem[];
  readonly recentCalls: readonly CallSummary[];
}) => (
  <Stack>
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
      <Stat
        label="Calls, 7 days"
        value={stats.calls7d}
        trend={<Movement delta={stats.callsDelta} />}
      />
      <Stat
        label="Resolved without a person"
        value={stats.resolvedPercent ?? "—"}
        unit={stats.resolvedPercent === null ? undefined : "%"}
        trend={<Movement delta={stats.resolvedDelta} />}
      />
      <Stat
        label="Response p50"
        value={stats.responseP50Ms ?? "—"}
        unit={stats.responseP50Ms === null ? undefined : "ms"}
        trend={<Movement delta={stats.p50Delta} />}
      />
    </div>

    <SectionHead>Needs your attention</SectionHead>
    <Panel>
      {attention.length === 0 ? (
        <EmptyState title="Nothing waiting">
          No transcripts pending a verdict, no failing checks, and no tool refusing calls.
        </EmptyState>
      ) : (
        /* A tag, a sentence, and the one thing to do about it. Every row ends in a link
           rather than a description of where to go — an attention list you cannot act on
           from itself is a list people stop reading. */
        <div className="divide-y divide-[var(--surface-line)]">
          {attention.map((item) => (
            <div key={item.id} className="flex flex-wrap items-center gap-3 px-[18px] py-3">
              <span className="w-[118px] flex-none">
                <Tag tone={item.tone}>{item.label}</Tag>
              </span>
              <p className="min-w-0 flex-1 text-[13.5px] text-[var(--ink-2)]">{item.detail}</p>
              <Link
                href={item.href}
                className="flex-none text-[13.5px] font-medium text-[var(--accent)] hover:underline"
              >
                {item.actionLabel}
              </Link>
            </div>
          ))}
        </div>
      )}
    </Panel>

    {/* The header's Test call anchors here rather than duplicating the control — two
        buttons that both place a call is one too many ways to do one thing. */}
    <div id="test-call" className="scroll-mt-20">
      <TestCallCard />
    </div>

    <SectionHead>Recent calls</SectionHead>
    <div className="surface overflow-hidden rounded-xl">
      {recentCalls.length === 0 ? (
        <EmptyState title="No calls yet">
          Place a test call from the header and it will appear here.
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th className="w-[96px]">When</Th>
              <Th>Number</Th>
              <Th className="w-[100px] text-right">Length</Th>
              <Th className="w-[190px]">Outcome</Th>
            </tr>
          </thead>
          <tbody>
            {recentCalls.map((call) => (
              <tr key={call.id} className="transition-colors hover:bg-[var(--surface-2)]">
                <Td className="whitespace-nowrap tabular-nums">{timeOfDay(call.createdAt)}</Td>
                <Td className="font-mono text-[13px] font-medium">
                  <Link href={`/calls/${call.id}`} className="hover:underline">
                    {phone(
                      call.direction === "outbound" ? call.dialled : (call.caller ?? "unknown"),
                    )}
                  </Link>
                </Td>
                <Td className="text-right tabular-nums">{duration(call.durationSeconds)}</Td>
                <Td>
                  {call.endedAt === null ? (
                    <Tag tone="accent">
                      <Blip pulse />
                      live
                    </Tag>
                  ) : (
                    <Tag tone={OUTCOME_TONE[call.endReason ?? ""] ?? "neutral"}>
                      {humanise(call.endReason ?? "ended")}
                    </Tag>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  </Stack>
);
