import {
  type BusinessHours,
  type HandoffDestination,
  type Logger,
  type TenantId,
} from "@ansa/shared";
import { loadTenantById, loadTenantForNumber, type Db, type TenantConfig } from "@ansa/db";
import {
  CALL_CONTROL_DEFINITIONS,
  NO_CONNECTORS,
  NO_EVENTS,
  prepareConnectors,
  prepareEvents,
  type PreparedConnectors,
  type PreparedEvents,
} from "@ansa/tools";

import { composeSystemPrompt, DEFAULT_SYSTEM_PROMPT } from "../prompts/compose";
import { compileTenantLayer } from "../prompts/tenant-layer";

import { BASE_KEYTERMS, MAX_KEYTERMS } from "./defaults";

/** Configuration as the call path sees it, with defaults already applied. */
export interface CallTenant {
  /** null when the dialled number is not registered, or config could not be read. */
  readonly tenantId: TenantId | null;
  readonly name: string;
  /** Base vocabulary merged with the tenant's own (R4.1.3). */
  readonly keyterms: readonly string[];
  readonly voiceId: string | null;
  readonly greeting: string | null;
  readonly persona: string | null;
  readonly instructions: string | null;
  /**
   * The five-layer system prompt with this tenant's layer already in it.
   *
   * Composed here, once per config load, rather than per turn: the layers below the turn
   * budget do not change during a call, and the string is a couple of hundred tokens.
   * The turn layer is appended per turn by the orchestrator, which is how it works today
   * and is what proved the layering before the layering existed.
   */
  readonly systemPrompt: string;
  /** When their line is staffed, in WAT. Null until they configure it (R6.5). */
  readonly businessHours: BusinessHours | null;
  /**
   * Where this organisation's escalations go (R6.5). Null falls back to the platform's
   * own number, which is right for one tenant and wrong for two — see migration 0015.
   */
  readonly handoff: HandoffDestination | null;
  /**
   * This tenant's own tools, discovered and prepared once (R5.2).
   *
   * A function rather than a list because the registry is built per call: the platform
   * tools close over that call's own effects, so the tenant's tools have to join them
   * there. Everything expensive — parsing, the egress guard, the vault, an MCP handshake —
   * already happened when this configuration was loaded.
   */
  readonly connectors: PreparedConnectors;
  /**
   * Where this organisation wants a record of the call pushed, and what it wants masked
   * on the way (Slice 6a). Empty for every tenant until one configures a receiver.
   *
   * Prepared here beside the connectors because it needs the same three things — the
   * egress allowlist, the vault and the transport — and because resolving a signing secret
   * is not work to do while a call is ending.
   */
  readonly events: PreparedEvents;
  /** Recorded on every call so a call from weeks ago can still be explained (R7.5). */
  readonly configVersion: number;
}

/**
 * What the model is told it can reach.
 *
 * Derived from the registered definitions rather than written out here, so the prompt
 * cannot describe a tool the registry does not hold — the list in `@ansa/tools` is the
 * single source of both. The tenant's own tools are appended from what was actually
 * prepared, for the same reason: a tool whose MCP server was unreachable at config load is
 * not offered, rather than offered and then refused.
 */
const PLATFORM_TOOLS = CALL_CONTROL_DEFINITIONS.map((definition) => ({
  name: definition.name,
  description: definition.description,
  riskTier: definition.riskTier,
}));

/**
 * An unregistered number, and it keeps the empty tool list on purpose.
 *
 * `tenantId: null` disables tool dispatch outright, so a prompt listing tools here would
 * offer the model three things it would then be silently refused. The empty case tells it
 * the truth: on this call it cannot look anything up.
 */
export const UNKNOWN_TENANT: CallTenant = {
  tenantId: null,
  name: "unknown",
  keyterms: BASE_KEYTERMS,
  voiceId: null,
  greeting: null,
  persona: null,
  instructions: null,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  businessHours: null,
  handoff: null,
  connectors: NO_CONNECTORS,
  events: NO_EVENTS,
  configVersion: 0,
};

