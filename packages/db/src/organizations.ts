import { asOrganizationId, type BusinessHours, type OrganizationId } from "@ansa/shared";

import type { OrganizationScope } from "./organization-scope";

/**
 * The organisation itself — not its agents, and not its versioned configuration.
 *
 * Deliberately small, and it stays small for a while. An organisation owns what is true of
 * the company rather than of a conversation: what it is called, how long a caller's voice
 * is kept, and the legal basis on which it may place a call. Everything a caller
 * experiences belongs to an agent, and the two are separate documents rather than one with
 * defaults and overrides — see migration 0026 for why.
 *
 * Most of what is here is read-only to the organisation. That is the interesting part of
 * the shape, so it is written down rather than discovered through a failed write.
 */

export interface Organization {
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly createdAt: string;
  /**
   * How long stored call audio is kept, in days. Operator-set.
   *
   * An organisation shortening this quietly deletes evidence it may be asked for later, and
   * one lengthening it holds a caller's voice beyond the basis the consent was collected
   * under. Neither is a self-serve decision.
   */
  readonly audioRetentionDays: number;
  /**
   * How long the caller's *words* are kept — transcripts, call events and tool arguments.
   *
   * Separate from the audio because they outlive it on purpose: the review loop corrects
   * transcripts and the eval corpus is built from those corrections. See migration 0049.
   */
  readonly transcriptRetentionDays: number;
  /**
   * When this organisation counts as open. Null is "always open", which is a setting.
   *
   * On the organisation since migration 0053 rather than travelling through an agent's
   * publish, which is where it always lived in the database and never in a version.
   */
  readonly businessHours: BusinessHours | null;
  /**
   * Where a caller can be pointed in writing, and the company's website. Kept and shown;
   * the agent does not read either out (migration 0082 says why). Null until written.
   */
  readonly supportEmail: string | null;
  readonly website: string | null;
  /**
   * Whether calls are kept as audio (migration 0077). Off by default. When on, the agent
   * discloses it in its opening line — the disclosure is not a separate switch.
   */
  readonly recordCalls: boolean;
  /** Operator-set: the NDPR/NCC posture the outbound consent gate enforces. */
  readonly consent: {
    readonly policy: string;
    readonly basis: string | null;
    readonly callingEarliestHour: number | null;
    readonly callingLatestHour: number | null;
    /** Numbers on the do-not-call list this organisation's calls are checked against — its own and the global ones. */
    readonly doNotCallNumbers: number;
    /** Calls the consent gate refused to place this calendar month (WAT). */
    readonly suppressedThisMonth: number;
  };
}

interface OrganizationRow {
  id: string;
  name: string;
  created_at: Date | string;
  audio_retention_days: number;
  transcript_retention_days: number;
  business_open_hour: number | null;
  business_close_hour: number | null;
  business_days: number[] | null;
  business_closed_dates: string[] | null;
  support_email: string | null;
  website: string | null;
  record_calls: boolean;
  consent_policy: string;
  consent_basis: string | null;
  calling_earliest_hour: number | null;
  calling_latest_hour: number | null;
}

/** Postgres hands back `Date` for timestamptz; the API speaks ISO 8601 and nothing else. */
const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;

/** All three or none, matching the CHECK constraint in migration 0012. Null is always open. */
const toBusinessHours = (row: OrganizationRow): BusinessHours | null => {
  const opens = row.business_open_hour;
  const closes = row.business_close_hour;
  const days = row.business_days;
  if (opens == null || closes == null || days == null) return null;
  return {
    opensAtHour: opens,
    closesAtHour: closes,
    openDays: days,
    closedDates: row.business_closed_dates ?? [],
  };
};

/** The two consent counts are the organisation's, not one number's — hence here and not in `readConsentFacts`. */
interface ConsentCounts {
  readonly doNotCallNumbers: number;
  readonly suppressedThisMonth: number;
}

const toOrganization = (row: OrganizationRow, counts: ConsentCounts): Organization => ({
  organizationId: asOrganizationId(row.id),
  name: row.name,
  createdAt: iso(row.created_at),
  audioRetentionDays: row.audio_retention_days,
  transcriptRetentionDays: row.transcript_retention_days,
  recordCalls: row.record_calls === true,
  businessHours: toBusinessHours(row),
  supportEmail: row.support_email,
  website: row.website,
  consent: {
    policy: row.consent_policy,
    basis: row.consent_basis,
    callingEarliestHour: row.calling_earliest_hour,
    callingLatestHour: row.calling_latest_hour,
    doNotCallNumbers: counts.doNotCallNumbers,
    suppressedThisMonth: counts.suppressedThisMonth,
  },
});

/**
 * How many numbers the consent gate would refuse, and how many it has refused this month.
 *
 * Global do-not-call rows are counted alongside the organisation's own, as `readConsentFacts`
 * counts them: somebody who said "stop calling me" did not say it to one company. The month is
 * a WAT month, because that is the calendar the people reading the number are on.
 */
