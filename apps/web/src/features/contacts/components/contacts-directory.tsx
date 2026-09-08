import Link from "next/link";

import { EmptyState, GroupRow, Panel, Table, Td } from "@/components/ui";
import { cn } from "@/lib/cn";
import { phone, when } from "@/lib/format";

import { contextOf, initialsOf, nameOf } from "../contacts.display";
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
 *
 * **No column header row.** Four headings over a list whose columns are a person, what they
 * wanted, a count and a date label nothing the reader could not already see, and they put a
 * second band of chrome directly under the panel's own title. The band headings — TODAY, THIS
 * WEEK — are the structure that earns its line here.
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

/**
 * How many times this person has rung, as one pill in two colours.
 *
 * The same shape whether they have called once or twenty times — a row where the figure
 * changes shape as well as value reads as two different kinds of row. Colour carries the
 * difference on its own: a repeat caller takes the accent because they are the reason a
 * callback list exists, and everybody else takes the hairline.
 *
 * The figure is alone on screen and labelled only to a screen reader. With no column header
 * above it the word would be the only thing naming it, but "4 calls" repeated down a narrow
 * column reads as a sentence fragment rather than a count — so the label goes where it costs
 * no width and is still announced.
 */
const CallCount = ({ count }: { readonly count: number }) => (
  <span
    aria-label={`${count} ${count === 1 ? "call" : "calls"}`}
    className={cn(
      "inline-flex min-w-[26px] items-center justify-center rounded-[4px] border px-1.5 py-0.5 text-[12px] font-medium tabular-nums",
      count > 1
        ? "border-[color-mix(in_srgb,var(--accent)_34%,transparent)] bg-[var(--accent-soft)] text-[var(--accent)]"
        : "border-[var(--hairline)] text-[var(--ink-3)]",
    )}
  >
    {count}
  </span>
);

const COLUMNS = 4;

export const ContactsDirectory = ({
  people,
  shown,
  total,
  identifiedOnly,
  everyoneHref,
}: {
  readonly people: readonly ContactSummary[];
  /** How many this filter matched, across every page — not how many rows are on this one. */
  readonly shown: number;
  /** How many people the organisation holds in total, so the filter's cost is visible. */
  readonly total: number;
  readonly identifiedOnly: boolean;
  /** Where "show me everybody" goes, carrying whatever search is running. */
  readonly everyoneHref: string;
}) => {
  if (people.length === 0) {
    /* Two different nothings, and saying the wrong one sends somebody to look for a bug.
       "Nobody yet" over an organisation holding two dozen callers is how the default filter
       reads as a broken page: everyone had rung and nobody had confirmed a value, so the
       directory was empty and the call log was not. Say which nothing this is. */
    return (
      <Panel>
        {total === 0 ? (
          <EmptyState title="Nobody yet">
            A person appears here the first time a call arrives carrying a number. Calls from a
            withheld number have nobody to file them under and stay on the call record alone.
          </EmptyState>
        ) : (
          <EmptyState title="Nobody has told us anything yet">
            {total === 1 ? "One person has" : `${total} people have`} called, and none of them
            confirmed a name or any other value — so they are all behind{" "}
            <Link href={everyoneHref} className="text-[var(--accent)] underline underline-offset-2">
              Everyone
            </Link>
            . They move here on their own the first time one of them tells the agent something.
          </EmptyState>
        )}
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
    <Panel>
      {/* The panel says what it is and what it is currently showing you. "5 of 7" is the
          whole argument for the filter being visible: it says a filter is on and what it
          costs, which a highlighted toggle on its own does not. */}
      <div className="flex items-center justify-between gap-3 border-b border-[var(--surface-line)] px-4 py-3">
        <h2 className="text-[13.5px] leading-tight font-semibold tracking-[-0.012em]">Directory</h2>
        <span className="flex-none text-[12px] text-[var(--ink-3)] tabular-nums">
          {shown} of {total} · {identifiedOnly ? "identified only" : "everyone"}
        </span>
      </div>

      <Table>
        {bands.map((band) => (
          <tbody key={band.label} className="last:[&>tr:last-child>td]:border-b-0">
            <GroupRow label={band.label} columns={COLUMNS} />
            {band.people.map((person) => {
              const context = contextOf(person);
              return (
                <tr key={person.id} className="transition-colors hover:bg-[var(--surface-2)]">
                  <Td>
                    <Link href={`/contacts/${person.id}`} className="flex items-center gap-3">
                      {/* Round, because it stands for a person. Every other small square on
                          this page stands for a thing — a count, a tag, a status. */}
                      <span
                        aria-hidden
                        className="grid size-[30px] flex-none place-items-center rounded-full border border-[var(--hairline)] bg-[var(--surface-2)] font-mono text-[11px] font-semibold text-[var(--ink-2)]"
                      >
                        {initialsOf(person)}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[13.5px] font-medium">{nameOf(person)}</span>
                          {/* Only ever seen under "Everyone", where it is the reason a row with
                              no name is in the list at all. */}
                          {!person.identified && (
                            <span className="flex-none rounded border border-[var(--hairline)] px-1 py-px text-[10px] font-semibold tracking-[0.04em] text-[var(--ink-3)] uppercase">
                              told us nothing
                            </span>
                          )}
                        </span>
                        {/* The number under the name rather than in a column of its own: it is
                            how you recognise somebody, not a field you sort by. */}
                        {/* Grouped the way it is said, the same as the calls table. The raw
                            E.164 run was the one thing on this page a person could not read
                            at a glance, and it is the field they are here to recognise. */}
                        <span className="block truncate font-mono text-[11.5px] text-[var(--ink-3)]">
                          {phone(person.phone)}
                        </span>
                      </span>
                    </Link>
                  </Td>
                  {/* What they wanted. The column that turns a list of numbers into a list of
                      reasons to ring somebody back. Nothing when they confirmed only a name. */}
                  <Td className="max-w-0 text-[12.5px] text-[var(--ink-3)]">
                    <span className="block truncate">{context}</span>
                  </Td>
                  <Td className="w-[86px] text-right">
                    <CallCount count={person.callCount} />
                  </Td>
                  <Td className="w-[150px] text-right text-[12.5px] whitespace-nowrap text-[var(--ink-3)]">
                    {person.lastCallAt === null ? "—" : when(person.lastCallAt)}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </Table>
    </Panel>
  );
};
