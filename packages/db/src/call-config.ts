import {
  asAgentId,
  asOrganizationId,
  type AgentId,
  type BusinessHours,
  type HandoffDestination,
  type OrganizationId,
} from "@ansa/shared";
import type { Db } from "./data-source";

import { withOrganization } from "./organization-scope";

/**
 * The slice of organization configuration the call path needs.
 *
 * Deliberately small. R7.5's full config — escalation rules, business hours, registered
 * tools, knowledge base — lands with the slices that use it; adding columns nothing reads
 * would be pre-generalising.
 */
export interface AgentConfig {
  readonly organizationId: OrganizationId;
  /**
   * Which of the organisation's agents answered, since migration 0018.
   *
   * Null only against a database that has not been migrated — every row the three
   * `app.*_config_*` functions return now carries one. Recorded on the call so "which
   * agent said that?" stays answerable, which is the question `configVersion` exists for
   * and cannot answer on its own once a organization has two agents on version 3.
   */
  readonly agentId: AgentId | null;
  readonly name: string;
  /** Vocabulary the transcriber should expect: products, staff names, places (R4.1.3). */
  readonly keyterms: readonly string[];
  readonly voiceId: string | null;
  readonly speakingRate: number | null;
  readonly greeting: string | null;
  readonly persona: string | null;
  /**
   * The organization's own rules — hours, what to do when unsure, who to transfer to.
   *
   * Bounded free text that is layered ON the base prompt and can never replace it. What
   * "bounded" means is enforced in `apps/api/src/prompts/organization-layer.ts`, on the way
   * into the prompt rather than on the way into this column, so a row written by hand in
   * psql is filtered exactly like one written through onboarding.
   */
  readonly instructions: string | null;
  /**
   * When their own line is staffed, in WAT (R6.5). Null until they say.
   *
   * Null is the honest default and not a gap to be filled with a plausible nine to five:
   * the business-hours tool says it does not know, which is true, and an agent inventing
   * opening hours is the same failure as one answering from records nobody wrote.
   */
  readonly businessHours: BusinessHours | null;
  /**
   * Where this organisation's escalations are transferred (R6.5). Null until they say.
   *
   * Null falls back to the platform's own `HANDOFF_TO_NUMBER`, which is correct for a
   * deployment with one organization and wrong the moment there are two — see migration 0015.
   */
  readonly handoff: HandoffDestination | null;
  /**
   * The organization's own tools: endpoints, schemas, risk tiers (R5.2). Null until they
   * configure some, which is every organization today.
   *
   * Deliberately `unknown`. Its shape belongs to `@ansa/tools`, which validates it on the
   * way into the registry; parsing it here would put the same rules in two places and
   * point the dependency the wrong way.
   */
  readonly toolConfig: unknown;
  /**
   * Which of the shared registry's tools THIS agent may call (migration 0018).
   *
   * The registry is per organisation and the selection is per agent, so two agents can
   * share an endpoint's URL, risk tier and credential without sharing permission to call
   * it. Empty means no tools, never all of them: defaulting an empty selection to full
   * access would make creating an agent the most dangerous operation in the product.
   */
  readonly enabledTools: readonly string[];
  /**
   * The caller may cut the agent off mid-sentence (migration 0020).
   *
   * True for every agent unless somebody turns it off, because that is how a person
   * expects a phone call to work. Off is for the line that must finish a disclosure.
   */
  readonly bargeIn: boolean;
  /**
   * Hang up on an outbound call that reaches voicemail rather than talk to a greeting.
   *
   * Outbound only, and off by default: it costs a carrier feature and a second of answer
   * latency, and an inbound agent is answered by a person by definition.
   */
  readonly answeringMachineDetection: boolean;
  /**
   * The voice form this agent conducts, in the order it asks (migrations 0021, 0022).
   *
   * `unknown[]` on purpose, exactly as `toolConfig` is: the shape belongs to the code that
   * validates it, and parsing it here would put the same rules in two places and point the
   * dependency the wrong way.
   */
  readonly capturedFields: readonly unknown[];
  /**
   * Which of the organization's own systems get pushed a record of a call, and what is masked on
   * the way (Slice 6a, R5.2.4). Null until they configure some, which is every organization.
   *
   * `unknown` for the same reason `toolConfig` is: the shape belongs to `@ansa/tools`,
   * which validates it, and parsing it here would put the same rules in two places.
   */
  readonly eventConfig: unknown;
  /**
   * Sealed credential values by reference name (R5.2.1).
   *
   * Ciphertext, and this package cannot open it — the key is held by the API process. A
   * database dump therefore is not a credential leak, and neither is this map.
   */
  readonly sealedCredentials: ReadonlyMap<string, string>;
  /** Recorded on every call, so a call from three weeks ago can be explained (R7.5). */
  readonly configVersion: number;
}

