import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

import { Card, PageHeader, Pagination, Panel, Table, Td, Th, Tr, Tag, buttonClass } from "@/components/ui";
import { nameOf } from "@/features/contacts/contacts.display";
import { readContactDetail } from "@/features/contacts/contacts.service";
import { refusedWith } from "@/lib/api/server";
import { readPaging } from "@/lib/paging";
import { directionLabel, duration, when } from "@/lib/format";

export const metadata: Metadata = { title: "Contact · Ansa" };
export const dynamic = "force-dynamic";

/**
 * One person: what they have told us, and every call they have made.
 *
 * The call list is the reason this page is worth opening rather than reading the row on the
 * list. Somebody rings back and the question is never "what is their name" — it is "what did
 * we say to them last time", and that is one click from here.
 *
 * What they told the agent is not shown here either. It lives on Collected data, which is
 * built for it: every value, filterable, exportable. Two places rendering the same values is
 * two places to keep in step, and the one with the export wins.
 */
const ContactPage = async ({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly contactId: string }>;
  readonly searchParams: Promise<{ readonly page?: string; readonly perPage?: string }>;
}) => {
  const { contactId } = await params;
  const search = await searchParams;
  const requested = readPaging(search);

  const detail = await readContactDetail(contactId, requested).catch((error: unknown) => {
    // Another organisation's contact looks exactly like one that does not exist, which is
    // deliberate on the API side. Both are a 404 here too.
    if (refusedWith(error, 404)) return null;
    throw error;
  });
  if (detail === null) notFound();

  const { contact, calls } = detail;

  return (
    <>
      <PageHeader
        eyebrow="Contact"
        title={nameOf(contact)}
        meta={`${contact.phone} · ${contact.callCount} call${contact.callCount === 1 ? "" : "s"}${
          contact.firstCallAt === null ? "" : ` · first heard from ${when(contact.firstCallAt)}`
        }`}
        actions={
          <Link href="/contacts" className={buttonClass()}>
            All contacts
          </Link>
        }
      />

      <div className="flex flex-col gap-3.5">
        <Card
          title="Call history"
          description="Every call from this number, newest first — including the ones that collected nothing."
        >
          {calls.items.length === 0 ? (
            <p className="text-[13px] text-[var(--ink-3)]">No calls recorded against this number.</p>
          ) : (
            <Panel className="overflow-hidden">
              <Table>
                <thead>
                  <Tr>
                    <Th>When</Th>
                    <Th>Direction</Th>
                    <Th align="right">Length</Th>
                    <Th>Outcome</Th>
                  </Tr>
                </thead>
                <tbody>
                  {calls.items.map((call) => (
                    <Tr key={call.callId}>
                      <Td>
                        <Link
                          href={`/calls/${call.callId}`}
                          className="hover:text-[var(--accent)] hover:underline"
                        >
                          {when(call.calledAt)}
                        </Link>
                      </Td>
                      <Td className="text-[12.5px] text-[var(--ink-3)]">{directionLabel(call.direction)}</Td>
                      <Td align="right" className="tabular-nums">
                        {call.durationSeconds === null ? "—" : duration(call.durationSeconds)}
                      </Td>
                      <Td>
                        {call.endReason === null ? (
                          <span className="text-[var(--ink-3)]">—</span>
                        ) : (
                          <Tag>{call.endReason}</Tag>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Panel>
          )}
        </Card>

        {/* Outside the card, like every other list in the console, so the control that moves
            between pages is not inside the thing it is paging. */}
        <Pagination
          basePath={`/contacts/${contactId}`}
          page={calls.page}
          perPage={calls.perPage}
          totalPages={calls.totalPages}
          total={calls.total}
          params={search}
          unit="calls"
        />
      </div>
    </>
  );
};

export default ContactPage;
