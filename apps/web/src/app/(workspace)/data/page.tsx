import type { Metadata } from "next";

import { Card, Notice, PageHeader, SelectField, TextField } from "@/components/ui";
import { liveAgents } from "@/features/agents/agents.service";
import { pivot } from "@/features/calls/captures";
import { listCaptures } from "@/features/calls/calls.service";
import { CapturesTable } from "@/features/calls/components/captures-table";
import { ExportMenu } from "@/features/calls/components/export-menu";

export const metadata: Metadata = { title: "Collected data · Ansa" };
export const dynamic = "force-dynamic";

/**
 * Everything the agents collected from callers, in one place.
 *
 * The call page answers "what happened on this call". This answers "what did we get", which
 * is the question the capture fields were configured for and the one nothing could answer
 * before: a value existed only inside the conversation it came from.
 *
 * Filters live in the URL rather than in client state, as everywhere else in the console,
 * so a filtered view is a link somebody can send and the back button behaves.
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

  const pivoted = pivot(captures.value.rows);
  const agentOptions = agents.status === "fulfilled" ? agents.value : [];
  const values = captures.value.rows.length;

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

      <div className="flex flex-col gap-3.5">
        {/* A plain GET form. No JavaScript, and the result is a URL. */}
        <Card title="Filter">
          <form method="get" className="grid gap-3.5 sm:grid-cols-3">
            <SelectField name="agentId" label="Agent" defaultValue={search.agentId ?? ""}>
              <option value="">All agents</option>
              {agentOptions.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.name}
                </option>
              ))}
            </SelectField>
            <TextField name="from" label="From" type="date" defaultValue={search.from ?? ""} />
            <TextField name="to" label="To" type="date" defaultValue={search.to ?? ""} />
          </form>
        </Card>

        {captures.value.truncated && (
          /* Said out loud rather than left to be discovered. An export that quietly stopped
             at a limit is worse than no export, because it looks complete. */
          <Notice tone="warn">
            More values matched than one page returns. Narrow the date range before
            exporting, or the file will be missing the oldest of them.
          </Notice>
        )}

        <Card
          title="Values"
          description={
            values === 0
              ? "Nothing collected in this range."
              : `${values} ${values === 1 ? "value" : "values"} across ${pivoted.calls.length} ${
                  pivoted.calls.length === 1 ? "call" : "calls"
                }`
          }
        >
          <CapturesTable pivoted={pivoted} />
        </Card>
      </div>
    </>
  );
};

export default DataPage;
