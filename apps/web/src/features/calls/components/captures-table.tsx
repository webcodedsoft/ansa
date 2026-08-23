import Link from "next/link";

import { EmptyState, Table, Td, Th, Tr } from "@/components/ui";
import { when } from "@/lib/format";

import { label, type Pivoted } from "../captures";

/**
 * The dataset, one call per row.
 *
 * Columns come from the rows on screen rather than from any agent's configuration, because
 * a filter spanning two agents spans two forms and neither one's field list is the right
 * answer. A field an agent stopped asking for keeps its column for as long as calls that
 * answered it are in range, which is what somebody looking at last month expects.
 */
export const CapturesTable = ({ pivoted }: { readonly pivoted: Pivoted }) => {
  if (pivoted.calls.length === 0) {
    return (
      <EmptyState title="No values collected yet. A call collects data once its agent has capture fields configured and a caller answers one." />
    );
  }

  return (
    <Table>
      <thead>
        <Tr>
          <Th className="w-[150px]">When</Th>
          <Th className="w-[150px]">Caller</Th>
          {pivoted.columns.map((column) => (
            <Th key={column.key}>{label(column.key)}</Th>
          ))}
        </Tr>
      </thead>
      <tbody>
        {pivoted.calls.map((call) => (
          <Tr key={call.callId}>
            <Td className="whitespace-nowrap text-[var(--ink-3)]">
              {/* Through to the call, because the next question after "what did they say"
                  is almost always "what else happened on that call". */}
              <Link href={`/calls/${call.callId}`} className="hover:text-[var(--ink)] hover:underline">
                {when(call.calledAt)}
              </Link>
            </Td>
            <Td className="tabular-nums whitespace-nowrap">{call.caller ?? "Unknown"}</Td>
            {pivoted.columns.map((column) => {
              const value = call.values.get(column.key);
              return (
                <Td key={column.key} className={value === undefined ? "text-[var(--ink-4)]" : "break-all"}>
                  {/* A dash, not an empty cell. "This agent never asks for it" and "the
                      caller would not give it" both end up here, and a blank reads as a
                      rendering fault rather than as an answer. */}
                  {value ?? "—"}
                </Td>
              );
            })}
          </Tr>
        ))}
      </tbody>
    </Table>
  );
};