const mergeKeyterms = (
  tenant: readonly string[],
  log: Logger,
  tenantId: TenantId,
): readonly string[] => {
  // Base first: if the list has to be cut, the terms that fail on every call survive.
  const seen = new Map<string, string>();
  for (const term of [...BASE_KEYTERMS, ...tenant]) {
    const trimmed = term.trim();
    // Deepgram takes one keyterm per query parameter. A comma-joined value is accepted
    // and then silently ignored, which cost an afternoon to find — so a term containing
    // one is dropped loudly rather than sent.
    if (trimmed === "" || trimmed.includes(",")) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  }

  const merged = [...seen.values()];
  if (merged.length <= MAX_KEYTERMS) return merged;

  log.warn("keyterms truncated", {
    tenantId,
    requested: merged.length,
    cap: MAX_KEYTERMS,
    dropped: merged.slice(MAX_KEYTERMS),
  });
  return merged.slice(0, MAX_KEYTERMS);
};

/**
 * Config as stored, turned into config as the call path uses it.
 *
 * The prompt is composed here rather than at the call site for the same reason keyterms
 * are merged here: it is the one place that has the tenant's stored values, and doing it
 * anywhere else means doing it twice and getting it different the second time.
 *
 * A tenant's persona or instructions that try to weaken a §1 guarantee are dropped, and
 * the call proceeds on the remaining layers. Two deliberate choices in that sentence:
 *
 *   - dropped, not honoured. `compileTenantLayer` is the only way to produce the value
 *     `composeSystemPrompt` accepts, so this is not a check that could be forgotten at
 *     a call site — there is no other route in.
 *   - proceeds, not fails. A configuration problem must never become silence on the line
 *     (R6.2), and the guarantees hold in the dispatch paths regardless of what the prompt
 *     says, so the safe thing and the available thing are the same thing here.
 */
const toCallTenant = async (
  config: TenantConfig,
  log: Logger,
  credentialKey: Buffer | null,
): Promise<CallTenant> => {
  const { layer, violations } = compileTenantLayer({
    name: config.name,
    persona: config.persona,
    instructions: config.instructions,
  });

  if (violations.length > 0) {
    // Loud, and with the version, because the fix is a new config version rather than a
    // code change and whoever published it needs to know which one to correct.
    log.error("tenant config tried to weaken a guarantee; those fields were dropped", {
      tenantId: config.tenantId,
      configVersion: config.configVersion,
      violations,
    });
  }

  // Discovery and the MCP handshake happen here, once per configuration load, rather than
  // per call. `prepareConnectors` never throws: a tenant whose endpoint is unreachable
  // gets fewer tools, never a failed call (R6.2).
  const connectors = await prepareConnectors({
    tenantId: config.tenantId,
    config: config.toolConfig,
    credentialKey,
    sealedCredentials: config.sealedCredentials,
    log,
  });

  // Same treatment and the same promise as the connectors: never throws, and a tenant
  // whose event configuration is wrong gets no deliveries rather than a failed call.
  const events = await prepareEvents({
    tenantId: config.tenantId,
    config: config.eventConfig,
    credentialKey,
    sealedCredentials: config.sealedCredentials,
    log,
  });

  return {
    tenantId: config.tenantId,
    name: config.name,
    keyterms: mergeKeyterms(config.keyterms, log, config.tenantId),
    voiceId: config.voiceId,
    greeting: config.greeting,
    persona: config.persona,
    instructions: config.instructions,
    // The platform tools every registered tenant gets, plus this tenant's own. Both come
    // from what is actually registered, so the prompt cannot promise a lookup the
    // dispatcher would refuse.
    systemPrompt: composeSystemPrompt({
      tenant: layer,
      tools: [...PLATFORM_TOOLS, ...connectors.tools],
    }),
    businessHours: config.businessHours,
    handoff: config.handoff,
    connectors,
    events,
    configVersion: config.configVersion,
  };
};

interface Entry {
  readonly tenant: CallTenant;
  readonly expiresAt: number;
}

