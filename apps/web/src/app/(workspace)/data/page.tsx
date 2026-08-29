import type { Metadata } from "next";
import Link from "next/link";

import { Button, Card, Notice, PageHeader, Panel, SelectField, Stat, TextField, buttonClass } from "@/components/ui";
import { liveAgents } from "@/features/agents/agents.service";
import { pivot, summarise } from "@/features/calls/captures";
import { listCaptures } from "@/features/calls/calls.service";
import { CapturesTable } from "@/features/calls/components/captures-table";
import { ExportMenu } from "@/features/calls/components/export-menu";
import { FieldHealth } from "@/features/calls/components/field-health";

export const metadata: Metadata = { title: "Collected data · Ansa" };
export const dynamic = "force-dynamic";

/**
 * Everything the agents collected from callers, in one place.
 *
 * The call page answers "what happened on this call". This answers two questions the call
 * page cannot: what did we get across every call, and — the one nothing could answer before
 * — which of our questions is not working. `attempts` has been recorded on every value since
 * the table existed and was shown nowhere, so a field the agent has to ask for three times
 * looked exactly like one it gets first time.
 *
 * Filters live in the URL rather than in client state, as everywhere else in the console, so
 * a filtered view is a link somebody can send and the back button behaves.
 */
type DataSearch = {
  readonly agentId?: string;
  readonly from?: string;
  readonly to?: string;
};

const DataPage = async ({ searchParams }: { readonly searchParams: Promise<DataSearch> }) => {
  const search = await searchParams;

  /* Both at once. The agent picker is a filter control, not a dependency of the rows, so
     making the table wait on it would be a second round trip for a dropdown.
     `allSettled` on the agents because a picker that fails to load must not take the data
     down with it — the table is the page. */
  const [captures, agents] = await Promise.allSettled([
    listCaptures({ agentId: search.agentId, from: search.from, to: search.to }),
    liveAgents(),
  ]);
  if (captures.status === "rejected") throw captures.reason;

  const rows = captures.value.rows;
  const pivoted = pivot(rows);
  const fields = summarise(rows);
  const agentOptions = agents.status === "fulfilled" ? agents.value : [];
  const retried = rows.filter((row) => row.attempts > 1).length;
  const filtered = [search.agentId, search.from, search.to].some(
    (value) => value !== undefined && value !== "",
  );

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Collected data"
        meta="What callers told the agents and confirmed, newest call first."
        actions={
          <ExportMenu
            query={{ agentId: search.agentId, from: search.from, to: search.to }}
            disabled={pivoted.calls.length === 0}
          />
        }
      />

      <div className="grid gap-3.5 sm:grid-cols-3">
        <Stat label="Values collected" value={rows.length} />
        <Stat
          label="Calls that gave us something"
          value={pivoted.calls.length}
          trend={`${fields.length} ${fields.length === 1 ? "field" : "fields"} in use`}
        />
        {/* The figure this page exists to surface. A caller repeating themselves is the
            cheapest signal there is that a question is badly worded. */}
        <Stat
          label="Asked more than once"
          value={retried}
          tone={retried === 0 ? "flat" : "down"}
          trend={
            rows.length === 0
              ? undefined
              : `${Math.round((retried / rows.length) * 100)}% of values`
          }
        />
      </div>

      <div className="mt-[26px] flex flex-col gap-3.5">
        {/* A plain GET form, and it now has a button. It did not: a `<select>` does not
            submit a form on change, so choosing an agent used to do nothing at all until
            somebody happened to press return inside one of the date fields. */}
        <Panel>
          <form method="get" className="flex flex-wrap items-end gap-3 p-4">
            <SelectField
              name="agentId"
              label="Agent"
              defaultValue={search.agentId ?? ""}
              className="min-w-[200px] flex-1"
            >
              <option value="">All agents</option>
              {agentOptions.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.name}
                </option>
              ))}
            </SelectField>
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
            {/* The note sits under the row, not on the last field. As a `hint` it added its
                own height to one control in a row aligned on its baseline, which lifted that
                field a line above the other two. */}
            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary">
                Apply
              </Button>
              {filtered && (
                <Link href="/data" className={buttonClass("ghost")}>
                  Clear
                </Link>
              )}
            </div>
            <p className="w-full text-xs text-[var(--ink-3)]">
              From is inclusive and To is exclusive, so consecutive ranges never share a call.
            </p>
          </form>
        </Panel>

        {captures.value.truncated && (
          /* Said out loud rather than left to be discovered. An export that quietly stopped
             at a limit is worse than no export, because it looks complete. */
          <Notice tone="warn">
            More values matched than one page returns. Narrow the date range before
            exporting, or the file will be missing the oldest of them — and the figures above
            describe only what is shown.
          </Notice>
        )}

        {fields.length > 0 && (
          <Card
            title="How the questions are doing"
            description="Every value records how many times the agent had to ask for it. A field repeated often is a prompt to rewrite, not a caller to blame."
          >
            <FieldHealth fields={fields} />
          </Card>
        )}

        <Card
          title="Every value"
          description={
            rows.length === 0
              ? "Nothing collected in this range."
              : `${rows.length} ${rows.length === 1 ? "value" : "values"} across ${pivoted.calls.length} ${
                  pivoted.calls.length === 1 ? "call" : "calls"
                }, one row per call`
          }
        >
          <CapturesTable pivoted={pivoted} />
        </Card>
      </div>
    </>
  );
};

export default DataPage;
