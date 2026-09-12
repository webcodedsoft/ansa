import { Card, Table, Td, Th, Tr } from "@/components/ui";

import type { CallDetail } from "../calls.service";

/**
 * What the caller actually told the agent on this call.
 *
 * The transcript above already contains these words, and that is exactly why this panel
 * earns its place: reading a name out of a conversation is work, and an operator checking
 * whether a call collected what it was supposed to should not have to do it. The values
 * here are the ones the caller heard read back and agreed to — a candidate the agent
 * misheard never reaches this table.
 */

/**
 * The field key as a person would say it.
 *
 * Keys are written by operators in whatever style they like — `callerName`, `policy_number`,
 * `dob`. Splitting camel case and underscores covers all three without asking them to
 * maintain a second label, and an unrecognised key still reads better than it did.
 */
const label = (key: string): string => {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (spaced === "") return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
};

export const CollectedValues = ({ call }: { readonly call: CallDetail }) => {
  const captured = call.captured ?? [];

  /* Retries are the interesting number, so they are counted rather than listed per row:
     one field taking three goes is a prompt problem, and a total says that at a glance. */
  const retried = captured.filter((value) => value.attempts > 1).length;

  return (
    <Card
      title="Confirmed on this call"
      description={
        captured.length === 0
          ? undefined
          : `${captured.length} ${captured.length === 1 ? "value" : "values"}${
              retried === 0 ? "" : ` · ${retried} took more than one attempt`
            }`
      }
    >
      {captured.length === 0 ? (
        <p className="m-0 text-[12.5px] leading-relaxed text-[var(--ink-3)]">
          Nothing was read back and agreed on this call. A value lands here the moment the caller
          confirms one — a name, a number, an area — and not before.
        </p>
      ) : (
        <Table>
          <thead>
            <Tr>
              <Th>Field</Th>
              <Th>Value</Th>
              <Th className="text-right">Attempts</Th>
            </Tr>
          </thead>
          <tbody>
            {captured.map((value) => (
              <Tr key={value.fieldKey}>
                <Td className="text-[var(--ink-3)]">{label(value.fieldKey)}</Td>
                {/* Selectable and not truncated: somebody is going to copy a policy
                    number out of this, and a value cut off at the column edge is worse
                    than a wide column. */}
                <Td className="font-medium tabular-nums break-all">{value.value}</Td>
                <Td className="text-right tabular-nums text-[var(--ink-3)]">
                  {value.attempts}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
};
