import type { OrganizationId } from "@ansa/shared";

import type { Db } from "./data-source";
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
  /** Why this campaign rings. Said in the opening; without it there is nothing to say. */
  readonly purpose: string | null;
  /** The exact first line, or null to let the agent compose one from the purpose. */
  readonly opening: string | null;
  /** The conversation as a graph, in the same shape an agent's flow uses. */
  readonly flow: Record<string, unknown> | null;
  /** What counts as done, as names the agent picks from at the end. */
  readonly outcomes: readonly string[] | null;
  /** What to do when a machine answers. Null means hang up. */
  readonly voicemail: Record<string, unknown> | null;
  readonly maxAttempts: number;
  readonly retryAfterMinutes: number;
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
  cp.purpose, cp.opening, cp.flow, cp.outcomes, cp.voicemail,
  cp.max_attempts, cp.retry_after_minutes,
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
  purpose: row["purpose"] === null || row["purpose"] === undefined ? null : String(row["purpose"]),
  opening: row["opening"] === null || row["opening"] === undefined ? null : String(row["opening"]),
  flow: (row["flow"] ?? null) as Record<string, unknown> | null,
  outcomes: Array.isArray(row["outcomes"]) ? (row["outcomes"] as string[]).map(String) : null,
  voicemail: (row["voicemail"] ?? null) as Record<string, unknown> | null,
  /* Defaulted in the column, so a row written before 0065 still answers with the working
     figures rather than with NaN. */
  maxAttempts: Number(row["max_attempts"] ?? 3),
  retryAfterMinutes: Number(row["retry_after_minutes"] ?? 240),
  createdBy: row["created_by"] === null ? null : String(row["created_by"]),
  createdAt: new Date(String(row["created_at"])),
  updatedAt: new Date(String(row["updated_at"])),
  total: Number(row["total"]),
  pending: Number(row["pending"]),
  answered: Number(row["answered"]),
});

/**
 * The parts of a campaign that say what it is about.
 *
 * Separate from `CampaignEdit` because they are refused at different times: a name may be
 * corrected whenever, while the brief is fixed once calls can be in flight. Absent means leave
 * alone; null clears.
 */
export interface CampaignBriefEdit {
  readonly purpose?: string | null;
  readonly opening?: string | null;
  readonly flow?: Record<string, unknown> | null;
  readonly outcomes?: readonly string[] | null;
  readonly voicemail?: Record<string, unknown> | null;
  readonly maxAttempts?: number;
  readonly retryAfterMinutes?: number;
}

/**
 * Write the brief, and only while the campaign is still editable.
 *
 * The `status in ('draft','scheduled')` predicate is in the statement rather than in a check
 * above it, so the refusal is the database's and not a race: two operators, one pressing Start
 * and one pressing Save, cannot both win. A zero-row result means the campaign is running,
 * which the caller turns into a refusal that says so.
 */
