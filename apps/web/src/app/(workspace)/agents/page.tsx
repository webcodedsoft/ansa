import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState, PageHeader, SectionHead, Stat, buttonClass } from "@/components/ui";
import { liveAgents, readTools, readinessReport } from "@/features/agents/agents.service";
import {
  AgentCards,
  type AgentRow,
  type AgentStatus,
} from "@/features/agents/components/agent-table";
import { listCalls } from "@/features/calls/calls.service";
import { listCredentials, listNumbers } from "@/features/connect/connect.service";

export const metadata: Metadata = { title: "Agents · Ansa" };
export const dynamic = "force-dynamic";

const WINDOW_DAYS = 7;

/** A call that ended this way did its job. Anything else is a transfer, a drop or a failure. */
const RESOLVED_END_REASON = "completed";

/**
 * What to say under the agent's name.
 *
 * The persona is the closest thing an agent has to a description, so it is used when there
 * is one. Falling back to what is configured is deliberate: a blank line under the name
 * reads as a rendering fault, and "No persona set" tells somebody what to go and do.
 */
const summarise = (persona: string | null, tools: number): string => {
  if (persona !== null && persona.trim() !== "") return persona;
  if (tools > 0) return `${tools} ${tools === 1 ? "tool" : "tools"} enabled`;
  return "No persona set";
};

/**
 * Answering, paused, or not yet routed.
 *
 * Readiness is organisation-wide today — it checks the carrier, the voice and the
 * credentials, none of which is per agent — so a failing check pauses all of them, which
 * is honest, because none of them can answer. What *is* per agent is whether a number
 * reaches it, and that is checked first: an agent with no number is not paused, it is
 * unrouted, and those are different things to go and fix.
 */
const statusOf = (
  dialledNumber: string | null,
  live: boolean,
  failing: number,
): AgentStatus => {
  if (dialledNumber === null) return { kind: "paused", reason: "no number" };
  if (!live) {
    return {
      kind: "paused",
      reason: failing === 1 ? "1 check failing" : `${failing} checks failing`,
    };
  }
  return { kind: "answering" };
};

/**
 * The agent list.
 *
 * Reads `GET /agents`, so it shows however many an organisation runs. Retired agents are
 * filtered out here rather than in the API, which returns them because the call log still
 * needs their names.
 *
 * The two count columns are two total-only queries per agent over the same seven-day
 * window — one for every call it handled, one for the calls that ended as `completed`.
 * Filtered by `agentId` rather than by number on purpose: a number can be moved between
 * agents, and "calls this agent handled" survives a reassignment where "calls to this
 * line" does not.
 */
const AgentsPage = async () => {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const agents = await liveAgents();

  /* Shared counts are decoration and must never take the page down: a failing credentials
     read should cost a number, not the agent somebody came here to open. */
  const [tools, numbers, credentials] = await Promise.allSettled([
    readTools(),
    listNumbers(),
    listCredentials(),
  ]);

  const toolCount =
    tools.status === "fulfilled" ? tools.value.http.length + tools.value.mcp.length : 0;
  const numberCount = numbers.status === "fulfilled" ? numbers.value.items.length : 0;
  const credentialCount = credentials.status === "fulfilled" ? credentials.value.items.length : 0;

  /* Three reads per agent, every one in flight at once. Sequentially this is 3N round trips
     end to end, and the page waits for the slowest either way.

     Readiness joined the fan-out when it stopped being organisation-wide. It used to be one
     report shown against every row, so an organisation whose first agent was wired reported
     every other agent as live — including one with no number at all. A report per agent costs
     a request per agent and is the only version of this column that means anything. */
  const counted = await Promise.all(
    agents.map(async (agent): Promise<AgentRow> => {
      const [all, clean, ready] = await Promise.allSettled([
        listCalls({ from: since, agentId: agent.agentId, perPage: 1 }),
        listCalls({
          from: since,
          agentId: agent.agentId,
          endReason: RESOLVED_END_REASON,
          perPage: 1,
        }),
        readinessReport(agent.agentId),
      ]);
      const total = all.status === "fulfilled" ? all.value.total : 0;
      const resolved = clean.status === "fulfilled" ? clean.value.total : 0;
      /* A readiness read that failed is not a passing one. Treated as not live with one
         unexplained check, which is what `unknown` means everywhere else on this surface: a
         check that could not run has not passed. */
      const live = ready.status === "fulfilled" ? ready.value.live : false;
      const failing =
        ready.status === "fulfilled"
          ? ready.value.checks.filter((check) => check.state !== "ok").length
          : 1;

      return {
        id: agent.agentId,
        name: agent.name,
        summary: summarise(agent.persona, agent.enabledTools.length),
        answersOn: agent.dialledNumber,
        status: statusOf(agent.dialledNumber, live, failing),
        calls7d: total,
        // Null, not zero: no calls at all and no clean calls are different readings, and a
        // dash says the first where "0%" would accuse the agent of the second.
        resolved: total === 0 ? null : resolved / total,
        version: agent.configVersion,
      };
    }),
  );

  return (
    <>
      <PageHeader
        eyebrow="Agents"
        title="Agents"
        meta="Each agent answers its own numbers with its own script, vocabulary and tools. Calls, metrics and versions all belong to one."
        actions={
          <Link href="/agents/new" className={buttonClass("primary")}>
            <Plus aria-hidden className="size-4" />
            New agent
          </Link>
        }
      />

      {counted.length === 0 ? (
        <EmptyState title="No agents yet">
          An agent is what a caller hears: a name, a script, a voice and the tools it may
          use. Create one, then route one of this organisation&rsquo;s numbers to it.
        </EmptyState>
      ) : (
        <AgentCards agents={counted} />
      )}

      <SectionHead>Shared across agents</SectionHead>
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
        {/* Linked, because each of these numbers is the front door to the page that
            explains it — a count you cannot act on is trivia. */}
        <Link href="/tools" className="rounded-[14px] transition-opacity hover:opacity-85">
          <Stat label="Tools" value={toolCount} trend="registry, risk tiers" />
        </Link>
        <Link href="/numbers" className="rounded-[14px] transition-opacity hover:opacity-85">
          <Stat label="Numbers" value={numberCount} trend="routed to agents" />
        </Link>
        <Link href="/credentials" className="rounded-[14px] transition-opacity hover:opacity-85">
          <Stat label="Credentials" value={credentialCount} trend="never leave the vault" />
        </Link>
      </div>
    </>
  );
};

export default AgentsPage;
