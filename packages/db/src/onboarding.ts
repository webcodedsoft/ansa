import type { BusinessHours } from "@ansa/shared";

import type { OrganizationScope } from "./organization-scope";

/**
 * Everything "is this organisation actually live?" is decided from, in one transaction.
 *
 * Deliberately not the same read as `organization-config.ts` next door, which answers "what has
 * this organisation configured" and is the dashboard's configuration screen. This answers a
 * different question and needs three things that one has no reason to hold: the raw `tools`
 * and `events` documents (readiness re-parses them exactly as config load does, because a
 * document that fails to parse is silently dropped on every call), the *names* in the
 * credential vault, and whether a call has ever arrived at all.
 *
 * That last one is the cheapest evidence in the product that step 1 of the onboarding
 * runbook was done. A organization provisioned with the carrier webhook forgotten looks perfect
 * in every column and has no rows in `calls`, forever.
 *
 * No `where` clause and no organization id anywhere, which is the point: under RLS each of these
 * tables shows exactly this organisation's rows, so the query that reads somebody else's is
 * not a query with a missing condition — it is unwritable.
 *
 * **Sealed credential values are never read here, only their reference names.** A name is
 * the organisation's own word for a secret and appears in their configuration; the
 * ciphertext beside it has no business being loaded to answer a yes/no question.
 */

export interface OnboardingFacts {
  readonly organisationName: string;
  /** The ingress routing key. Null means no caller can reach this organisation at all. */
  readonly dialledNumber: string | null;
  readonly greeting: string | null;
  readonly voiceId: string | null;
  /** All three columns or none, matching the CHECK constraint in migration 0012. */
  readonly businessHours: BusinessHours | null;
  readonly consentPolicy: string | null;
  readonly consentBasis: string | null;
  /** Both numbers or neither, matching the CHECK constraint in migration 0015. */
  readonly escalationConfigured: boolean;
  /**
   * Whether a distressed caller has somewhere to go outside business hours.
   *
   * Reported rather than defaulted. `docs/ansa-agent-prompt.md`: "make it a required field
   * during onboarding, not a default you fill in yourself. Getting this wrong is the
   * failure mode with the worst consequences."
   */
  readonly crisisHandoffConfigured: boolean;
  /** The `tool_config` document exactly as stored, for readiness to parse as config load does. */
  readonly toolConfig: unknown;
  /** The `event_config` document exactly as stored, same reason. */
  readonly eventConfig: unknown;
  /** Names only. Never the sealed values. */
  readonly credentialRefs: readonly string[];
  readonly configVersion: number;
  /** Every call the carrier has ever announced to us for this organisation. */
  readonly callsReceived: number;
  readonly lastCallAt: string | null;
  /** Deliveries this organisation's receivers gave up on. */
  readonly failedDeliveries: number;
  readonly pendingDeliveries: number;
  /**
   * The published graph and which director runs, for the readiness check that asks whether
   * the graph a call would walk still passes today's rules.
   *
   * `unknown` for the same reason it is everywhere else: the API owns the shape.
   */
  readonly flow: unknown;
  readonly authoringMode: "form" | "flow";
}

/**
 * `select *` rather than a column list, so a deployment that has not applied a migration
 * returns a row without those columns instead of failing the whole statement.
 *
 * Migration 0012 is the live example: `TASKS.md` records it as unapplied, and business
 * hours reading as "not configured" on such a deployment is exactly right — it is what the
 * call path does too.
 */
type OrganizationRow = Record<string, unknown>;

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const wholeNumberOrNull = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
};

/** Three columns or none. Two thirds of an opening-hours row cannot be reasoned about. */
const toBusinessHours = (row: OrganizationRow): BusinessHours | null => {
  const opens = wholeNumberOrNull(row["business_open_hour"]);
  const closes = wholeNumberOrNull(row["business_close_hour"]);
  const days = row["business_days"];
  if (opens === null || closes === null || !Array.isArray(days)) return null;
  return { opensAtHour: opens, closesAtHour: closes, openDays: days.map(Number) };
};

const toIsoOrNull = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value !== "") return new Date(value).toISOString();
  return null;
};

