import { Table, Tag, Td, Th, Tr } from "@/components/ui";

import { label, type FieldSummary } from "../captures";

/**
 * Which fields the agent is struggling to collect.
 *
 * The dataset below answers "what did we get". This answers the question nobody could ask
 * before: which question is not working. `attempts` is recorded on every value and has never
 * been shown, and the migration that added it is explicit about why it is kept — a field
 * that regularly takes three goes is a field whose prompt needs rewriting.
 *
 * Ordered by how often a field had to be repeated rather than by name, because the row worth
 * reading is the one at the top and an alphabetical list buries it.
 */

/** Over a third repeated is the point where a prompt, not a caller, is the likely cause. */
const STRUGGLING = 0.34;

export const FieldHealth = ({ fields }: { readonly fields: readonly FieldSummary[] }) => (
  <Table>
    <thead>
      <Tr>
        <Th>Field</Th>
        <Th className="w-[120px] text-right">Collected</Th>
        <Th className="w-[190px] text-right">Asked more than once</Th>
        <Th className="w-[150px] text-right">Worst case</Th>
      </Tr>
    </thead>
    <tbody>
      {fields.map((field) => {
        const share = field.count === 0 ? 0 : field.retried / field.count;
        return (
          <Tr key={field.key}>
            <Td className="font-medium">
              {label(field.key)}
              {share >= STRUGGLING && (
                <span className="ml-2 align-middle">
                  <Tag tone="warn">rewrite the prompt</Tag>
                </span>
              )}
            </Td>
            <Td className="text-right tabular-nums">{field.count}</Td>
            <Td className="text-right tabular-nums">
              {field.retried === 0 ? (
                <span className="text-[var(--ink-3)]">none</span>
              ) : (
                <>
                  {field.retried}
                  <span className="ml-1.5 text-[var(--ink-3)]">
                    {Math.round(share * 100)}%
                  </span>
                </>
              )}
            </Td>
            <Td className="text-right tabular-nums text-[var(--ink-3)]">
              {field.worstAttempts} {field.worstAttempts === 1 ? "attempt" : "attempts"}
            </Td>
          </Tr>
        );
      })}
    </tbody>
  </Table>
);
