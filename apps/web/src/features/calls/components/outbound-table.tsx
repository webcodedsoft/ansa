import { Notice, Table, Td, Th, Tr } from "@/components/ui";

import type { OutboundMetrics } from "../calls.service";
import { percent } from "../format";

/**
 * Whether the calls we placed are going well.
 *
 * A separate table from the quality one rather than four more rows on it, because these are
 * outbound-only and the others are computed over everything. Mixing them would give one table
 * two denominators and no way to tell which figure used which.
 *
 * Every rate here is null until there is something to divide by, and null renders as an em
 * dash rather than as 0%. A zero do-not-call rate and an unknown one are opposite readings —
 * the first is good news and the second is no news — and this is the table where that
 * distinction earns its keep.
 */

const seconds = (value: number | null): string => (value === null ? "—" : `${value}s`);

/**
 * The threshold at which the do-not-call rate stops being a number and becomes a problem.
 *
 * One in fifty is not a statistical judgement and is not meant to be: low enough that a
 * well-targeted list never reaches it, high enough that one annoyed caller on a quiet day
 * does not trip it. The point is that somebody is told. A rate that only ever appears in a
 * table is a rate nobody reads until the complaints arrive.
 */
const DO_NOT_CALL_ALARM = 0.02;

export const OutboundTable = ({ metrics }: { readonly metrics: OutboundMetrics }) => {
  if (metrics.calls === 0) {
    return (
      <Notice tone="ok">
        No outbound calls yet. These figures appear once this organisation has placed some.
      </Notice>
    );
  }

  const doNotCall = metrics.doNotCallRate === null ? null : Number(metrics.doNotCallRate);
  const alarming = doNotCall !== null && doNotCall >= DO_NOT_CALL_ALARM;

  return (
    <>
      {alarming && (
        <Notice tone="error" className="mb-3.5">
          {percent(metrics.doNotCallRate)} of these calls ended with somebody asking never to be
          called again. Each one is permanent and platform-wide, so the list or the script is
          spending numbers that cannot be recovered. Worth stopping to look at rather than
          watching.
        </Notice>
      )}

      <Table>
        <thead>
          <Tr>
            <Th>Measure</Th>
            <Th>Value</Th>
            <Th>Of what</Th>
          </Tr>
        </thead>
        <tbody>
          <Tr>
            <Td>Calls placed</Td>
            <Td>{metrics.calls}</Td>
            <Td className="text-[var(--ink-3)]">Outbound only</Td>
          </Tr>
          <Tr>
            <Td>Connected</Td>
            <Td>{percent(metrics.connectRate)}</Td>
            <Td className="text-[var(--ink-3)]">
              Reached somebody or something, rather than ringing out
            </Td>
          </Tr>
          <Tr>
            <Td>Reached a person</Td>
            <Td>{percent(metrics.humanAnswerRate)}</Td>
            {/* The denominator is shown rather than assumed. This is computed only over calls
                the carrier gave a verdict for, so a low count here means detection was off or
                unsure — not that the calls went badly. */}
            <Td className="text-[var(--ink-3)]">
              {metrics.answeredByKnown === 0
                ? "No carrier verdicts recorded"
                : `Of ${metrics.answeredByKnown} the carrier judged`}
            </Td>
          </Tr>
          <Tr>
            <Td>Asked not to be called</Td>
            <Td className={alarming ? "text-[var(--danger)]" : undefined}>
              {percent(metrics.doNotCallRate)}
            </Td>
            <Td className="text-[var(--ink-3)]">
              Counted once per call, however often they said it
            </Td>
          </Tr>
          <Tr>
            <Td>Time to hangup</Td>
            <Td>{seconds(metrics.medianSecondsToHangup)}</Td>
            {/* Median rather than mean, and said so: one four-minute call among fifty
                ten-second ones moves an average and tells you nothing about the fifty. */}
            <Td className="text-[var(--ink-3)]">Median across connected calls</Td>
          </Tr>
        </tbody>
      </Table>
    </>
  );
};
