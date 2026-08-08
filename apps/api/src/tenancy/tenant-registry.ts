import { type Logger, type TenantId } from "@ansa/shared";
import { loadTenantConfig, loadTenantForNumber, type Db } from "@ansa/db";


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
  /** Recorded on every call so a call from weeks ago can still be explained (R7.5). */
  readonly configVersion: number;
}

export const UNKNOWN_TENANT: CallTenant = {
  tenantId: null,
  name: "unknown",
  keyterms: BASE_KEYTERMS,
  voiceId: null,
  greeting: null,
  persona: null,
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
        const tenantId = config.tenantId;

        return remember(dialled, {
          tenantId,
          name: config.name,
          keyterms: mergeKeyterms(config.keyterms, log, tenantId),
          voiceId: config.voiceId,
          greeting: config.greeting,
          persona: config.persona,
          configVersion: config.configVersion,
        });
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
        const config = await loadTenantConfig(dataSource, tenantId);
        if (config === null) {
          log.error("tenant id on the media socket has no config", { tenantId });
          return null;
        }

        const tenant: CallTenant = {
          tenantId,
          name: config.name,
          keyterms: mergeKeyterms(config.keyterms, log, tenantId),
          voiceId: config.voiceId,
          greeting: config.greeting,
          persona: config.persona,
          configVersion: config.configVersion,
        };
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
