import Link from "next/link";

import { EmptyState, GroupRow, Panel, Table, Td, Th, Tr } from "@/components/ui";
import { when } from "@/lib/format";

import { nameOf } from "../contacts.display";
import type { ContactSummary } from "../contacts.service";

/**
 * The directory, as a call sheet rather than a spreadsheet.
 *
 * The page exists to answer one question — who should I ring back — so the rows are grouped
 * by how recently somebody called and ordered newest first. That is the same idiom the calls
 * table uses for days, and for the same reason: a heading that says "This week" does more
 * work than a column of dates the reader has to compare.
 *
 * Somebody who has rung more than once is the most important row on the page, so the count
 * carries the accent and nothing else on the row does. One signal, and it is the true one.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Recency bands, coarse on purpose: a callback list is not a calendar. */
const bandOf = (lastCallAt: string | null, now: number): string => {
  if (lastCallAt === null) return "No calls recorded";
  const age = now - new Date(lastCallAt).getTime();
  if (age < DAY_MS) return "Today";
  if (age < 7 * DAY_MS) return "This week";
  if (age < 30 * DAY_MS) return "This month";
  return "Earlier";
};

/** Two letters from the name, or the last two digits when nobody has given one. */
const initialsOf = (person: ContactSummary): string => {
  const name = nameOf(person);
  if (name !== "Unnamed caller") {
    const parts = name.split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] ?? "";
    const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : (parts[0]?.[1] ?? "");
    return `${first}${second}`.toUpperCase();
  }
  return person.phone.replace(/\D/g, "").slice(-2);
};

const COLUMNS = 3;

export const ContactsDirectory = ({ people }: { readonly people: readonly ContactSummary[] }) => {
  if (people.length === 0) {
    return (
      <Panel>
        <EmptyState title="Nobody yet">
          A person appears here the first time a caller confirms something — their name, a
          callback number, whatever the agent is set to collect. Calls from a withheld number
          have nobody to file them under and stay on the call record alone.
        </EmptyState>
      </Panel>
    );
  }

  /* Banded on the server's clock, once, rather than per row. Two rows a millisecond apart
     must not land in different bands because the second one was formatted later. */
  const now = Date.now();
  const bands: { label: string; people: ContactSummary[] }[] = [];
  for (const person of people) {
    const label = bandOf(person.lastCallAt, now);
    const last = bands[bands.length - 1];
    if (last !== undefined && last.label === label) last.people.push(person);
    else bands.push({ label, people: [person] });
  }

  return (
    <div className="surface overflow-hidden rounded-xl">
      <Table>
        <thead>
          <Tr>
            <Th>Who</Th>
            <Th className="w-[132px] text-right">Calls</Th>
            <Th className="w-[190px] text-right">Last call</Th>
          </Tr>
        </thead>
        {bands.map((band) => (
          <tbody key={band.label} className="last:[&>tr:last-child>td]:border-b-0">
            <GroupRow
              label={band.label}
              columns={COLUMNS}
              action={
                <span className="flex-none text-xs tabular-nums text-[var(--ink-3)]">
                  {band.people.length} {band.people.length === 1 ? "person" : "people"}
                </span>
              }
            />
            {band.people.map((person) => (
              <tr key={person.id} className="transition-colors hover:bg-[var(--surface-2)]">
                <Td>
                  <Link href={`/contacts/${person.id}`} className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="grid size-[30px] flex-none place-items-center rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] font-mono text-[11px] font-semibold text-[var(--ink-2)]"
                    >
                      {initialsOf(person)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-medium">
                        {nameOf(person)}
                      </span>
                      {/* The number under the name rather than in a column of its own: it is
                          how you recognise somebody, not a field you sort by. */}
                      <span className="block truncate font-mono text-[11.5px] text-[var(--ink-3)]">
                        {person.phone}
                      </span>
                    </span>
                  </Link>
                </Td>
                <Td className="text-right">
                  <span
                    className={
                      person.callCount > 1
                        ? "inline-flex items-center rounded-[4px] border border-[color-mix(in_srgb,var(--accent)_34%,transparent)] bg-[var(--accent-soft)] px-2 py-0.5 text-[12px] font-medium tabular-nums text-[var(--accent)]"
                        : "text-[12.5px] tabular-nums text-[var(--ink-3)]"
                    }
                  >
                    {person.callCount}
                    {person.callCount > 1 && " calls"}
                  </span>
                </Td>
                <Td className="text-right text-[12.5px] whitespace-nowrap text-[var(--ink-3)]">
                  {person.lastCallAt === null ? "—" : when(person.lastCallAt)}
                </Td>
              </tr>
            ))}
          </tbody>
        ))}
      </Table>
    </div>
  );
};
