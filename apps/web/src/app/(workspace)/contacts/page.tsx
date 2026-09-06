import { Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { Button, PageHeader, Pagination, Stat } from "@/components/ui";
import { CONTROL } from "@/components/ui";
import { currentPrincipal } from "@/features/auth/auth.service";
import { ContactsActions } from "@/features/contacts/components/contacts-actions";
import { ContactsDirectory } from "@/features/contacts/components/contacts-directory";
import { listContacts } from "@/features/contacts/contacts.service";
import { cn } from "@/lib/cn";
import { readPaging } from "@/lib/paging";

export const metadata: Metadata = { title: "Contacts · Ansa" };
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
        meta="Everyone who has called, and everyone you have called. A person is created on the first call that carries a number, and is identified once they tell you something."
      />

      <div className="grid gap-3.5 sm:grid-cols-4">
        <Stat label="People" value={stats.people} />
        <Stat
          label="Identified"
          value={stats.identified}
          trend={
            stats.people === 0 ? undefined : `${stats.people - stats.identified} told us nothing`
          }
        />
        <Stat
          label="Rang more than once"
          value={stats.repeatCallers}
          trend={
            stats.people === 0
              ? undefined
              : `${Math.round((stats.repeatCallers / stats.people) * 100)}% of everyone`
          }
        />
        <Stat label="New this week" value={stats.newThisWeek} trend="heard from for the first time" />
      </div>

      {/* A bar, not a card. The search is one control and wrapping it in a titled panel
          would announce it more loudly than the list it filters. */}
      <form method="get" className="mt-[26px] mb-3.5 flex items-center gap-2">
        <label className="relative flex min-w-0 flex-1 items-center">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 size-4 text-[var(--ink-3)]"
          />
          <span className="sr-only">Search contacts</span>
          <input
            type="search"
            name="q"
            defaultValue={search.q ?? ""}
            placeholder="A name, a number, or anything they told the agent"
            className={cn(CONTROL, "pl-9")}
          />
        </label>
        {/* Carried through the form so searching does not silently drop the filter. */}
        {everyone && <input type="hidden" name="who" value="everyone" />}
        <Button type="submit" variant="primary">
          Search
        </Button>
      </form>

      {/* Links rather than a toggle: the filter is in the URL like the search and the page, so
          a filtered list is one somebody can send to a colleague. */}
      <div className="mb-3.5 flex items-center gap-2 text-[12.5px]">
        <Link
          href={search.q === undefined || search.q === "" ? "/contacts" : `/contacts?q=${encodeURIComponent(search.q)}`}
          className={cn("rounded-full border px-2.5 py-1", everyone
            ? "border-[var(--hairline)] text-[var(--ink-3)] hover:border-[var(--ink-3)]"
            : "border-transparent bg-[var(--accent)] text-[var(--accent-on)]")}
        >
          Identified
        </Link>
        <Link
          href={`/contacts?who=everyone${search.q === undefined || search.q === "" ? "" : `&q=${encodeURIComponent(search.q)}`}`}
          className={cn("rounded-full border px-2.5 py-1", everyone
            ? "border-transparent bg-[var(--accent)] text-[var(--accent-on)]"
            : "border-[var(--hairline)] text-[var(--ink-3)] hover:border-[var(--ink-3)]")}
        >
          Everyone
        </Link>
      </div>

      <ContactsDirectory people={page.items} />

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
