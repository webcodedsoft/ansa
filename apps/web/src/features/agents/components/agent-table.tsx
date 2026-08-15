import Link from "next/link";

import { Blip, Table, Tag, Td, Th } from "@/components/ui";
import { phone } from "@/lib/format";

/**
 * The agent list.
 *
 * One row today, and the row is real — the columns read the live configuration, the number
 * it answers on, and counts over this organisation's own calls. Nothing here invents a
 * second agent to make the table look fuller; `MultiAgentNotice` says why there is one, and
 * a table with one honest row is worth more than three fictional ones.
 */

export type AgentStatus =
  | { readonly kind: "answering" }
  | { readonly kind: "paused"; readonly reason: string }
  | { readonly kind: "scheduled"; readonly opensAtHour: number; readonly closesAtHour: number };

export interface AgentRow {
  readonly id: string;
  readonly name: string;
  /** One line under the name — the persona if there is one, else what is configured. */
  readonly summary: string;
  readonly answersOn: string | null;
  readonly status: AgentStatus;
  readonly calls7d: number;
  /** Share of those calls that ended cleanly. Null when there were none to divide by. */
  readonly resolved: number | null;
  readonly version: number;
}

/** 17 → "17:00". Business hours are stored as whole hours, so there are no minutes to lose. */
const onTheHour = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;

const StatusTag = ({ status }: { readonly status: AgentStatus }) => {
  switch (status.kind) {
    case "answering":
      return (
        <Tag tone="ok">
          <Blip pulse /> answering
        </Tag>
      );
    case "paused":
      return <Tag tone="warn">{status.reason}</Tag>;
    case "scheduled":
      return (
        <Tag>
          scheduled · {onTheHour(status.opensAtHour)}–{onTheHour(status.closesAtHour)}
        </Tag>
      );
  }
};

/**
 * Two letters from the name, and a colour that follows from the name too.
 *
 * Deterministic rather than random, so an agent keeps the same badge across reloads and
 * between people — a mark that changes on refresh is worse than no mark. The hues are the
 * theme's semantic colours used decoratively, which is safe here precisely because the
 * badge carries no meaning: status has a column of its own.
 */
const TINTS = ["accent", "warn", "ok"] as const;

const initials = (name: string): string => {
  const words = name.trim().split(/\s+/).filter((word) => word !== "");
  const first = words[0]?.[0] ?? "A";
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : (words[0]?.[1] ?? "");
  return `${first}${second}`.toUpperCase();
};

const Avatar = ({ name }: { readonly name: string }) => {
  let sum = 0;
  for (const character of name) sum += character.charCodeAt(0);
  const tint = TINTS[sum % TINTS.length] ?? "accent";
  return (
    <span
      aria-hidden
      className="grid size-[30px] flex-none place-items-center rounded-[9px] font-mono text-[11px] font-semibold shadow-[var(--spec)]"
      style={{ background: `var(--${tint}-soft)`, color: `var(--${tint})` }}
    >
      {initials(name)}
    </span>
  );
};

/** Whole percent. A rate to one decimal implies a precision forty calls do not have. */
const percent = (rate: number | null): string =>
  rate === null ? "—" : `${Math.round(rate * 100)}%`;

export const AgentTable = ({ agents }: { readonly agents: readonly AgentRow[] }) => (
  <div className="surface overflow-hidden rounded-[18px]">
    <Table>
      <thead>
        <tr>
          <Th>Agent</Th>
          <Th className="w-[190px]">Answers on</Th>
          <Th className="w-[210px]">Status</Th>
          <Th className="w-[104px] text-right">Calls, 7d</Th>
          <Th className="w-[104px] text-right">Resolved</Th>
          <Th className="w-[92px] text-right">Version</Th>
        </tr>
      </thead>
      <tbody>
        {agents.map((agent) => (
          <tr key={agent.id} className="transition-colors hover:bg-[var(--surface-2)]">
            <Td>
              {/* The name is the link, matching the calls table. A row-wide overlay
                  needs `position: relative` on a `<tr>`, which browsers disagree about. */}
              <Link href={`/agents/${agent.id}`} className="group flex items-center gap-3">
                <Avatar name={agent.name} />
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-semibold tracking-[-0.012em] group-hover:underline">
                    {agent.name}
                  </span>
                  <span className="block truncate text-[12px] text-[var(--ink-3)]">
                    {agent.summary}
                  </span>
                </span>
              </Link>
            </Td>
            <Td className="font-mono text-[13px] whitespace-nowrap">
              {agent.answersOn === null ? (
                <span className="text-[var(--ink-3)]">no number yet</span>
              ) : (
                phone(agent.answersOn)
              )}
            </Td>
            <Td>
              <StatusTag status={agent.status} />
            </Td>
            <Td className="text-right tabular-nums">{agent.calls7d}</Td>
            <Td className="text-right tabular-nums">{percent(agent.resolved)}</Td>
            <Td className="text-right font-mono text-[13px] tabular-nums text-[var(--ink-2)]">
              v{agent.version}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  </div>
);
