import type { OrganizationScope } from "./organization-scope";
import { pageOrder, pageParams, TOTAL_COLUMN, toSlice, type PageRequest, type PageSlice, type WithTotal }
  from "./paging";

/**
 * A list of people to ring, and the record of ringing them (0061).
 *
 * The shape is `agents.ts` again: every function takes an `OrganizationScope`, every insert
 * reads `app.current_organization()`, and RLS does the filtering. Nothing here dials. The
 * queue is a table, a scheduler in `apps/api` drains it, and between reading a row and
 * dialling it that scheduler must put the number through `mayCall` — `do_not_call`,
 * `outbound_consent`, the calling window — and write `suppressed` when it refuses. That
 * gate is deliberately not reproduced here, because there must be exactly one of it.
 */

/** `campaigns_status_check` is the enforcement; this exists so a caller cannot miss it. */
export type CampaignStatus = "draft" | "scheduled" | "running" | "paused" | "done";

/** `scheduled_calls_status_check` is the enforcement. */
export type ScheduledCallStatus =
  | "pending"
  | "placing"
  | "answered"
  | "no_answer"
  | "busy"
  | "voicemail"
  | "failed"
  | "suppressed";

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export interface ContactImport {
  readonly id: string;
  readonly sourceLabel: string;
  readonly rowCount: number;
  readonly importedAt: Date;
  readonly createdBy: string | null;
}

const asImport = (row: Record<string, unknown>): ContactImport => ({
  id: String(row["id"]),
  sourceLabel: String(row["source_label"]),
  rowCount: Number(row["row_count"]),
  importedAt: new Date(String(row["imported_at"])),
  createdBy: row["created_by"] === null ? null : String(row["created_by"]),
});

/**
 * Record one batch before its rows are added, so `addContacts` has an id to stamp on them.
 *
 * `rowCount` is what the operator uploaded, not what was new: a list of eighty where sixty
 * had already rung us is still an import of eighty, and the difference is visible from the
 * contacts themselves.
 */