/** The row shape the three `app.organization_config_*` functions all return. */
interface ConfigRow {
  id: string;
  /** Absent against a database without migration 0018 — see `AgentConfig.agentId`. */
  agent_id?: string | null;
  name: string;
  keyterms: string[] | null;
  voice_id: string | null;
  speaking_rate: number | null;
  greeting: string | null;
  persona: string | null;
  instructions: string | null;
  business_open_hour: number | null;
  business_close_hour: number | null;
  business_days: number[] | null;
  tool_config: unknown;
  enabled_tools?: string[] | null;
  /** Absent before migration 0020 — both default to the pipeline's existing behaviour. */
  barge_in?: boolean | null;
  amd_enabled?: boolean | null;
  captured_fields?: unknown[] | null;
  event_config: unknown;
  escalation_to_number: string | null;
  escalation_from_number: string | null;
  escalation_ring_seconds: number | null;
  credentials: Record<string, unknown> | null;
  config_version: number;
}

/**
 * Ciphertext only, and non-strings dropped.
 *
 * The column is jsonb, so the type system has nothing to say about what is in it. A value
 * that is not a string cannot be a sealed credential, and passing it on would surface as
 * a decryption error on a call rather than as a configuration mistake here.
 */
const toSealed = (row: ConfigRow): ReadonlyMap<string, string> => {
  const raw = row.credentials;
  if (raw == null) return new Map();
  const sealed = new Map<string, string>();
  for (const [ref, value] of Object.entries(raw)) {
    if (typeof value === "string") sealed.set(ref, value);
  }
  return sealed;
};

/**
 * Three columns or none. The CHECK constraint in migration 0012 already refuses two of
 * them, and this refuses them again — a database whose migration has not been applied
 * returns the row without these columns at all, and `undefined` must read as "not
 * configured" rather than as `NaN` opening hours.
 */
const toBusinessHours = (row: ConfigRow): BusinessHours | null => {
  const opens = row.business_open_hour;
  const closes = row.business_close_hour;
  const days = row.business_days;
  if (opens == null || closes == null || days == null) return null;
  return { opensAtHour: opens, closesAtHour: closes, openDays: days };
};

/**
 * Long enough for a phone in a pocket, short enough that the caller has not given up.
 * Duplicated from the environment path on purpose: a organization who set a destination and no
 * ring time gets the same answer as a deployment that set neither.
 */
const DEFAULT_RING_SECONDS = 25;

/**
 * Both numbers or neither, matching the CHECK constraint in 0015 and refusing again here.
 *
 * A database whose migration has not been applied returns the row without these columns at
 * all, and `undefined` has to read as "not configured" rather than as a transfer to
 * `undefined`.
 */
const toHandoff = (row: ConfigRow): HandoffDestination | null => {
  const to = row.escalation_to_number;
  const from = row.escalation_from_number;
  if (to == null || from == null) return null;
  return { to, from, ringSeconds: row.escalation_ring_seconds ?? DEFAULT_RING_SECONDS };
};

const toConfig = (row: ConfigRow): AgentConfig => ({
  organizationId: asOrganizationId(row.id),
  agentId: row.agent_id == null ? null : asAgentId(row.agent_id),
  name: row.name,
  keyterms: row.keyterms ?? [],
  voiceId: row.voice_id,
  speakingRate: row.speaking_rate ?? null,
  greeting: row.greeting,
  persona: row.persona,
  instructions: row.instructions ?? null,
  businessHours: toBusinessHours(row),
  handoff: toHandoff(row),
  // `undefined` when migration 0013 has not been applied — the row comes back without the
  // column at all — and that has to read as "no tools configured" rather than reaching
  // the parser as a value.
  toolConfig: row.tool_config ?? null,
  // `undefined` before migration 0018, and that has to read as "no tools selected"
  // rather than as every tool in the registry.
  enabledTools: row.enabled_tools ?? [],
  // `?? true` is the pre-0020 behaviour, not an opinion: barge-in has always been on, so a
  // database without the column must keep behaving the way it did yesterday.
  bargeIn: row.barge_in ?? true,
  answeringMachineDetection: row.amd_enabled ?? false,
  // Absent before migration 0022, and an agent with no form is the correct reading of that.
  capturedFields: row.captured_fields ?? [],
  eventConfig: row.event_config ?? null,
  sealedCredentials: toSealed(row),
  configVersion: row.config_version,
});



