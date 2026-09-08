import { Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader, Pagination, Stat } from "@/components/ui";
import { CONTROL } from "@/components/ui";
import { currentPrincipal } from "@/features/auth/auth.service";
import { ContactsActions } from "@/features/contacts/components/contacts-actions";
import { ContactsDirectory } from "@/features/contacts/components/contacts-directory";
import { listContacts } from "@/features/contacts/contacts.service";
import { cn } from "@/lib/cn";
import { readPaging } from "@/lib/paging";

export const metadata: Metadata = { title: "Contacts · Ansa" };

/**
 * Where a filter segment points, carrying whatever search is already running.
 *
 * Built here rather than inline twice: the two segments differ only in one boolean, and
 * writing that twice is how one of them quietly stops carrying `q`.
 */
const hrefFor = (query: string | undefined, everyone: boolean): string => {
  const params = new URLSearchParams();
  if (everyone) params.set("who", "everyone");
  if (query !== undefined && query.trim() !== "") params.set("q", query);
  const search = params.toString();
  return search === "" ? "/contacts" : `/contacts?${search}`;
};
export const dynamic = "force-dynamic";

/**
 * The people who have called.
 *
 * Beside Collected data rather than instead of it, because the two answer different
 * questions. Collected data is every confirmation, one row per value, and is what you export
 * when somebody asks for the month's enquiries. This is one row per person, and is what you
 * open when somebody rings back.
 *
 * The three figures at the top are the only ones worth stating about a directory: how many
 * people there are, how many have rung more than once — which is what a callback list is
 * actually about — and how many are new this week. All three are counted across the
 * organisation by the API, not derived from the rows this page happens to hold, because a
 * total that changes when you turn the page is worse than no total.
 *
 * Search is a URL, like the calls filter: `?q=Lekki` is the whole state, so a search is a
 * link somebody can send and the back button behaves.
 */
const ContactsPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly q?: string;
    /** `everyone` lifts the identified filter. Absent means the default, identified only. */
    readonly who?: string;
    readonly page?: string;
    readonly perPage?: string;
  }>;
}) => {
  const search = await searchParams;
  const requested = readPaging(search);
  /* Identified by default. Everyone is remembered — a wrong number is still a person we hold
     a number for — but the directory leads with the ones who have told us something, or the
     customers sit underneath the misdials. */
  const everyone = search.who === "everyone";
  const [principal, { page, stats }] = await Promise.all([
    currentPrincipal(),
    listContacts(search.q, requested, everyone ? undefined : true),
  ]);
  const canWrite = principal.capabilities.includes("contacts:write");

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Contacts"
        actions={canWrite ? <ContactsActions /> : undefined}
        meta="Everyone who has called and everyone you have called. A person is created on the first answered call with a caller ID — and marked identified once they confirm something."
      />

      {/* Four figures and nothing under them. Each had a trend line and each restated
          something already on the page — "told us nothing" is a badge on the rows it
          describes, and the filter's own "5 of 7" says what the percentage said. A sub-line
          that repeats the page costs a third of the card's height to say it twice. */}
      <div className="grid gap-3.5 sm:grid-cols-4">
        <Stat label="People" value={stats.people} />
        <Stat label="Identified" value={stats.identified} />
        <Stat label="Rang more than once" value={stats.repeatCallers} />
        <Stat label="New this week" value={stats.newThisWeek} />
      </div>

      {/* One row: the field, and the filter it is filtered by. They were stacked, with a
          Search button between them, which read as three separate controls for one question.
          Enter submits — the button was the only thing making this look like a form to fill
          in rather than a box to type in — and a screen reader still gets an explicit submit. */}
      <div className="mt-[26px] flex items-center gap-2">
        <form method="get" className="min-w-0 flex-1">
          <label className="relative flex items-center">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 size-4 text-[var(--ink-3)]"
            />
            <span className="sr-only">Search contacts</span>
            <input
              type="search"
              name="q"
              defaultValue={search.q ?? ""}
              placeholder="A name, a number typed any way, or anything they told the agent"
              className={cn(CONTROL, "pl-9")}
            />
          </label>
          {/* Carried through the form so searching does not silently drop the filter. */}
          {everyone && <input type="hidden" name="who" value="everyone" />}
          <button type="submit" className="sr-only">
            Search
          </button>
        </form>

        {/* Links rather than a toggle: the filter is in the URL like the search and the page,
            so a filtered list is one somebody can send to a colleague. Styled as the console's
            `Segmented` control, which cannot be used directly — it takes an `onChange` and
            this is navigation. Two loose pills read as two tags; joined, they read as one
            control with two states, which is what this is. */}
        <div className="inline-flex flex-none gap-0.5 rounded-[6px] border border-[var(--hairline)] bg-[var(--surface-2)] p-0.5">
          <Link
            href={hrefFor(search.q, false)}
            aria-current={everyone ? undefined : "page"}
            className={cn(
              "rounded-[4px] px-2.5 py-1 text-[12.5px] transition-colors",
              everyone
                ? "text-[var(--ink-3)] hover:text-[var(--ink-2)]"
                : "bg-[var(--surface-solid)] font-medium text-[var(--ink)] shadow-[var(--shadow-s)]",
            )}
          >
            Identified
          </Link>
          <Link
            href={hrefFor(search.q, true)}
            aria-current={everyone ? "page" : undefined}
            className={cn(
              "rounded-[4px] px-2.5 py-1 text-[12.5px] transition-colors",
              everyone
                ? "bg-[var(--surface-solid)] font-medium text-[var(--ink)] shadow-[var(--shadow-s)]"
                : "text-[var(--ink-3)] hover:text-[var(--ink-2)]",
            )}
          >
            Everyone
          </Link>
        </div>
      </div>

      {/* The one thing about this search a person cannot guess: a number matches however it
          was typed, because the number is stored one way and searched every way. Worth a line
          under the field, where somebody who has just failed to find 0803 411 2290 is looking. */}
      <p className="mt-2 mb-3.5 text-[12px] text-[var(--ink-3)]">
        Try{" "}
        {["0803", "+234 803", "803 411"].map((example, index) => (
          <span key={example}>
            {index === 0 ? "" : index === 2 ? " or " : ", "}
            <code className="rounded border border-[var(--hairline)] bg-[var(--surface-2)] px-1 py-px font-mono text-[11px] text-[var(--ink-2)]">
              {example}
            </code>
          </span>
        ))}{" "}
        — one number, one person.
      </p>

      <ContactsDirectory
        people={page.items}
        shown={page.total}
        total={stats.people}
        identifiedOnly={!everyone}
        everyoneHref={hrefFor(search.q, true)}
      />

      <Pagination
        basePath="/contacts"
        page={page.page}
        perPage={page.perPage}
        totalPages={page.totalPages}
        total={page.total}
        params={search}
        unit="people"
      />
    </>
  );
};

export default ContactsPage;