export const recordContactImport = async (
  scope: OrganizationScope,
  input: { readonly sourceLabel: string; readonly rowCount: number; readonly createdBy: string | null },
): Promise<ContactImport> => {
  const rows = await scope.query<Record<string, unknown>>(
    `insert into contact_imports (organization_id, source_label, row_count, created_by)
     values (app.current_organization(), $1, $2, $3)
     returning id, source_label, row_count, imported_at, created_by`,
    [input.sourceLabel, input.rowCount, input.createdBy],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("Insert returned no row — the organization scope is wrong.");
  return asImport(row);
};



// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export interface Campaign {
  readonly id: string;
  readonly agentId: string;
  readonly name: string;
  readonly status: CampaignStatus;
  /** As the API layer shapes it. Null is the default window `mayCall` applies anyway. */
  readonly callingWindow: Record<string, unknown> | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A campaign with where it has got to, counted from `scheduled_calls`. */
export interface CampaignSummary extends Campaign {
  readonly total: number;
  readonly pending: number;
  readonly answered: number;
}

const CAMPAIGN_COLUMNS = `
  cp.id, cp.agent_id, cp.name, cp.status, cp.calling_window, cp.created_by,
  cp.created_at, cp.updated_at,
  (select count(*) from scheduled_calls s where s.campaign_id = cp.id)::int as total,
  (select count(*) from scheduled_calls s
    where s.campaign_id = cp.id and s.status = 'pending')::int as pending,
  (select count(*) from scheduled_calls s
    where s.campaign_id = cp.id and s.status = 'answered')::int as answered`;

const asCampaign = (row: Record<string, unknown>): CampaignSummary => ({
  id: String(row["id"]),
  agentId: String(row["agent_id"]),
  name: String(row["name"]),
  status: String(row["status"]) as CampaignStatus,
  callingWindow:
    row["calling_window"] === null ? null : (row["calling_window"] as Record<string, unknown>),
  createdBy: row["created_by"] === null ? null : String(row["created_by"]),
  createdAt: new Date(String(row["created_at"])),
  updatedAt: new Date(String(row["updated_at"])),
  total: Number(row["total"]),
  pending: Number(row["pending"]),
  answered: Number(row["answered"]),
});

export interface NewCampaign {
  readonly agentId: string;
  readonly name: string;
  readonly callingWindow?: Record<string, unknown> | null;
  readonly createdBy: string | null;
}

/** Starts as a draft with nobody on it. */
export const createCampaign = async (
  scope: OrganizationScope,
  input: NewCampaign,
): Promise<CampaignSummary> => {
  const rows = await scope.query<Record<string, unknown>>(
    `insert into campaigns (organization_id, agent_id, name, calling_window, created_by)
     values (app.current_organization(), $1, $2, $3, $4)
     returning id`,
    [
      input.agentId,
      input.name,
      input.callingWindow === undefined || input.callingWindow === null
        ? null
        : JSON.stringify(input.callingWindow),
      input.createdBy,
    ],
  );
  const created = rows[0];
  if (created === undefined) throw new Error("Insert returned no row — the organization scope is wrong.");
  const campaign = await readCampaign(scope, String(created["id"]));
  if (campaign === null) throw new Error("Campaign vanished between insert and read.");
  return campaign;
};

export const readCampaigns = async (
  scope: OrganizationScope,
  page: PageRequest,
): Promise<PageSlice<CampaignSummary>> => {
  const rows = await scope.query<Record<string, unknown> & WithTotal>(
    `select ${CAMPAIGN_COLUMNS}, ${TOTAL_COLUMN}
       from campaigns cp
      ${pageOrder("cp.created_at", "cp.id")}`,
    pageParams(page),
  );
  return toSlice(rows, asCampaign);
};

export const readCampaign = async (
  scope: OrganizationScope,
  campaignId: string,
): Promise<CampaignSummary | null> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select ${CAMPAIGN_COLUMNS} from campaigns cp where cp.id = $1`,
    [campaignId],
  );
  const row = rows[0];
  return row === undefined ? null : asCampaign(row);
};

export interface CampaignEdit {
  readonly name?: string;
  /** Null clears it back to the default window; undefined leaves it alone. */
  readonly callingWindow?: Record<string, unknown> | null;
}

export const updateCampaign = async (
  scope: OrganizationScope,
  campaignId: string,
  edit: CampaignEdit,
): Promise<boolean> => {
  const rows = await scope.mutate<Record<string, unknown>>(
    `update campaigns
        set name           = coalesce($2, name),
            calling_window = case when $3 then $4::jsonb else calling_window end
      where id = $1
      returning id`,
    [
      campaignId,
      edit.name ?? null,
      edit.callingWindow !== undefined,
      edit.callingWindow === undefined || edit.callingWindow === null
        ? null
        : JSON.stringify(edit.callingWindow),
    ],
  );
  return rows.length > 0;
};

/**
 * Move a campaign between states.
 *
 * Which transitions are legal — a draft cannot go straight to `done`, a finished campaign
 * cannot be resumed — is the API's rule and is checked there, where it can say why. This
 * records the decision.
 */
export const setCampaignStatus = async (
  scope: OrganizationScope,
  campaignId: string,
  status: CampaignStatus,
): Promise<boolean> => {
  const rows = await scope.mutate<Record<string, unknown>>(
    `update campaigns set status = $2 where id = $1 returning id`,
    [campaignId, status],
  );
  return rows.length > 0;
};

// ---------------------------------------------------------------------------
// Scheduled calls
// ---------------------------------------------------------------------------

export interface ScheduledCall {
  readonly id: string;
  readonly campaignId: string;
  readonly contactId: string;
  readonly phone: string;
  readonly displayName: string | null;
  readonly status: ScheduledCallStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly outcome: string | null;
  readonly callId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const SCHEDULED_COLUMNS = `
  s.id, s.campaign_id, s.contact_id, ct.phone, ct.display_name, s.status, s.attempts,
  s.next_attempt_at, s.last_attempt_at, s.outcome, s.call_id, s.created_at, s.updated_at`;

const asScheduled = (row: Record<string, unknown>): ScheduledCall => ({
  id: String(row["id"]),
  campaignId: String(row["campaign_id"]),
  contactId: String(row["contact_id"]),
  phone: String(row["phone"]),
  displayName: row["display_name"] === null ? null : String(row["display_name"]),
  status: String(row["status"]) as ScheduledCallStatus,
  attempts: Number(row["attempts"]),
  nextAttemptAt: row["next_attempt_at"] === null ? null : new Date(String(row["next_attempt_at"])),
  lastAttemptAt: row["last_attempt_at"] === null ? null : new Date(String(row["last_attempt_at"])),
  outcome: row["outcome"] === null ? null : String(row["outcome"]),
  callId: row["call_id"] === null ? null : String(row["call_id"]),
  createdAt: new Date(String(row["created_at"])),
  updatedAt: new Date(String(row["updated_at"])),
});

/**
 * Put people on a campaign.
 *
 * Returns how many were added. A contact already on this campaign is skipped rather than
 * refused — `scheduled_calls_campaign_id_contact_id_key` is what stops one person being
 * rung twice from one list, and enqueueing the same list twice should be a no-op, not an
 * error. The organisation id comes from the campaign row, so a contact id from another
 * organisation cannot be attached: RLS hides the contact and the join finds nothing.
 */
export const enqueueScheduledCalls = async (
  scope: OrganizationScope,
  campaignId: string,
  contactIds: readonly string[],
  firstAttemptAt: Date,
): Promise<number> => {
  if (contactIds.length === 0) return 0;
  const rows = await scope.query<Record<string, unknown>>(
    `insert into scheduled_calls (organization_id, campaign_id, contact_id, next_attempt_at)
     select cp.organization_id, cp.id, ct.id, $3
       from campaigns cp
       join contacts ct on ct.id = any($2::uuid[])
      where cp.id = $1
     on conflict (campaign_id, contact_id) do nothing
     returning id`,
    [campaignId, contactIds, firstAttemptAt],
  );
  return rows.length;
};

/** The list, with the person beside each row. */
export const readScheduledCalls = async (
  scope: OrganizationScope,
  campaignId: string,
  page: PageRequest,
): Promise<PageSlice<ScheduledCall>> => {
  const rows = await scope.query<Record<string, unknown> & WithTotal>(
    `select ${SCHEDULED_COLUMNS}, ${TOTAL_COLUMN}
       from scheduled_calls s
       join contacts ct on ct.id = s.contact_id
      where s.campaign_id = $1
      ${pageOrder("s.created_at", "s.id", 2)}`,
    [campaignId, ...pageParams(page)],
  );
  return toSlice(rows, asScheduled);
};

/**
 * What the scheduler should dial next.
 *
 * Only rows whose campaign is running: pausing a campaign must stop its calls without
 * touching a thousand rows, so the state lives on the campaign and the queue reads through
 * it. Oldest due first, so a number that has waited longest is not starved by a new batch.
 * Read inside the scheduler's transaction and claimed with `claimScheduledCall`; this alone
 * does not take a row.
 */
export const readDueScheduledCalls = async (
  scope: OrganizationScope,
  now: Date,
  limit: number,
): Promise<readonly ScheduledCall[]> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select ${SCHEDULED_COLUMNS}
       from scheduled_calls s
       join contacts ct on ct.id = s.contact_id
       join campaigns cp on cp.id = s.campaign_id
      where s.status = 'pending'
        and s.next_attempt_at is not null
        and s.next_attempt_at <= $1
        and cp.status = 'running'
      order by s.next_attempt_at, s.id
      limit $2`,
    [now, limit],
  );
  return rows.map(asScheduled);
};

