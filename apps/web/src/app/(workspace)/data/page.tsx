import type { Metadata } from "next";
import Link from "next/link";

import { Button, Card, Notice, PageHeader, Panel, Stat, TextField, buttonClass } from "@/components/ui";
import { liveAgents } from "@/features/agents/agents.service";
import { columnsForAgent, healthForAgent, pivot, questionDetail } from "@/features/calls/captures";
import { listCaptures } from "@/features/calls/calls.service";
import { AgentDataset } from "@/features/calls/components/agent-dataset";
import { AgentFieldHealthTable } from "@/features/calls/components/agent-field-health";
import { ExportMenu } from "@/features/calls/components/export-menu";
import { QuestionView } from "@/features/calls/components/question-view";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Collected data · Ansa" };
export const dynamic = "force-dynamic";

/**
 * What one agent collected from its callers.
 *
 * The agent is the axis, not a filter. That is not a presentation choice — it follows from
 * the data: a value belongs to a call, a call belongs to one agent, and the questions asked
 * are that agent's form. Showing every agent at once produces a union of forms that no column
 * list is right for, which is what the previous version did and why most of its cells were
 * empty.
 *
 * Reading it per agent buys the thing the old page could not do at all. Columns come from the
 * agent's configured fields rather than from the values that came back, so a question nobody
 * has ever answered still appears — with a zero against it. No value, no column meant the
 * worst question in the form was the one you could not see.
 *
 * Filters stay in the URL, as everywhere else in the console, so a view is a link somebody
 * can send and the back button behaves.
 */
type DataSearch = {
  readonly agentId?: string;
  /** One question, drilled into from the list. Absent means the list. */
  readonly field?: string;
  readonly from?: string;
  readonly to?: string;
};

const DataPage = async ({ searchParams }: { readonly searchParams: Promise<DataSearch> }) => {
  const search = await searchParams;

  /* The agents come first here, unlike the previous version where they were a dropdown that
     could fail without consequence. The chosen agent decides the columns, so the page cannot
     be drawn without one — a failure to load them is a failure to load the page. */
  const agents = await liveAgents();
  const chosen = agents.find((agent) => agent.agentId === search.agentId) ?? agents[0];

  if (chosen === undefined) {
    return (
      <>
        <PageHeader eyebrow="Operate" title="Collected data" />
        <Panel>
          <div className="p-8 text-center text-[13.5px] text-[var(--ink-3)]">
            No agent is answering yet. Build one, give it questions to ask, and what callers
            tell it will appear here.
          </div>
        </Panel>
      </>
    );
  }

  const captures = await listCaptures({
    agentId: chosen.agentId,
    from: search.from,
    to: search.to,
  });

  const rows = captures.rows;

  /* Third level: one question. Reached by clicking a row in the list below, and rendered from
     the rows already fetched — the whole agent's range is in hand, so drilling into a question
     is a filter rather than a round trip. */
  const asked = chosen.capturedFields.find((field) => field.key === search.field);
  if (search.field !== undefined && asked !== undefined) {
    return (
      <QuestionView
        detail={questionDetail(rows, asked.key, asked.type, asked.options)}
        agentId={chosen.agentId}
        prompt={asked.prompt}
      />
    );
  }

  const pivoted = pivot(rows);
  const form = chosen.capturedFields.map((field) => ({ key: field.key, type: field.type }));
  const columns = columnsForAgent(rows, form);
  const health = healthForAgent(rows, form);
  const unanswered = health.filter((field) => field.count === 0 && !field.retired).length;
  const retried = rows.filter((row) => row.attempts > 1).length;
  const dated = [search.from, search.to].some((value) => value !== undefined && value !== "");

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Collected data"
        meta="What callers told this agent and confirmed, newest call first."
        actions={
          <ExportMenu
            query={{ agentId: chosen.agentId, from: search.from, to: search.to }}
            disabled={pivoted.calls.length === 0}
          />
        }
      />

      {/* The axis. One agent is a caption; several are a choice, and it is the first choice on
          the page rather than a field inside a filter panel. */}
      {agents.length > 1 ? (
        <div className="mb-3.5 flex flex-wrap gap-1.5">
          {agents.map((agent) => {
            const on = agent.agentId === chosen.agentId;
            return (
              <Link
                key={agent.agentId}
                href={`/data?agentId=${agent.agentId}`}
                className={cn(
                  "rounded-[4px] border px-3 py-1.5 text-[13px] transition-colors",
                  on
                    ? "border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[var(--accent-soft)] font-medium text-[var(--accent)]"
                    : "border-[var(--hairline)] text-[var(--ink-2)] hover:border-[var(--ink-3)]",
                )}
              >
                {agent.name}
              </Link>
            );
          })}
        </div>
      ) : (
        <p className="mb-3.5 font-mono text-[11px] tracking-[0.13em] text-[var(--ink-3)] uppercase">
          {chosen.name}
        </p>
      )}

      <div className="grid gap-3.5 sm:grid-cols-3">
        <Stat
          label="Values collected"
          value={rows.length}
          trend={`across ${pivoted.calls.length} ${pivoted.calls.length === 1 ? "call" : "calls"}`}
        />
        <Stat
          label="Asked more than once"
          value={retried}
          tone={retried === 0 ? "flat" : "down"}
          trend={rows.length === 0 ? undefined : `${Math.round((retried / rows.length) * 100)}% of values`}
        />
        {/* The figure only a form-driven view can produce. */}
        <Stat
          label="Never answered"
          value={unanswered}
          tone={unanswered === 0 ? "flat" : "down"}
          trend={`of ${form.length} ${form.length === 1 ? "question" : "questions"} asked`}
        />
      </div>

      <div className="mt-[26px] flex flex-col gap-3.5">
        <Panel>
          <form method="get" className="flex flex-wrap items-end gap-3 p-4">
            <input type="hidden" name="agentId" value={chosen.agentId} />
            <TextField
              name="from"
              label="From"
              type="date"
              defaultValue={search.from ?? ""}
              className="min-w-[160px]"
            />
            <TextField
              name="to"
              label="To"
              type="date"
              defaultValue={search.to ?? ""}
              className="min-w-[160px]"
            />
            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary">
                Apply
              </Button>
              {dated && (
                <Link href={`/data?agentId=${chosen.agentId}`} className={buttonClass("ghost")}>
                  Clear dates
                </Link>
              )}
            </div>
            <p className="w-full text-xs text-[var(--ink-3)]">
              From is inclusive and To is exclusive, so consecutive ranges never share a call.
            </p>
          </form>
        </Panel>

        {captures.truncated && (
          /* Said out loud rather than left to be discovered. An export that quietly stopped at
             a limit is worse than no export, because it looks complete. */
          <Notice tone="warn">
            More values matched than one page returns. Narrow the date range before exporting,
            or the file will be missing the oldest of them — and the figures above describe only
            what is shown.
          </Notice>
        )}

        {health.length > 0 && (
          <Card
            title="How the questions are doing"
            description="Every question this agent asks, in the order it asks them. Open one to see what people answered."
          >
            <AgentFieldHealthTable fields={health} agentId={chosen.agentId} />
          </Card>
        )}

        <Card
          title="Every answer"
          description={
            rows.length === 0
              ? "Nothing collected in this range."
              : `${rows.length} ${rows.length === 1 ? "value" : "values"} across ${pivoted.calls.length} ${
                  pivoted.calls.length === 1 ? "call" : "calls"
                }, one row per call`
          }
        >
          <AgentDataset pivoted={pivoted} columns={columns} />
        </Card>
      </div>
    </>
  );
};

export default DataPage;