const readConsentCounts = async (scope: OrganizationScope): Promise<ConsentCounts> => {
  const rows = await scope.query<{ dnc: string; suppressed: string }>(
    `select (select count(*) from do_not_call
              where organization_id = app.current_organization() or organization_id is null) as dnc,
            (select count(*) from scheduled_calls
              where status = 'suppressed'
                and created_at >= date_trunc('month', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') as suppressed`,
  );
  return {
    doNotCallNumbers: Number(rows[0]?.dnc ?? 0),
    suppressedThisMonth: Number(rows[0]?.suppressed ?? 0),
  };
};

/**
 * The caller's own organisation.
 *
 * No `where id = …`, and there must not be one: the policy on `organizations` is
 * `id = app.current_organization()`, so this returns exactly one row inside a scope. A
 * predicate would not add safety — it would make it look as though the safety came from
 * the predicate.
 *
 * Null when the organisation was deleted out from under a live session.
 */
export const readOrganization = async (
  scope: OrganizationScope,
): Promise<Organization | null> => {
  const rows = await scope.query<OrganizationRow>(
    `select id, name, created_at, audio_retention_days, transcript_retention_days,
            business_open_hour, business_close_hour, business_days,
            business_closed_dates::text[] as business_closed_dates,
            support_email, website, record_calls,
            consent_policy, consent_basis, calling_earliest_hour, calling_latest_hour
       from organizations`,
  );
  const row = rows[0];
  if (row === undefined) return null;
  return toOrganization(row, await readConsentCounts(scope));
};

/** What an organisation may say about itself: its name, and where to write to it. */
export interface OrganizationDetails {
  readonly name: string;
  readonly supportEmail: string | null;
  readonly website: string | null;
}

/**
 * Rename it, and set where it can be written to.
 *
 * Cosmetic here and nowhere else: an agent's name is what it calls itself on a call, and
 * this is not that. They were the same string before migration 0018 and are not now, so
 * renaming the organisation leaves every agent saying exactly what it said before. The
 * email and website are kept for the people who run the company; no call reads them.
 */
export const renameOrganization = async (
  scope: OrganizationScope,
  details: OrganizationDetails,
): Promise<Organization | null> => {
  /* `mutate`, not `query`: an update with `returning` comes back as `[rows, affectedCount]`,
     so the check below was always false and a rename of a deleted organisation — where RLS
     and the soft-delete filter match nothing — reported success. The third instance of this
     exact mistake in this package, which is why there is now a test that refuses it. */
  const updated = await scope.mutate<{ id: string }>(
    `update organizations set name = $1, support_email = $2, website = $3
      where deleted_at is null returning id`,
    [details.name, details.supportEmail, details.website],
  );
  if (updated.length === 0) return null;
  return readOrganization(scope);
};

/**
 * Turn call recording on or off for this organisation.
 *
 * The switch is the organisation's, not an agent's: one company records or does not, and the
 * caller is told either way by whichever agent answers. Applied immediately — like hours,
 * there is no version for it to sit in — and the call path reads it through
 * `agent_config_for_number` on the next call, which is also where the disclosure is added to
 * the greeting. `mutate`, for the reason every other update here says.
 */
export const setRecordCalls = async (scope: OrganizationScope, on: boolean): Promise<boolean> => {
  const updated = await scope.mutate<{ id: string }>(
    `update organizations set record_calls = $1 where deleted_at is null returning id`,
    [on],
  );
  return updated.length > 0;
};

/**
 * Closing an organisation.
 *
 * Soft, and the columns to honour it have existed since migration 0032 with nothing able to
 * set them: `deleted_at` appeared nowhere in `apps/api` or `apps/web`, so four functions built
 * to respect it guarded a state no code path could produce. Reaching it needed an operator and
 * a psql prompt.
 *
 * What closing does, and it is worth being exact because the word invites the wrong
 * assumptions:
 *
 * - The organisation stops resolving at ingress. `app.organization_for_number` and
 *   `app.organization_for_claim_token` both filter on `deleted_at`, so a call to a number that
 *   still routes here is answered by nobody rather than by a closed account's agent.
 * - Every session ends. `app.credentials_for_email` and `organisations_for_user` stop
 *   returning it, so nobody signs back in — which is why the sessions are revoked here in the
 *   same transaction rather than left to expire.
 * - **The calls are untouched, deliberately.** Transcripts, recordings and the event log stay
 *   exactly as long as their retention windows say. Closing an account is not a way to make
 *   evidence disappear on demand, and the two clocks are separate on purpose.
 * - The numbers stay registered. `organization_numbers` still holds them so the carrier's
 *   record and ours agree; releasing one is an operator's act, because whoever is onboarded
 *   onto it next inherits whatever is left behind.
 */