export interface TenantRegistryOptions {
  readonly dataSource: Db | null;
  readonly log: Logger;
  /** How long config is reused before it is read again. */
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** R5.2.1. Null disables every tenant tool that needs a credential; see `env.ts`. */
  readonly credentialKey?: Buffer | null;
}

/**
 * Resolves a dialled number to its tenant (R7.3) and caches the configuration.
 *
 * Two entry points on purpose:
 *
 *   resolve()  runs at the voice webhook, may hit the database, and is allowed to be slow.
 *   cached()   runs when the media socket opens and is synchronous.
 *
 * The split exists because the media socket is on the latency path and configuration is
 * not worth a database round trip there. Ingress warmed the cache moments earlier; if it
 * somehow did not, the call proceeds on defaults rather than waiting. Configuration
 * failing must never turn into silence on the line (R6.2).
 */
export const createTenantRegistry = (options: TenantRegistryOptions) => {
  const { dataSource, log } = options;
  const ttlMs = options.ttlMs ?? 600_000;
  const credentialKey = options.credentialKey ?? null;
  const now = options.now ?? Date.now;

  const byNumber = new Map<string, Entry>();
  const byTenant = new Map<string, Entry>();

  const remember = (dialled: string, tenant: CallTenant): CallTenant => {
    const entry = { tenant, expiresAt: now() + ttlMs };
    byNumber.set(dialled, entry);
    if (tenant.tenantId !== null) byTenant.set(tenant.tenantId, entry);
    return tenant;
  };

  const fresh = (entry: Entry | undefined): CallTenant | null =>
    entry !== undefined && entry.expiresAt > now() ? entry.tenant : null;

  return {
    resolve: async (dialled: string): Promise<CallTenant> => {
      const hit = fresh(byNumber.get(dialled));
      if (hit !== null) return hit;
      if (dataSource === null) return UNKNOWN_TENANT;

      try {
        const config = await loadTenantForNumber(dataSource, dialled);
        if (config === null) {
          log.warn("dialled number is not registered to a tenant", { dialled });
          return remember(dialled, UNKNOWN_TENANT);
        }
        return remember(dialled, await toCallTenant(config, log, credentialKey));
      } catch (error) {
        // A database that is down must cost the caller a personalised greeting, not the
        // call. Deliberately not cached: retry on the next call rather than serving
        // defaults to a configured tenant for a whole TTL.
        log.error("tenant lookup failed, answering on defaults", {
          dialled,
          error: error instanceof Error ? error.message : String(error),
        });
        return UNKNOWN_TENANT;
      }
    },

    /** Synchronous read for the media socket. Null means "use defaults, do not wait". */
    cached: (tenantId: string): CallTenant | null => fresh(byTenant.get(tenantId)),

    /**
     * Load configuration for a tenant we already know, warming the cache.
     *
     * Outbound calls need this and inbound ones do not. Inbound resolves at the voice
     * webhook, which warms the cache a moment before the media socket opens. Outbound
     * inlines its TwiML at origination, so there is no webhook and nothing has ever
     * looked this tenant up in this process — the id arrives on the socket already
     * known, with no configuration behind it.
     *
     * Found by the first outbound call: the tenant travelled out and back correctly and
     * the agent still answered on base vocabulary.
     */
    load: async (tenantId: TenantId): Promise<CallTenant | null> => {
      const hit = fresh(byTenant.get(tenantId));
      if (hit !== null) return hit;
      if (dataSource === null) return null;

      try {
        const config = await loadTenantById(dataSource, tenantId);
        if (config === null) {
          log.error("tenant id on the media socket has no config", { tenantId });
          return null;
        }

        const tenant = await toCallTenant(config, log, credentialKey);
        // Cached by id only: this call never had a dialled number to key on.
        byTenant.set(tenantId, { tenant, expiresAt: now() + ttlMs });
        return tenant;
      } catch (error) {
        log.error("could not load tenant config for an outbound call", {
          tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  };
};

export type TenantRegistry = ReturnType<typeof createTenantRegistry>;
