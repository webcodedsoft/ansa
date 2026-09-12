import Link from "next/link";

import { Blip, GroupRow, Table, Tag, Td, Th } from "@/components/ui";
import { dayLabel, duration, millis, phone, timeOfDay } from "@/lib/format";

import type { CallSummary } from "../calls.service";
import { outcomeOf } from "../outcome";
import { CallDirection } from "./call-direction";

/** The far end of a call, whichever end that is. Our own number is never the useful one. */
const counterparty = (call: CallSummary): string =>
  call.direction === "outbound" ? call.dialled : (call.caller ?? "unknown");


/* One reading of `end_reason` for the whole console — see `outcomeOf`. The transport's exit
   codes never reach this column; they live in the call page's event log. */
const Outcome = ({ call }: { readonly call: CallSummary }) => {
  const outcome = outcomeOf(call.endReason, call.endedAt !== null);
  return (
    <Tag tone={outcome.tone}>
      {call.endedAt === null && <Blip pulse />}
      {outcome.label}
    </Tag>
  );
};

/** Every column, once, so the group rows span exactly this many. */
const COLUMNS = 6;

/**
 * One table, with the days marked inside it.
 *
 * The days used to be separate tables in separate panels, and that was wrong in two
 * ways you could see. Each table sized its own columns, so the widths only agreed
 * because every one of them was pinned by hand — and the column headers belonged to
 * the first table, leaving every day below it as six unlabelled columns. Merging
 * fixes both, and the day heading becomes a row like any other.
 *
 * Grouped by calendar day at all because "was that today or yesterday?" is the first
 * question anyone reading this list is answering. Groups preserve the API's
 * newest-first order; nothing is re-sorted here.
 */
export const CallTable = ({ calls }: { readonly calls: readonly CallSummary[] }) => {
  const days: { readonly label: string; readonly calls: CallSummary[] }[] = [];
  for (const call of calls) {
    const label = dayLabel(call.createdAt);
    const last = days[days.length - 1];
    if (last !== undefined && last.label === label) last.calls.push(call);
    else days.push({ label, calls: [call] });
  }

  return (
    <div className="surface overflow-hidden rounded-xl">
      <Table>
        <thead>
          <tr>
            <Th className="w-[86px]">When</Th>
            <Th className="w-[124px]">Direction</Th>
            <Th>Number</Th>
            <Th className="w-[92px] text-right">Length</Th>
            <Th className="w-[176px]">Outcome</Th>
            <Th className="w-[124px] text-right">Latency p50</Th>
          </tr>
        </thead>
        {/* A tbody per day rather than one holding everything: it is the element
            HTML already has for a run of related rows, so the grouping reaches
            assistive technology without any aria, and the last-row border rule
            below can mean the last row of the table rather than of each day. */}
        {days.map((day) => {
          const live = day.calls.filter((call) => call.endedAt === null).length;
          return (
            <tbody key={day.label} className="last:[&>tr:last-child>td]:border-b-0">
              <GroupRow
                label={day.label}
                columns={COLUMNS}
                action={
                  <span className="flex-none text-xs tabular-nums text-[var(--ink-3)]">
                    {day.calls.length} {day.calls.length === 1 ? "call" : "calls"}
                    {live > 0 && ` · ${live} live`}
                  </span>
                }
              />
              {day.calls.map((call) => (
                <tr key={call.id} className="transition-colors hover:bg-[var(--surface-2)]">
                  {/* Widths are declared on the header cells alone now. One table
                      means one column model, so repeating them here would be two
                      sources for one number. */}
                  <Td className="whitespace-nowrap tabular-nums">{timeOfDay(call.createdAt)}</Td>
                  <Td>
                    <Tag>
                      <CallDirection direction={call.direction} />
                    </Tag>
                  </Td>
                  <Td className="font-mono text-[13px] font-medium">
                    {/* The number is the link, and there is no separate "Read"
                        column — the number is what somebody is looking for anyway.
                        A whole-row overlay was the alternative and it needs
                        `position: relative` on a `<tr>`, which browsers do not
                        treat consistently. */}
                    <Link href={`/calls/${call.id}`} className="hover:underline">
                      {phone(counterparty(call))}
                    </Link>
                  </Td>
                  <Td className="text-right tabular-nums">{duration(call.durationSeconds)}</Td>
                  <Td>
                    <Outcome call={call} />
                  </Td>
                  <Td className="text-right font-mono text-[13px] tabular-nums text-[var(--ink-2)]">
                    {millis(call.responseP50Ms)}
                  </Td>
                </tr>
              ))}
            </tbody>
          );
        })}
      </Table>
    </div>
  );
};
