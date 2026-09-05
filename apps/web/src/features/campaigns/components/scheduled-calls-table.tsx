import { EmptyState, Notice, Panel, Table, Tag, Td, Th, Tr } from "@/components/ui";
import { phone as formatPhone, when } from "@/lib/format";

import { callStatusLabel, callTone } from "../campaigns.display";
import type { ScheduledCall } from "../campaigns.service";

/**
 * The calls scheduled under a campaign, one row per enqueued contact.
 *
 * `suppressed` is the row that needs explaining: it is not a call that failed but a call the
 * consent gate refused to place — a do-not-call entry, a rule against the time of day, or a
 * withdrawn consent. Code cannot be talked out of that gate and this table is where its
 * effect shows, so the legend states it plainly rather than leaving "suppressed" to be read
 * as an error.
 */
export const ScheduledCallsTable = ({ calls }: { readonly calls: readonly ScheduledCall[] }) => {
  if (calls.length === 0) {
    return (
      <Panel>
        <EmptyState title="Nobody on this campaign yet">
          Add contacts from the directory to schedule calls. Each one becomes a pending call,
          due immediately — the scheduler still checks consent and the calling window before it
          dials.
        </EmptyState>
      </Panel>
    );
  }

  const anySuppressed = calls.some((call) => call.status === "suppressed");

  return (
    <div className="flex flex-col gap-2.5">
      <div className="surface overflow-hidden rounded-xl">
        <Table>
          <thead>
            <Tr>
              <Th>Who</Th>
              <Th>Status</Th>
              <Th className="text-right">Attempts</Th>
              <Th className="text-right">Last attempt</Th>
              <Th className="text-right">Next attempt</Th>
            </Tr>
          </thead>
          <tbody>
            {calls.map((call) => (
              <Tr key={call.id}>
                <Td>
                  <span className="block text-[13.5px] font-medium">
                    {call.displayName ?? "Unnamed caller"}
                  </span>
                  <span className="block font-mono text-[11.5px] text-[var(--ink-3)]">
                    {formatPhone(call.phone)}
                  </span>
                </Td>
                <Td>
                  <Tag tone={callTone[call.status]}>{callStatusLabel[call.status]}</Tag>
                </Td>
                <Td className="text-right tabular-nums text-[var(--ink-2)]">{call.attempts}</Td>
                <Td className="text-right text-[12.5px] whitespace-nowrap text-[var(--ink-3)]">
                  {call.lastAttemptAt === null ? "—" : when(call.lastAttemptAt)}
                </Td>
                <Td className="text-right text-[12.5px] whitespace-nowrap text-[var(--ink-3)]">
                  {call.nextAttemptAt === null ? "—" : when(call.nextAttemptAt)}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>

      {anySuppressed && (
        <Notice tone="info">
          A suppressed row is a call the consent gate would not place — the number is on a
          do-not-call list, consent was withdrawn, or the rules bar calling it at this time.
          It is a block, not a failure, and no dial was attempted.
        </Notice>
      )}
    </div>
  );
};
