import type { Metadata } from "next";

import { PageHeader, TextField } from "@/components/ui";
import { Button } from "@/components/ui";
import { listContacts } from "@/features/contacts/contacts.service";
import { ContactsTable } from "@/features/contacts/components/contacts-table";

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
 * The search is a URL, like the calls filter: `?q=Lekki` is the whole state, so a search is
 * a link somebody can send and the back button behaves.
 */
const ContactsPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly q?: string }>;
}) => {
  const { q } = await searchParams;
  const { items } = await listContacts(q);

  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Contacts"
        meta="Everyone who has called, with what they told the agent and every call they have made. A caller becomes a contact the first time they confirm something."
      />

      <form method="get" className="mb-3.5 flex items-end gap-2">
        <TextField
          label="Search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="A name, a number, or anything they said"
          hint="Matches the number, a corrected name, or any value collected."
          className="max-w-[420px] flex-1"
        />
        <Button type="submit" variant="primary">
          Search
        </Button>
      </form>

      <ContactsTable people={items} />
    </>
  );
};

export default ContactsPage;
