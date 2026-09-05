import { Search } from "lucide-react";
import type { Metadata } from "next";

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
    readonly page?: string;
    readonly perPage?: string;
  }>;
}) => {
  const search = await searchParams;
  const requested = readPaging(search);
  const [principal, { page, stats }] = await Promise.all([
    currentPrincipal(),
    listContacts(search.q, requested),
  ]);
  const canWrite = principal.capabilities.includes("contacts:write");

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Contacts"
        actions={canWrite ? <ContactsActions /> : undefined}
        meta="Everyone who has called, and every call they have made. A caller becomes a contact the first time they confirm something."
      />

      <div className="grid gap-3.5 sm:grid-cols-3">
        <Stat label="People" value={stats.people} />
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
        <Button type="submit" variant="primary">
          Search
        </Button>
      </form>

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
