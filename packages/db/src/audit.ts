import { pageOrder, pageParams, toSlice, TOTAL_COLUMN, type PageRequest, type PageSlice, type WithTotal } from "./paging";
import type { OrganizationScope } from "./organization-scope";

/**
 * The audit log: one row per act of a person on the organisation (migration 0086).
 *
 * The actor's name and the subject's label are written down at the time rather than joined
 * later, because the people and things a log is about are the ones that have since been
 * removed. The API owns the action slugs; the console turns them into sentences.
 */

export const AUDIT_ACTIONS = [
  "signed_in",
  "signed_out",
  "password_changed",
  "account_closed",
  "member_invited",
  "invitation_accepted",
  "invitation_revoked",
  "member_role_changed",
  "member_removed",
  "access_revoked",
  "access_restored",
  "agent_created",
  "agent_retired",
  "agent_published",
  "agent_rolled_back",
  "recording_listened",
  "do_not_call_added",
  "organisation_renamed",
  "recording_turned_on",
  "recording_turned_off",
  "hours_changed",
  "credential_saved",
  "credential_removed",
  "webhooks_saved",
  "number_bought",
  "number_released",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditSubjectKind = "account" | "member" | "invitation" | "agent" | "call" | "contact" | "organisation" | "credential" | "number";

/** What is being read from the log: the buckets the console filters by. */
export const AUDIT_KINDS = ["people", "agents", "calls", "organisation", "security"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

const ACTIONS_OF_KIND: Readonly<Record<AuditKind, readonly AuditAction[]>> = {
  people: ["member_invited", "invitation_accepted", "invitation_revoked", "member_role_changed", "member_removed", "access_revoked", "access_restored"],
  agents: ["agent_created", "agent_retired", "agent_published", "agent_rolled_back"],
  calls: ["recording_listened", "do_not_call_added"],
  organisation: ["organisation_renamed", "recording_turned_on", "recording_turned_off", "hours_changed", "credential_saved", "credential_removed", "webhooks_saved", "number_bought", "number_released"],
  security: ["signed_in", "signed_out", "password_changed", "account_closed"],
};

export interface AuditEvent {
  readonly id: string;
  readonly occurredAt: string;
  /** Null when the act had no attributable person — a backfilled removal, a system sweep. */
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  readonly action: AuditAction;
  readonly subjectKind: AuditSubjectKind | null;
  readonly subjectId: string | null;
  readonly subjectLabel: string | null;
  /** Values as strings, whatever the action wrote, so one response shape covers every action. */
  readonly detail: Readonly<Record<string, string | null>>;
}

export interface NewAuditEvent {
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  readonly action: AuditAction;
  readonly subjectKind?: AuditSubjectKind;
  readonly subjectId?: string;
  readonly subjectLabel?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

interface AuditRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly actor_user_id: string | null;
  readonly actor_name: string | null;
  readonly action: AuditAction;
  readonly subject_kind: AuditSubjectKind | null;
  readonly subject_id: string | null;
  readonly subject_label: string | null;
  readonly detail: Record<string, unknown> | null;
}

/** Written inside the transaction that did the thing, so an act and its record land together or not at all. */
export const recordAuditEvent = async (scope: OrganizationScope, event: NewAuditEvent): Promise<void> => {
  await scope.query(
    `insert into audit_events
       (organization_id, actor_user_id, actor_name, action, subject_kind, subject_id, subject_label, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      scope.organizationId,
      event.actorUserId,
      event.actorName,
      event.action,
      event.subjectKind ?? null,
      event.subjectId ?? null,
      event.subjectLabel ?? null,
      JSON.stringify(event.detail ?? {}),
    ],
  );
};

export const listAuditEvents = async (
  scope: OrganizationScope,
  page: PageRequest,
  kind: AuditKind | null,
): Promise<PageSlice<AuditEvent>> => {
  const actions = kind === null ? null : [...ACTIONS_OF_KIND[kind]];
  const rows = await scope.query<AuditRow & WithTotal>(
    `select id, occurred_at, actor_user_id, actor_name, action, subject_kind, subject_id, subject_label, detail,
            ${TOTAL_COLUMN}
       from audit_events
      where ($3::text[] is null or action = any($3::text[]))
      ${pageOrder("occurred_at", "id", 1)}`,
    [...pageParams(page), actions],
  );
  return toSlice(rows, (row) => ({
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    action: row.action,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    subjectLabel: row.subject_label,
    detail: Object.fromEntries(
      Object.entries(row.detail ?? {}).map(([key, value]) => [key, value === null ? null : String(value)]),
    ),
  }));
};
