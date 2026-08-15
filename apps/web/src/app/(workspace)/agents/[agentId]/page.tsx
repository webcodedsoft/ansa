import { notFound } from "next/navigation";

import {
  currentConfiguration,
  findAgent,
  listVersions,
  readinessReport,
  readKnowledge,
  readTools,
} from "@/features/agents/agents.service";
import { AgentWorkspace } from "@/features/agents/components/agent-workspace";
import type {
  AgentStats,
  AttentionItem,
  Delta,
} from "@/features/agents/components/overview-tab";
import {
  callMetrics,
  callTrends,
  listCalls,
  listReviewQueue,
} from "@/features/calls/calls.service";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const RESOLVED = "completed";
/** How many calls the overview shows. Enough to recognise a pattern, few enough to scan. */
const RECENT = 5;

const percent = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((part / whole) * 100);

/**
 * Week on week, in words. Always a line, never a gap.
 *
 * "Up 100%" from a base of zero is arithmetic rather than information, and it would have
 * every agent's first week claim a triumph — so an empty prior window says so plainly
 * instead. The card keeps its third line either way, which is what keeps the three of them
 * the same height.
 */
const countDelta = (now: number, before: number): Delta => {
  if (before === 0) return { label: "no calls the week before", good: null };
  const change = Math.round(((now - before) / before) * 100);
  if (change === 0) return { label: "level with last week", good: null };
  return { label: `${Math.abs(change)}% on last week`, good: change > 0 };
};

/** Percentage points, not a percentage of a percentage — the usual way this reads wrong. */
const pointsDelta = (now: number | null, before: number | null): Delta => {
  if (now === null || before === null) return { label: "nothing to compare yet", good: null };
  const change = now - before;
  if (change === 0) return { label: "level with last week", good: null };
  return { label: `${Math.abs(change)} points`, good: change > 0 };
};

/**
 * Latency is the one where down is the good direction.
 *
 * Worded rather than signed for that reason — "40 ms faster" carries its own meaning, and
 * it takes the same ▲ as the other two cards because the triangle marks an improvement
 * rather than an increase.
 */
const latencyDelta = (now: number | null, before: number | null): Delta => {
  if (now === null) return { label: "not measured yet", good: null };
  if (before === null) return { label: "first version measured", good: null };
  const change = now - before;
  if (change === 0) return { label: "level with the last version", good: null };
  return {
    label: `${Math.abs(change)} ms ${change < 0 ? "faster" : "slower"}`,
    good: change < 0,
  };
};

const totalOf = (settled: PromiseSettledResult<{ readonly total: number }>): number =>
  settled.status === "fulfilled" ? settled.value.total : 0;

/**
 * The agent workspace.
 *
 * The header identity comes from the agent record — its own name, its own number, its own
 * version. The editable tabs still read `config.current()`, which is per organization rather
 * than per agent until `config.*` is re-scoped, so an organisation with two agents would
 * see one script under both. That gap is recorded in TASKS.md and is exactly why no create
 * form is wired to `POST /agents` yet.
 *
 * Everything on the overview is measured rather than estimated: four total-only call
 * queries across two consecutive seven-day windows give the counts and their movement, and
 * the latency comparison comes from the trends endpoint's own per-version p50.
 */
