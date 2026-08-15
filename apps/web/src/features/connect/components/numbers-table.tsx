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
 * its direction, who manages it and the carrier's own record of where it sends calls. Rather
 * than invent a label or a call count the API does not report, this shows exactly what came
 * back and nothing else.
 */
const COLUMNS: readonly Column<NumberSummary>[] = [
  {
    key: "number",
    header: "Number",
    className: "font-mono text-[13px]",
    cell: (number) => number.number,
  },
  { key: "use", header: "Direction", cell: (number) => <Tag>{number.use}</Tag> },
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
        "Numbers are attached by an operator. Once one is pointed at this organisation it will appear here.",
    }}
  />
);
