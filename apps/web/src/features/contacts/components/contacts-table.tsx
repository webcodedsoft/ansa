import Link from "next/link";

import { EmptyState, Panel, Table, Td, Th, Tr } from "@/components/ui";
import { when } from "@/lib/format";

import { nameOf } from "../contacts.display";
import type { ContactSummary } from "../contacts.service";

/**
 * Everyone who has called, one row each.
 *
 * The row is the person, not the call — which is the whole reason this page exists beside
 * Collected data. Somebody who rang three times is here once.
 *
 * What they told the agent is deliberately not here. Collected data already answers that,
 * one row per confirmed value and exportable; repeating three of them per person makes this
 * page a worse version of that one. This page answers who, and how often.
 */
export const ContactsTable = ({ people }: { readonly people: readonly ContactSummary[] }) => {
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

  return (
    <Panel>
      <Table>
        <thead>
          <Tr>
            <Th>Name</Th>
            <Th>Number</Th>
            <Th align="right">Calls</Th>
            <Th align="right">Last call</Th>
          </Tr>
        </thead>
        <tbody>
          {people.map((person) => (
            <Tr key={person.id}>
              <Td>
                <Link
                  href={`/contacts/${person.id}`}
                  className="font-medium hover:text-[var(--accent)] hover:underline"
                >
                  {nameOf(person)}
                </Link>
              </Td>
              <Td className="font-mono text-[12.5px]">{person.phone}</Td>
              <Td align="right" className="tabular-nums">
                {person.callCount}
              </Td>
              <Td align="right" className="text-[12.5px] text-[var(--ink-3)]">
                {person.lastCallAt === null ? "—" : when(person.lastCallAt)}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
};
