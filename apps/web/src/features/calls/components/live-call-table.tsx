import Link from "next/link";

import { Blip, EmptyState, Table, Tag, Td, Th, Tr } from "@/components/ui";
import { directionLabel, duration, when } from "@/lib/format";

import type { LiveCall } from "../calls.service";

/** The far end of a call, whichever end that is. Our own number is never the useful one. */
const counterparty = (call: LiveCall): string =>
  call.direction === "outbound" ? call.dialled : (call.caller ?? "unknown");

/** How long a call has been running, measured from when it was answered rather than dialled. */
const elapsedSeconds = (call: LiveCall): number => {
  const startedAt = call.answeredAt ?? call.createdAt;
  return Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
};

export const LiveCallTable = ({ calls }: { readonly calls: readonly LiveCall[] }) => {
  if (calls.length === 0) {
    return (
      <EmptyState title="Nothing in progress">
        Nobody is on a call right now. This page refreshes on its own — no need to reload.
      </EmptyState>
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>
            <span className="sr-only">Status</span>
          </Th>
          <Th>Direction</Th>
          <Th>Number</Th>
          <Th>Started</Th>
          <Th>Elapsed</Th>
          <Th>
            <span className="sr-only">Open</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {calls.map((call) => (
          <Tr key={call.id}>
            <Td>
              <span className="inline-flex items-center gap-1.5 text-[var(--ok)]">
                <Blip pulse />
                <span className="text-xs font-medium">live</span>
              </span>
            </Td>
            <Td>
              <Tag>{directionLabel(call.direction)}</Tag>
            </Td>
            <Td className="font-mono text-[13px]">{counterparty(call)}</Td>
            <Td className="tabular-nums">{when(call.createdAt)}</Td>
            <Td className="tabular-nums">{duration(elapsedSeconds(call))}</Td>
            <Td>
              <Link href={`/calls/${call.id}`} className="font-medium text-[var(--accent)] hover:underline">
                Open
              </Link>
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
};
