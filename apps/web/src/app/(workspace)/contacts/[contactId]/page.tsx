import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

import { Card, PageHeader, Panel, Table, Td, Th, Tr, Tag, buttonClass } from "@/components/ui";
import { nameOf, valueLabel } from "@/features/contacts/contacts.display";
import { readContactDetail } from "@/features/contacts/contacts.service";
import { refusedWith } from "@/lib/api/server";
import { duration, when } from "@/lib/format";

export const metadata: Metadata = { title: "Contact · Ansa" };
export const dynamic = "force-dynamic";

/**
 * One person: what they have told us, and every call they have made.
 *
 * The call list is the reason this page is worth opening rather than reading the row on the
 * list. Somebody rings back and the question is never "what is their name" — it is "what did
 * we say to them last time", and that is one click from here.
 */
const ContactPage = async ({
  params,
}: {
  readonly params: Promise<{ readonly contactId: string }>;
}) => {
  const { contactId } = await params;

  const detail = await readContactDetail(contactId).catch((error: unknown) => {
    // Another organisation's contact looks exactly like one that does not exist, which is
    // deliberate on the API side. Both are a 404 here too.
    if (refusedWith(error, 404)) return null;
    throw error;
  });
  if (detail === null) notFound();

  const { contact, calls } = detail;
  const collected = contact.values.filter((value) => value.fieldType !== "name");

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
          title="What they told us"
          description="Collected across every call, most recent answer winning. A value with no call behind it was typed in here."
        >
          {collected.length === 0 ? (
            <p className="text-[13px] text-[var(--ink-3)]">
              Nothing beyond their number yet. Values appear here as the agent confirms them.
            </p>
          ) : (
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              {collected.map((value) => (
                <div key={value.fieldKey}>
                  <dt className="text-[11.5px] tracking-[0.04em] text-[var(--ink-3)] uppercase">
                    {valueLabel(value.fieldKey)}
                  </dt>
                  <dd className="mt-1 text-[13.5px]">
                    {value.value}
                    {value.sourceCallId === null && (
                      <span className="ml-2 align-middle">
                        <Tag>entered by hand</Tag>
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Card>

        <Card
          title="Call history"
          description="Every call from this number, newest first — including the ones that collected nothing."
        >
          {calls.length === 0 ? (
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
                  {calls.map((call) => (
                    <Tr key={call.callId}>
                      <Td>
                        <Link
                          href={`/calls/${call.callId}`}
                          className="hover:text-[var(--accent)] hover:underline"
                        >
                          {when(call.calledAt)}
                        </Link>
                      </Td>
                      <Td className="text-[12.5px] text-[var(--ink-3)]">{call.direction}</Td>
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
      </div>
    </>
  );
};

export default ContactPage;