/**
 * Resolution and configuration in one round trip (R7.3).
 *
 * The two-step version cost two seconds on the answer path, because loading the config
 * under RLS means opening a transaction to set the organization context — six round trips to
 * a remote database before the carrier gets its TwiML. See migration 0004.
 */
export const loadAgentForNumber = async (
  dataSource: Db,
  dialledNumber: string,
): Promise<AgentConfig | null> => {
  const rows = (await dataSource.query("select * from app.agent_config_for_number($1)", [
    dialledNumber,
  ])) as ConfigRow[];

  const row = rows[0];
  return row === undefined ? null : toConfig(row);
};

/**
 * Configuration for a organization we already hold the id of, in one round trip.
 *
 * The counterpart to loadAgentForNumber, and it exists for the same reason: the RLS
 * path opens a transaction to set the organization context, which is six round trips and was
 * measured at 1.74 seconds on the media socket. See migration 0005.
 */
export const loadAgentForOrganization = async (
  dataSource: Db,
  organizationId: OrganizationId,
): Promise<AgentConfig | null> => {
  const rows = (await dataSource.query("select * from app.agent_config_for_organization($1)", [
    organizationId,
  ])) as ConfigRow[];

  const row = rows[0];
  return row === undefined ? null : toConfig(row);
};

/*
 * Reading an OLD config version back — `app.organization_config_at_version(organization, version)`,
 * added by migration 0011 — deliberately has no function here yet.
 *
 * `calls.config_version` has been recorded on every call since Slice 2 and has never been
 * readable back: the version was a number pointing at nothing, because `organizations` only
 * held the current values. 0011 gives it something to point at. Nothing in the API reads
 * it yet, and an export nothing calls fails `pnpm lint` for good reasons, so the audit
 * path is `tools/organization/config.mjs show <version>` until the call viewer wants it — at
 * which point this is a six-line function over the same SECURITY INVOKER function.
 */

/** The evidence the consent policy needs. Reading only; the verdict is not ours to make. */
export interface ConsentRecord {
  readonly grantedAt: Date;
  readonly revokedAt: Date | null;
}

/**
 * Consent and suppression for one organization and one number.
 *
 * Runs inside the organization's own scope under RLS, so a organization cannot read another's consent
 * records — and cannot borrow them either, which is the more interesting failure.
 * Suppression deliberately includes global rows: someone who asks not to be called should
 * not have to ask each organization separately.
 */
export const loadConsentFacts = async (
  dataSource: Db,
  organizationId: OrganizationId,
  phoneNumber: string,
): Promise<{ consent: ConsentRecord | null; suppressed: boolean }> =>
  withOrganization(dataSource, organizationId, async (scope) => {
    const consents = await scope.query<{ granted_at: Date; revoked_at: Date | null }>(
      `select granted_at, revoked_at from outbound_consent
        where organization_id = $1 and phone_number = $2
        order by granted_at desc limit 1`,
      [organizationId, phoneNumber],
    );
    const suppressions = await scope.query<{ n: string }>(
      `select count(*) as n from do_not_call
        where phone_number = $1 and (organization_id = $2 or organization_id is null)`,
      [phoneNumber, organizationId],
    );

    const row = consents[0];
    return {
      consent: row === undefined ? null : { grantedAt: row.granted_at, revokedAt: row.revoked_at },
      suppressed: Number(suppressions[0]?.n ?? 0) > 0,
    };
  });

export interface OutboundPolicy {
  readonly policy: string;
  readonly basis: string | null;
  readonly earliestHour: number | null;
  readonly latestHour: number | null;
}

/** The organisation's own consent settings, read inside its own scope. */
export const loadOutboundPolicy = async (
  dataSource: Db,
  organizationId: OrganizationId,
): Promise<OutboundPolicy | null> =>
  withOrganization(dataSource, organizationId, async (scope) => {
    const rows = await scope.query<{
      consent_policy: string;
      consent_basis: string | null;
      calling_earliest_hour: number | null;
      calling_latest_hour: number | null;
    }>(
      `select consent_policy, consent_basis, calling_earliest_hour, calling_latest_hour
         from organizations where id = $1`,
      [organizationId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      policy: row.consent_policy,
      basis: row.consent_basis,
      earliestHour: row.calling_earliest_hour,
      latestHour: row.calling_latest_hour,
    };
  });