/**
 * Null when no organization row is visible in this scope, which through the dashboard cannot
 * happen — a session exists because the row that owns it does. Reported rather than
 * asserted, because the alternative is a null dereference in a health endpoint.
 */
export const loadOnboardingFacts = async (
  scope: OrganizationScope,
  agentId: string,
): Promise<OnboardingFacts | null> => {
  const organizations = await scope.query<OrganizationRow>("select * from organizations limit 1");
  const row = organizations[0];
  if (row === undefined) return null;

  /* Readiness mixes two scopes and always has. Credentials, consent and the event receivers
     belong to the organisation; the number a caller dials, the greeting they hear, the voice
     it is said in and the transfer target all belong to an agent — they moved to `agents` in
     migration 0018 and 0026 dropped the stale copies here.

     The agent is named now rather than resolved. It used to be the organisation's oldest live
     one, which made the report identical for every agent an organisation ran: a second agent
     with no number would have been reported ready because the first one had one.

     An id that names no live agent returns null, which reads as "not ready" — true for a
     brand-new organisation with no agent at all, and true for an archived one. */
  const agents = await scope.query<Record<string, unknown>>(
    `select greeting, voice_id, dialled_number, escalation_to_number, escalation_from_number,
            flow, authoring_mode
       from agents
      where id = $1 and deleted_at is null`,
    [agentId],
  );
  const agent = agents[0];
  if (agent === undefined) return null;

  const credentials = await scope.query<{ ref: string }>(
    "select ref from organization_credentials order by ref",
  );

  // `::int` because the driver hands a bigint back as a string, and a count compared with
  // `> 0` as a string is true for "0".
  /* This agent's traffic, not the organisation's. The check this feeds says "a number is
     attached and nothing has ever rung it", and answering that with another agent's calls is
     how a silent line reports as working.

     A call with no `agent_id` does not count, which is right going forward — `recordCall`
     has always written one — and mildly wrong for rows predating that. The cost is an
     organisation with only such rows being told its line has never rung, and the next real
     call corrects it. */
  const traffic = await scope.query<{ received: number; last_at: unknown }>(
    "select count(*)::int as received, max(created_at) as last_at from calls where agent_id = $1",
    [agentId],
  );

  const deliveries = await scope.query<{ failed: number; pending: number }>(
    `select (count(*) filter (where status = 'failed'))::int  as failed,
            (count(*) filter (where status = 'pending'))::int as pending
       from event_deliveries`,
  );

  return {
    organisationName: typeof row["name"] === "string" ? row["name"] : "",
    dialledNumber: textOrNull(agent["dialled_number"]),
    greeting: textOrNull(agent["greeting"]),
    voiceId: textOrNull(agent["voice_id"]),
    businessHours: toBusinessHours(row),
    consentPolicy: textOrNull(row["consent_policy"]),
    consentBasis: textOrNull(row["consent_basis"]),
    escalationConfigured:
      textOrNull(agent["escalation_to_number"]) !== null &&
      textOrNull(agent["escalation_from_number"]) !== null,
    /* The `from` is the ordinary escalation's, because a caller id is a property of the
       carrier account rather than of the reason for the transfer. Without one there is
       nothing to dial with, so this is false however the crisis number is set. */
    crisisHandoffConfigured:
      textOrNull(row["crisis_handoff_number"]) !== null &&
      textOrNull(agent["escalation_from_number"]) !== null,
    toolConfig: row["tool_config"] ?? null,
    eventConfig: row["event_config"] ?? null,
    credentialRefs: credentials.map((entry) => entry.ref),
    configVersion: wholeNumberOrNull(row["config_version"]) ?? 0,
    callsReceived: Number(traffic[0]?.received ?? 0),
    lastCallAt: toIsoOrNull(traffic[0]?.last_at),
    failedDeliveries: Number(deliveries[0]?.failed ?? 0),
    pendingDeliveries: Number(deliveries[0]?.pending ?? 0),
    flow: agent["flow"] ?? null,
    authoringMode: agent["authoring_mode"] === "flow" ? "flow" : "form",
  };
};
