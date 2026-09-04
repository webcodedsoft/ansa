import Link from "next/link";

import { Blip, Tag } from "@/components/ui";
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
  // Letters and digits only: "Property enquiries (template)" should not badge as "P(".
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter((word) => word !== "");
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

/**
 * One card per agent.
 *
 * Cards rather than rows because an agent is a thing with a name and a character, not a
 * record with six columns — and because with one or three agents a table is mostly header.
 * The whole card is the link, the figures sit in a row along the bottom, and the number it
 * answers on reads as what it is: where callers reach it.
 */
export const AgentCards = ({ agents }: { readonly agents: readonly AgentRow[] }) => (
  <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
    {agents.map((agent) => (
      <Link
        key={agent.id}
        href={`/agents/${agent.id}`}
        className="surface group flex flex-col gap-3 rounded-xl border border-[var(--hairline)] p-4 transition-colors hover:border-[var(--ink-3)]"
      >
        <span className="flex items-start gap-3">
          <Avatar name={agent.name} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14.5px] font-semibold tracking-[-0.012em] group-hover:underline">
              {agent.name}
            </span>
            <span className="line-clamp-2 text-[12.5px] leading-snug text-[var(--ink-3)]">{agent.summary}</span>
          </span>
        </span>

        <span className="flex flex-wrap items-center gap-1.5">
          <StatusTag status={agent.status} />
          {/* The status tag already says "no number" when there is none; saying it twice
              would be the one thing on the card with no information in it. */}
          {agent.answersOn !== null && <span className="font-mono text-[12px] text-[var(--ink-2)]">{phone(agent.answersOn)}</span>}
        </span>

        <span className="mt-auto grid grid-cols-3 gap-2 border-t border-[var(--hairline)] pt-3">
          <Figure label="Calls, 7d" value={String(agent.calls7d)} />
          <Figure label="Resolved" value={percent(agent.resolved)} />
          <Figure label="Version" value={`v${agent.version}`} />
        </span>
      </Link>
    ))}
  </div>
);

const Figure = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <span className="min-w-0">
    <span className="block font-mono text-[9.5px] tracking-[0.12em] text-[var(--ink-3)] uppercase">{label}</span>
    <span className="block text-[14px] font-semibold tabular-nums">{value}</span>
  </span>
);