export const updateCampaignBrief = async (
  scope: OrganizationScope,
  campaignId: string,
  brief: CampaignBriefEdit,
): Promise<CampaignSummary | null> => {
  const rows = await scope.mutate<Record<string, unknown>>(
    `update campaigns as cp
        set purpose             = case when $2 then $3 else cp.purpose end,
            opening             = case when $4 then $5 else cp.opening end,
            flow                = case when $6 then $7::jsonb else cp.flow end,
            outcomes            = case when $8 then $9::jsonb else cp.outcomes end,
            voicemail           = case when $10 then $11::jsonb else cp.voicemail end,
            max_attempts        = coalesce($12, cp.max_attempts),
            retry_after_minutes = coalesce($13, cp.retry_after_minutes),
            updated_at          = now()
      where cp.id = $1
        and cp.status in ('draft', 'scheduled')
      returning ${CAMPAIGN_COLUMNS}`,
    [
      campaignId,
      brief.purpose !== undefined,
      brief.purpose ?? null,
      brief.opening !== undefined,
      brief.opening ?? null,
      brief.flow !== undefined,
      brief.flow === undefined || brief.flow === null ? null : JSON.stringify(brief.flow),
      brief.outcomes !== undefined,
      brief.outcomes === undefined || brief.outcomes === null
        ? null
        : JSON.stringify(brief.outcomes),
      brief.voicemail !== undefined,
      brief.voicemail === undefined || brief.voicemail === null
        ? null
        : JSON.stringify(brief.voicemail),
      brief.maxAttempts ?? null,
      brief.retryAfterMinutes ?? null,
    ],
  );
  const row = rows[0];
  return row === undefined ? null : asCampaign(row);
};

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
  /** What differs about this person: {"when":"Tuesday at 2"}. Merged into what is said. */
  readonly facts: Readonly<Record<string, string>> | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const SCHEDULED_COLUMNS = `
  s.id, s.campaign_id, s.contact_id, ct.phone, ct.display_name, s.status, s.attempts,
  s.next_attempt_at, s.last_attempt_at, s.outcome, s.call_id, s.facts, s.created_at,
  s.updated_at`;

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
  facts: (row["facts"] ?? null) as Readonly<Record<string, string>> | null,
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
  /**
   * What differs about each person, keyed by contact id.
   *
   * A campaign is about one thing and still has to be specific: "your viewing at 14 Adeola
   * Odeku on Tuesday". Passed as a map rather than parallel arrays so a caller cannot line
   * the wrong facts up against the wrong person, which is the failure that would put somebody
   * else's appointment in a stranger's ear.
   */
  facts: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
): Promise<number> => {
  if (contactIds.length === 0) return 0;
  /* Sent as one json object and looked up per row, so a hundred contacts is still one
     statement rather than a hundred. */
  const factsJson = JSON.stringify(facts);
  /* Each person's own captured values, merged under whatever the caller passed.
   *
   * A contact already carries what previous calls learned about them — the name they gave,
   * what they were looking for, which area. Those are exactly the things a campaign wants to
   * say back ("about the flat in {area}"), and they are already keyed by field name, so
   * `{area}` resolves without anybody typing it twice. The caller's own facts win where both
   * have a key: a campaign that says "your viewing on {when}" means the appointment's date,
   * not whatever `when` a call once captured.
   *
   * `display_name` arrives as `{name}`, which is the placeholder somebody reaches for first
   * and would otherwise be the one thing missing. */
  const rows = await scope.query<Record<string, unknown>>(
    `insert into scheduled_calls (organization_id, campaign_id, contact_id, next_attempt_at, facts)
     select cp.organization_id, cp.id, ct.id, $3,
            coalesce(
              (select jsonb_object_agg(v.field_key, v.value)
                 from contact_values v
                where v.contact_id = ct.id and v.value is not null and v.value <> ''),
              '{}'::jsonb
            )
            || case when ct.display_name is null then '{}'::jsonb
                    else jsonb_build_object('name', ct.display_name) end
            || coalesce($4::jsonb -> ct.id::text, '{}'::jsonb)
       from campaigns cp
       join contacts ct on ct.id = any($2::uuid[])
      where cp.id = $1
     on conflict (campaign_id, contact_id) do nothing
     returning id`,
    [campaignId, contactIds, firstAttemptAt, factsJson],
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
/**
 * A row ready to dial, with everything the dialler needs to decide about it.
 *
 * The campaign's own fields travel with it rather than being fetched per row: a sweep of
 * twenty would otherwise be twenty-one queries, and the window and the retry policy are the
 * two things it cannot dial without.
 */
export interface DueCall extends ScheduledCall {
  /**
   * The number to ring from: the one routed to this campaign's agent.
   *
   * Null when the agent has no number, which is a campaign that cannot dial — the caller ID
   * has to be a number the person can ring back, and a call from a number that goes nowhere is
   * the shape of a nuisance call whatever is said on it.
   */
  readonly fromNumber: string | null;
  readonly campaignPurpose: string | null;
  readonly campaignOpening: string | null;
  readonly campaignOutcomes: readonly string[] | null;
  readonly campaignFlow: Record<string, unknown> | null;
  readonly campaignVoicemail: Record<string, unknown> | null;
  readonly callingWindow: Record<string, unknown> | null;
  readonly maxAttempts: number;
  readonly retryAfterMinutes: number;
}

/**
 * Which organisations have a call waiting.
 *
 * Not organisation-scoped, and it cannot be: the question spans tenants by definition. It goes
 * through `app.organizations_with_due_calls`, a `security definer` function with a pinned
 * search path, exactly as the event sweeper's own cross-tenant claim does — and it returns ids
 * and nothing else, so the widest thing this can leak is which tenants are busy. The dialler
 * then opens a proper scope per organisation and reads the queue through the policies.
 */
/**
 * What a call in progress needs to know about why it was placed.
 *
 * One read, at the moment the media socket opens, joining the campaign to the queue row that
 * caused this call. Both ids arrive as stream parameters — outbound has no dialled number to
 * resolve them from — and both are checked here: a `scheduledCallId` that does not belong to
 * the `campaignId` returns nothing rather than the wrong person's details, which is the
 * mistake that would put somebody else's appointment in a stranger's ear.
 *
 * Organisation-scoped like everything else, so a campaign id from another tenant finds no row
 * even though it arrived from outside on a socket.
 */
export interface CampaignCallBrief {
  readonly purpose: string;
  readonly opening: string | null;
  readonly outcomes: readonly string[];
  readonly facts: Readonly<Record<string, string>> | null;
  /**
   * The conversation this campaign drew, or null when it drew none.
   *
   * Read on the call rather than only saved: a campaign's graph that nothing drives is a
   * drawing somebody made and the agent ignores. Null is the common case and a legitimate
   * one — a campaign that only confirms something needs no script beyond its purpose.
   */
  readonly flow: Record<string, unknown> | null;
}

export const readCampaignCallBrief = async (
  scope: OrganizationScope,
  campaignId: string,
  scheduledCallId: string,
): Promise<CampaignCallBrief | null> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select cp.purpose, cp.opening, cp.outcomes, cp.flow, s.facts
       from scheduled_calls s
       join campaigns cp on cp.id = s.campaign_id
      where s.id = $1 and cp.id = $2`,
    [scheduledCallId, campaignId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const purpose = row["purpose"];
  /* A campaign cannot start without a purpose, so this is a row that changed underneath a
     call in flight. Null rather than an empty reason: the layer is not added at all, and the
     agent falls back to the safety layer alone rather than announcing a blank. */
  if (typeof purpose !== "string" || purpose.trim() === "") return null;
  return {
    purpose,
    opening: row["opening"] === null || row["opening"] === undefined ? null : String(row["opening"]),
    outcomes: Array.isArray(row["outcomes"]) ? (row["outcomes"] as string[]).map(String) : [],
    facts: (row["facts"] ?? null) as Readonly<Record<string, string>> | null,
    flow: (row["flow"] ?? null) as Record<string, unknown> | null,
  };
};

/**
 * Write the verdict the agent recorded onto the row that caused the call.
 *
 * Refused unless the outcome is one the campaign actually listed — the check is here rather
 * than in the tool, because the tool cannot know what this campaign asked for and a tool that
 * accepted any string would let a model invent a disposition. A number built from invented
 * dispositions is worse than no number.
 */
export const recordCallOutcome = async (
  scope: OrganizationScope,
  scheduledCallId: string,
  outcome: string,
  note: string | null,
): Promise<boolean> => {
  const rows = await scope.mutate<Record<string, unknown>>(
    `update scheduled_calls s
        set outcome = $2, updated_at = now()
       from campaigns cp
      where s.id = $1
        and cp.id = s.campaign_id
        and cp.outcomes @> to_jsonb($3::text)
      returning s.id`,
    [scheduledCallId, note === null ? outcome : `${outcome} — ${note}`, outcome],
  );
  return rows.length > 0;
};

export const organizationsWithDueCalls = async (
  dataSource: Db,
): Promise<readonly OrganizationId[]> => {
  const rows = (await dataSource.query(
    "select organization_id from app.organizations_with_due_calls()",
  )) as Record<string, unknown>[];
  return rows.map((row) => String(row["organization_id"]) as OrganizationId);
};

export const readDueScheduledCalls = async (
  scope: OrganizationScope,
  now: Date,
  limit: number,
): Promise<readonly DueCall[]> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select ${SCHEDULED_COLUMNS},
            cp.purpose as campaign_purpose, cp.opening as campaign_opening,
            cp.outcomes as campaign_outcomes, cp.flow as campaign_flow,
            cp.voicemail as campaign_voicemail, cp.calling_window,
            cp.max_attempts, cp.retry_after_minutes,
            (select r.number from organization_number_routing r
              where r.agent_id = cp.agent_id
              order by r.created_at
              limit 1) as from_number
       from scheduled_calls s
       join contacts ct on ct.id = s.contact_id
       join campaigns cp on cp.id = s.campaign_id
      where s.status = 'pending'
        and s.next_attempt_at is not null
        and s.next_attempt_at <= $1
        and cp.status = 'running'
        /* Nothing past its own ceiling is due. The dialler checks this too, and both are
           deliberate: this keeps a spent row out of every sweep, and that one is what
           decides whether a failed attempt earns another. */
        and s.attempts < cp.max_attempts
      order by s.next_attempt_at, s.id
      limit $2`,
    [now, limit],
  );
  return rows.map((row) => ({
    ...asScheduled(row),
    fromNumber: row["from_number"] == null ? null : String(row["from_number"]),
    campaignPurpose: row["campaign_purpose"] === null ? null : String(row["campaign_purpose"]),
    campaignOpening: row["campaign_opening"] === null ? null : String(row["campaign_opening"]),
    campaignOutcomes: Array.isArray(row["campaign_outcomes"])
      ? (row["campaign_outcomes"] as string[]).map(String)
      : null,
    campaignFlow: (row["campaign_flow"] ?? null) as Record<string, unknown> | null,
    campaignVoicemail: (row["campaign_voicemail"] ?? null) as Record<string, unknown> | null,
    callingWindow: (row["calling_window"] ?? null) as Record<string, unknown> | null,
    maxAttempts: Number(row["max_attempts"] ?? 3),
    retryAfterMinutes: Number(row["retry_after_minutes"] ?? 240),
  }));
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
