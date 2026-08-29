import Link from "next/link";

import { Table, Tag, Td, Th, Tr } from "@/components/ui";

import { label, type AgentFieldHealth } from "../captures";

/**
 * How each of this agent's questions is doing, including the ones nobody answers.
 *
 * A field with nothing against it is the strongest signal on the page and the one the old
 * design could not produce: columns used to come from the values that existed, so a question
 * that never worked simply had no column and was invisible. Read from the form instead and it
 * sits here with a zero.
 *
 * In the agent's own order rather than ranked, so this table and the dataset below it line up
 * and a reader can move between them without re-finding the row.
 */

/** Past a third repeated, a prompt rather than a caller is the likely cause. */
const STRUGGLING = 0.34;

export const AgentFieldHealthTable = ({
  fields,
  agentId,
}: {
  readonly fields: readonly AgentFieldHealth[];
  /** Each row opens that one question. The list is the navigation. */
  readonly agentId: string;
}) => (
  <Table>
    <thead>
      <Tr>
        <Th>Question</Th>
        <Th className="w-[110px] text-right">Collected</Th>
        <Th className="w-[180px] text-right">Asked more than once</Th>
        <Th className="w-[140px] text-right">Worst case</Th>
      </Tr>
    </thead>
    <tbody>
      {fields.map((field) => {
        const share = field.count === 0 ? 0 : field.retried / field.count;
        return (
          <Tr key={field.key}>
            <Td className="font-medium">
              <Link
                href={`/data?agentId=${agentId}&field=${encodeURIComponent(field.key)}`}
                className="hover:text-[var(--accent)] hover:underline"
              >
                {label(field.key)}
              </Link>
              <span className="ml-1.5 font-mono text-[10.5px] font-normal text-[var(--ink-3)]">
                {field.type}
              </span>
              {field.retired && (
                <span className="ml-1.5 align-middle">
                  <Tag>retired</Tag>
                </span>
              )}
              {field.count === 0 && !field.retired && (
                <span className="ml-1.5 align-middle">
                  <Tag tone="bad">never answered</Tag>
                </span>
              )}
              {share >= STRUGGLING && (
                <span className="ml-1.5 align-middle">
                  <Tag tone="warn">rewrite the prompt</Tag>
                </span>
              )}
            </Td>
            <Td className="text-right tabular-nums">
              {field.count === 0 ? <span className="text-[var(--bad)]">0</span> : field.count}
            </Td>
            <Td className="text-right tabular-nums">
              {field.count === 0 || field.retried === 0 ? (
                <span className="text-[var(--ink-3)]">none</span>
              ) : (
                <>
                  {field.retried}
                  <span className="ml-1.5 text-[var(--ink-3)]">{Math.round(share * 100)}%</span>
                </>
              )}
            </Td>
            <Td className="text-right tabular-nums text-[var(--ink-3)]">
              {field.count === 0
                ? "—"
                : `${field.worstAttempts} ${field.worstAttempts === 1 ? "attempt" : "attempts"}`}
            </Td>
          </Tr>
        );
      })}
    </tbody>
  </Table>
);