const AgentWorkspacePage = async ({
  params,
}: {
  readonly params: Promise<{ readonly agentId: string }>;
}) => {
  const { agentId } = await params;

  // Null covers both "no such agent" and "another organisation's agent", which under RLS
  // are the same fact. 404 for both; a distinct 403 would confirm the id exists.
  const agent = await findAgent(agentId).catch(() => null);
  if (agent === null) notFound();

  const now = Date.now();
  const since = new Date(now - WINDOW_DAYS * DAY_MS).toISOString();
  const previousStart = new Date(now - 2 * WINDOW_DAYS * DAY_MS).toISOString();

  const [liveConfiguration, tools, knowledge, readiness, versionPage] = await Promise.all([
    currentConfiguration(),
    readTools(),
    readKnowledge(),
    readinessReport(),
    listVersions(),
  ]);

  /* Counts and signals are decoration relative to the agent itself, and none of them may
     take the page down — so every one is settled rather than awaited outright. */
  const [thisWeek, thisWeekClean, lastWeek, lastWeekClean, recent, trends, metrics, queue] =
    await Promise.allSettled([
      listCalls({ from: since, agentId, perPage: 1 }),
      listCalls({ from: since, agentId, endReason: RESOLVED, perPage: 1 }),
      listCalls({ from: previousStart, to: since, agentId, perPage: 1 }),
      listCalls({ from: previousStart, to: since, agentId, endReason: RESOLVED, perPage: 1 }),
      listCalls({ agentId, perPage: RECENT }),
      callTrends(),
      callMetrics(),
      listReviewQueue(),
    ]);

  const calls7d = totalOf(thisWeek);
  const clean7d = totalOf(thisWeekClean);
  const callsBefore = totalOf(lastWeek);
  const cleanBefore = totalOf(lastWeekClean);

  /* The live p50 against the previous configuration version's. Trends is already grouped
     by version, which is the comparison that explains a change — a rollout is the usual
     reason latency moves, and "against last week" would blur two rollouts together. */
  const versions = trends.status === "fulfilled" ? trends.value.versions : [];
  const liveP50 = metrics.status === "fulfilled" ? metrics.value.responseLatencyMs.p50 : null;
  const previousP50 = versions[1]?.responseLatencyP50Ms ?? null;

  const resolvedNow = percent(clean7d, calls7d);

  const stats: AgentStats = {
    calls7d,
    callsDelta: countDelta(calls7d, callsBefore),
    resolvedPercent: resolvedNow,
    resolvedDelta: pointsDelta(resolvedNow, percent(cleanBefore, callsBefore)),
    responseP50Ms: liveP50,
    p50Delta: latencyDelta(liveP50, previousP50),
  };

  /* Only what somebody can act on, and only when there is something to act on. An
     attention list that always has three rows is furniture. */
  const attention: AttentionItem[] = [];

  const flagged = queue.status === "fulfilled" ? queue.value.flagged : 0;
  if (flagged > 0) {
    attention.push({
      id: "review",
      label: "needs review",
      tone: "warn",
      detail: `${flagged} ${flagged === 1 ? "call is" : "calls are"} waiting on a verdict`,
      actionLabel: "Review",
      href: "/review",
    });
  }

  /* `detail`, not `title`. The titles are phrased as the state you want — "A number is
     attached", "Business hours are settled" — so pairing one with a "blocked" tag reads as
     a contradiction rather than a problem. `detail` is the readiness report's own account
     of what is actually wrong, which is the sentence this row exists to carry. */
  for (const check of readiness.checks.filter((c) => c.state !== "ok")) {
    attention.push({
      id: `check-${check.id}`,
      label: check.state === "blocked" ? "blocked" : "not ready",
      tone: check.state === "blocked" ? "bad" : "warn",
      detail: check.detail,
      actionLabel: "Open",
      // Where the fix lives. Numbers and their carrier wiring are an operator's screen;
      // everything else is edited on this page, so those point back at the right tab.
      href: check.id.startsWith("number.") ? "/numbers" : `/agents/${agentId}`,
    });
  }

  const toolFailure =
    metrics.status === "fulfilled" && metrics.value.toolFailureRate !== null
      ? Number(metrics.value.toolFailureRate)
      : 0;
  if (toolFailure > 0) {
    attention.push({
      id: "tools",
      label: "tool failing",
      tone: "bad",
      detail: `A tool failed on ${Math.round(toolFailure * 100)}% of the calls that used one`,
      actionLabel: "Open",
      href: "/tools",
    });
  }

  return (
    <AgentWorkspace
      agent={agent}
      liveConfiguration={liveConfiguration}
      tools={tools}
      knowledge={knowledge}
      versions={versionPage.items}
      stats={stats}
      attention={attention}
      recentCalls={recent.status === "fulfilled" ? recent.value.items : []}
    />
  );
};

export default AgentWorkspacePage;