export const closeOrganization = async (scope: OrganizationScope): Promise<boolean> => {
  const closed = await scope.mutate<{ id: string }>(
    "update organizations set deleted_at = now() where deleted_at is null returning id",
  );
  if (closed.length === 0) return false;

  /* Sessions last, and inside the same scope. A session outliving its organisation is a token
     that authenticates against a row every reader now hides, which is a confusing 500 rather
     than a clean 401. */
  await scope.mutate(
    "update sessions set revoked_at = now() where organization_id = $1 and revoked_at is null",
    [scope.organizationId],
  );
  return true;
};

/** One number this organisation holds, and which of its agents answers it. */
export interface HeldNumber {
  readonly number: string;
  /** Why the operator gave it to them, in their words. Null when they wrote nothing. */
  readonly note: string | null;
  /** Null when the number is held but routed to nobody, which is a real and visible state. */
  readonly agentId: string | null;
  readonly agentName: string | null;
  /** `holder`: their own line at their own carrier. `platform`: bought from the console (0087). */
  readonly managedBy: "holder" | "platform";
  readonly country: string | null;
  readonly monthlyPrice: string | null;
}

/**
 * Every number this organisation holds, from the table that holds them.
 *
 * `GET /numbers` used to answer this question by reading one agent's `dialled_number`, which
 * made an endpoint named for the organisation report a single agent's line — and report
 * nothing at all for a number the organisation holds but has not routed yet. That is the
 * state an operator most needs to see: the number is attached, and no agent answers it.
 *
 * Left joined on the agent rather than the other way round, so a held-but-unrouted number
 * appears with a null agent instead of vanishing.
 */
export const listHeldNumbers = async (scope: OrganizationScope): Promise<readonly HeldNumber[]> => {
  const rows = await scope.query<{
    number: string;
    note: string | null;
    managed_by: string;
    country: string | null;
    monthly_price: string | null;
    agent_id: string | null;
    agent_name: string | null;
  }>(
    `select n.number, n.note, n.managed_by, n.country, n.monthly_price, a.id as agent_id, a.name as agent_name
       from organization_numbers n
       left join agents a
         on a.dialled_number = n.number and a.deleted_at is null
      order by n.number`,
  );
  return rows.map((row) => ({
    number: row.number,
    note: row.note,
    agentId: row.agent_id,
    agentName: row.agent_name,
    managedBy: row.managed_by === "platform" ? "platform" : "holder",
    country: row.country,
    monthlyPrice: row.monthly_price,
  }));
};

/**
 * Record a number the platform just bought for this organisation (migration 0087).
 *
 * Through the definer function, because `ansa_app` cannot insert into the ownership table
 * directly and should not be able to: this is one of three narrow holes, and it can only
 * write a row for the organisation the scope is opened as. False when the number already
 * belongs to somebody else, which the caller must treat as "release it again".
 */
export const attachPurchasedNumber = async (
  scope: OrganizationScope,
  purchase: {
    readonly number: string;
    readonly carrierSid: string;
    readonly country: string;
    readonly monthlyPrice: string | null;
  },
): Promise<boolean> => {
  const rows = await scope.query<{ attached: boolean }>(
    `select app.attach_purchased_number($1, $2, $3, $4) as attached`,
    [purchase.number, purchase.carrierSid, purchase.country, purchase.monthlyPrice],
  );
  return rows[0]?.attached === true;
};

/**
 * Forget a platform-bought number, and un-route any agent that answered it.
 *
 * Returns the carrier's id so the caller can release it there too. Null when the number is
 * not this organisation's, or not one the platform bought.
 */
export const releasePurchasedNumber = async (scope: OrganizationScope, number: string): Promise<string | null> => {
  const rows = await scope.query<{ sid: string | null }>(`select app.release_purchased_number($1) as sid`, [number]);
  return rows[0]?.sid ?? null;
};

/**
 * The organisation's webhook claim token, generated by the caller.
 *
 * The value is made in the application from 32 random bytes rather than by a database default,
 * so the only place it is produced is a place that can use `node:crypto`. Rotating replaces it
 * and detaches nothing: a number already proved stays proved, and the organisation reconfigures
 * its carrier at its own pace.
 */
export const setClaimToken = async (scope: OrganizationScope, token: string): Promise<boolean> => {
  const changed = await scope.mutate<{ id: string }>(
    "update organizations set number_claim_token = $1 where deleted_at is null returning id",
    [token],
  );
  return changed.length > 0;
};

/** Null until one has been generated. Never logged — see migration 0054. */
export const readClaimToken = async (scope: OrganizationScope): Promise<string | null> => {
  const rows = await scope.query<{ number_claim_token: string | null }>(
    "select number_claim_token from organizations where deleted_at is null limit 1",
  );
  return rows[0]?.number_claim_token ?? null;
};
