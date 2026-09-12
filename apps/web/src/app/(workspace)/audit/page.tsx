import { ScrollText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { Card, DataTable, PageHeader, Pagination, Tag, type Column } from "@/components/ui";
import { describeAudit, KIND_LABELS, kindLabelOf, subjectHref } from "@/features/audit/audit.display";
import { AUDIT_KINDS, listAudit, type AuditEntry, type AuditKind } from "@/features/audit/audit.service";
import { initials } from "@/features/org/invitations.display";
import { cn } from "@/lib/cn";
import { dayLabel, timeOfDay } from "@/lib/format";
import { readPaging } from "@/lib/paging";

export const metadata: Metadata = { title: "Audit log · Ansa" };
export const dynamic = "force-dynamic";

/**
 * Who did what, and when.
 *
 * Newest first, one sentence per row, the person who did it at the front. The filter is the
 * URL (`?kind=people`), like every other list. Rows from before the log existed were
 * backfilled from the tables that already knew — sessions, invitations, listens, publishes —
 * and carry no actor where the source never recorded one; the row says "Somebody" rather
 * than guessing.
 */
const isKind = (value: string | undefined): value is AuditKind => AUDIT_KINDS.includes(value as AuditKind);

const COLUMNS: readonly Column<AuditEntry>[] = [
  {
    key: "when",
    header: "When",
    width: "w-[150px]",
    className: "whitespace-nowrap text-[12.5px] text-[var(--ink-3)]",
    cell: (row) => (
      <>
        <span className="text-[var(--ink-2)]">{dayLabel(row.occurredAt)}</span>{" "}
        <span className="font-mono">{timeOfDay(row.occurredAt)}</span>
      </>
    ),
  },
  {
    key: "what",
    header: "What happened",
    cell: (row) => {
      const line = describeAudit(row);
      const href = subjectHref(row);
      return (
        <span className="flex items-start gap-3">
          <span
            aria-hidden
            className={cn(
              "grid size-[26px] flex-none place-items-center rounded-full border border-[var(--hairline)] bg-[var(--surface-2)] font-mono text-[10px] font-semibold",
              row.actorName === null ? "text-[var(--ink-3)]" : "text-[var(--ink-2)]",
            )}
          >
            {row.actorName === null ? "?" : initials(row.actorName, "")}
          </span>
          <span className="min-w-0 text-[13.5px] leading-[26px]">
            <span className="font-medium">{row.actorName ?? "Somebody"}</span> {line.text}
            {href !== null && (
              <>
                {" "}
                <Link href={href} className="text-[var(--accent)] hover:underline">
                  open
                </Link>
              </>
            )}
          </span>
        </span>
      );
    },
  },
  {
    key: "kind",
    header: "Kind",
    width: "w-[150px]",
    cell: (row) => <Tag tone={describeAudit(row).tone}>{kindLabelOf(row.action)}</Tag>,
  },
];

const AuditPage = async ({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly page?: string; readonly perPage?: string; readonly kind?: string }>;
}) => {
  const params = await searchParams;
  const paging = readPaging(params);
  const kind = isKind(params.kind) ? params.kind : null;
  const log = await listAudit(paging.page, paging.perPage, kind);

  return (
    <>
      <PageHeader
        eyebrow="Organisation"
        title="Audit log"
        meta="Who did what to this organisation — sign-ins, invitations, roles, publishes, recordings listened to, settings changed — and when."
      />

      <div className="mb-3.5 flex flex-wrap gap-1.5" role="group" aria-label="Kind of event">
        <Chip href="/audit" on={kind === null}>
          Everything
        </Chip>
        {AUDIT_KINDS.map((one) => (
          <Chip key={one} href={`/audit?kind=${one}`} on={kind === one}>
            {KIND_LABELS[one] ?? one}
          </Chip>
        ))}
      </div>

      <Card
        title={
          <span className="inline-flex items-center gap-2">
            <ScrollText aria-hidden className="size-4 text-[var(--ink-3)]" />
            {kind === null ? "Everything" : KIND_LABELS[kind]}
          </span>
        }
        bodyClassName="p-0"
        actions={
          <span className="text-[12px] text-[var(--ink-3)] tabular-nums">
            {log.total} {log.total === 1 ? "event" : "events"}
          </span>
        }
      >
        <DataTable
          rows={log.items}
          columns={COLUMNS}
          rowKey={(row) => row.id}
          empty={{ title: "Nothing here yet", description: "Acts on this organisation appear here as they happen." }}
        />
      </Card>

      <Pagination
        basePath="/audit"
        params={kind === null ? undefined : { kind }}
        page={log.page}
        perPage={log.perPage}
        totalPages={log.totalPages}
        total={log.total}
        unit="events"
      />
    </>
  );
};

const Chip = ({ href, on, children }: { readonly href: string; readonly on: boolean; readonly children: React.ReactNode }) => (
  <Link
    href={href}
    aria-current={on ? "page" : undefined}
    className={cn(
      "rounded-full border px-3 py-1 text-[12.5px] transition-colors",
      on
        ? "border-transparent bg-[var(--accent-soft)] font-medium text-[var(--accent)]"
        : "border-[var(--hairline)] text-[var(--ink-2)] hover:border-[var(--ink-3)]",
    )}
  >
    {children}
  </Link>
);

export default AuditPage;