/**
 * Take a row for dialling.
 *
 * `where status = 'pending'` is the whole point: two scheduler instances reading the same
 * due list both try this, and only the first sees a row change. False means somebody else
 * has it, and the caller moves on rather than dialling twice.
 */
export const claimScheduledCall = async (
  scope: OrganizationScope,
  scheduledCallId: string,
): Promise<boolean> => {
  const rows = await scope.mutate<Record<string, unknown>>(
    `update scheduled_calls
        set status = 'placing', attempts = attempts + 1, last_attempt_at = now()
      where id = $1 and status = 'pending'
      returning id`,
    [scheduledCallId],
  );
  return rows.length > 0;
};

export interface AttemptResult {
  readonly status: Exclude<ScheduledCallStatus, "placing">;
  readonly outcome?: string | null;
  /** The `calls` row, once the carrier created one. Null when it never got that far. */
  readonly callId?: string | null;
  /** When to try again. Null means never; a value puts the row back to `pending`. */
  readonly nextAttemptAt?: Date | null;
}

/**
 * Write down what an attempt came to.
 *
 * A retry is the same row put back to `pending` with a new `next_attempt_at`, which is why
 * `attempts` is counted on the claim and not here: the count is how many times it was
 * taken, whatever came of each. Passing a `nextAttemptAt` with a terminal status is a
 * contradiction, and the row is written as pending because the retry is the more specific
 * instruction — `status` then records only the reason for it in `outcome`.
 */
export const recordAttempt = async (
  scope: OrganizationScope,
  scheduledCallId: string,
  result: AttemptResult,
): Promise<boolean> => {
  const retry = result.nextAttemptAt !== undefined && result.nextAttemptAt !== null;
  const rows = await scope.mutate<Record<string, unknown>>(
    `update scheduled_calls
        set status          = $2,
            outcome         = coalesce($3, outcome),
            call_id         = coalesce($4::uuid, call_id),
            next_attempt_at = $5
      where id = $1
      returning id`,
    [
      scheduledCallId,
      retry ? "pending" : result.status,
      result.outcome ?? null,
      result.callId ?? null,
      result.nextAttemptAt ?? null,
    ],
  );
  return rows.length > 0;
};
