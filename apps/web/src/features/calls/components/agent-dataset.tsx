import Link from "next/link";

import { EmptyState, Table, Td, Th, Tr, Tag } from "@/components/ui";
import { when } from "@/lib/format";

import { label, type AgentColumn, type Pivoted } from "../captures";

/**
 * One agent's dataset: its own questions as columns, in the order it asks them.
 *
 * The columns come from the agent's form, not from the values that came back, which is what
 * reading this per agent buys. A question nobody has ever answered still gets a column — and
 * an empty one is the loudest thing on the page.
 *
 * Amounts and counts are right-aligned and tabular because they are numbers people compare
 * down a column; everything else reads as text. The type travels with each value, so a field
 * renders the way it was collected even after somebody changes the form.
 */

const NUMERIC = new Set(["amount", "quantity"]);

export const AgentDataset = ({
  pivoted,
  columns,
}: {
  readonly pivoted: Pivoted;
  readonly columns: readonly AgentColumn[];
}) => {
  if (columns.length === 0) {
    return (
      <EmptyState title="This agent asks for nothing yet">
        Add capture fields on the agent&rsquo;s Data captured tab and its calls will start
        filling this table.
      </EmptyState>
    );
  }

  if (pivoted.calls.length === 0) {
    return (
      <EmptyState title="No answers in this range">
        The agent has {columns.length} {columns.length === 1 ? "question" : "questions"}{" "}
        configured. Nothing was collected in the dates selected.
      </EmptyState>
    );
  }

  return (
    <Table>
      <thead>
        <Tr>
          <Th className="w-[150px]">When</Th>
          <Th className="w-[150px]">Caller</Th>
          {columns.map((column) => (
            <Th key={column.key} className={NUMERIC.has(column.type) ? "text-right" : undefined}>
              {label(column.key)}
              {column.retired && (
                <span className="ml-1.5 align-middle">
                  <Tag>retired</Tag>
                </span>
              )}
            </Th>
          ))}
        </Tr>
      </thead>
      <tbody>
        {pivoted.calls.map((call) => (
          <Tr key={call.callId}>
            <Td className="whitespace-nowrap text-[var(--ink-3)]">
              {/* Through to the call, because the next question after "what did they say" is
                  almost always "what else happened on that call". */}
              <Link href={`/calls/${call.callId}`} className="hover:text-[var(--ink)] hover:underline">
                {when(call.calledAt)}
              </Link>
            </Td>
            <Td className="tabular-nums whitespace-nowrap">{call.caller ?? "Unknown"}</Td>
            {columns.map((column) => {
              const value = call.values.get(column.key);
              const numeric = NUMERIC.has(column.type);
              return (
                <Td
                  key={column.key}
                  className={[
                    numeric ? "text-right tabular-nums" : "break-all",
                    value === undefined ? "text-[var(--ink-4)]" : "",
                  ].join(" ")}
                >
                  {/* A dash, not an empty cell: the agent asked and the caller did not answer,
                      which is a fact rather than a gap. A blank reads as a rendering fault. */}
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
