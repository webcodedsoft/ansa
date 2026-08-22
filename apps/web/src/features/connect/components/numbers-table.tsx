import { DataTable, Tag, type Column, type Tone } from "@/components/ui";

import type { NumberSummary } from "../connect.service";

type CarrierWebhookState = NumberSummary["carrierWebhook"]["state"];

const STATUS_TONE: Record<CarrierWebhookState, Tone> = {
  matches: "ok",
  "points-elsewhere": "bad",
  "not-set": "warn",
  "not-in-carrier-account": "warn",
  unchecked: "neutral",
};

const STATUS_LABEL: Record<CarrierWebhookState, string> = {
  matches: "matches",
  "points-elsewhere": "points elsewhere",
  "not-set": "not set",
  "not-in-carrier-account": "not in carrier account",
  unchecked: "unchecked",
};

/**
 * The organisation's numbers.
 *
 * There is no "label" or usage-volume field in `numbers.list()` — only the number itself,
 * its direction, who answers it, who manages it and the carrier's own record of where it
 * sends calls. Rather than invent a label or a call count the API does not report, this
 * shows exactly what came back and nothing else.
 */
const COLUMNS: readonly Column<NumberSummary>[] = [
  {
    key: "number",
    header: "Number",
    className: "font-mono text-[13px]",
    cell: (number) => number.number,
  },
  { key: "use", header: "Direction", cell: (number) => <Tag>{number.use}</Tag> },
  {
    key: "answeredBy",
    header: "Answers on",
    // A number with no agent is the state worth noticing on this screen: the import worked,
    // the carrier is pointed correctly, and every call to it still goes nowhere. Muted rather
    // than a warning tag because the gap is one click away on the agent's own page, and the
    // number arrives in this state by design rather than by anyone's mistake.
    cell: (number) =>
      number.answeredBy === null ? (
        <span className="text-[var(--ink-3)]">not routed</span>
      ) : (
        number.answeredBy.name
      ),
  },
  { key: "managedBy", header: "Managed by", cell: (number) => <Tag>{number.managedBy}</Tag> },
  {
    key: "webhook",
    header: "Carrier webhook",
    cell: (number) => {
      const webhook = number.carrierWebhook;
      const hasEndpoints = webhook.expected !== null || webhook.observed !== null;
      return (
        <div className="flex flex-col gap-1">
          <Tag tone={STATUS_TONE[webhook.state]}>{STATUS_LABEL[webhook.state]}</Tag>
          {webhook.reason !== null && (
            <span className="text-xs text-[var(--ink-3)]">{webhook.reason}</span>
          )}
          {hasEndpoints && (
            <span className="font-mono text-[11px] text-[var(--ink-3)]">
              expects {webhook.expected ?? "—"} · sees {webhook.observed ?? "—"}
            </span>
          )}
        </div>
      );
    },
  },
];

export const NumbersTable = ({ numbers }: { readonly numbers: readonly NumberSummary[] }) => (
  <DataTable
    rows={numbers}
    columns={COLUMNS}
    rowKey={(number) => number.number}
    empty={{
      title: "No numbers attached",
      description:
        "Point a number's voice webhook at the URL below and call it once. It attaches itself and appears here.",
    }}
  />
);
