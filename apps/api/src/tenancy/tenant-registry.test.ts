import { describe, expect, it, vi } from "vitest";

import { BASE_KEYTERMS, MAX_KEYTERMS } from "./defaults";
import { createTenantRegistry, UNKNOWN_TENANT } from "./tenant-registry";

const silentLog = () => {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  };
  return log;
};

/**
 * The registry talks to the database through two exported functions, so the seam under
 * test is `dataSource.query`. Shaping the fake around the SQL keeps the test honest
 * about which call is which.
 */
const fakeDb = (rows: { resolve?: unknown[]; config?: unknown[] }) => ({
  query: vi.fn(async (sql: string) => {
    // One round trip either way: by number at ingress (0004), by id for outbound,
    // which meets its tenant on the media socket and has no number to key on (0005).
    if (sql.includes("tenant_config_for_number")) return rows.config ?? [];
    if (sql.includes("tenant_config_for_id")) return rows.config ?? [];
    return [];
  }),
  // withTenant opens a transaction and sets app.tenant_id inside it, so the fake has
  // to honour that shape or the code under test never reaches its query.
  createQueryRunner: () => ({
    connect: async () => undefined,
    startTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    release: async () => undefined,
    isTransactionActive: true,
    manager: {},
    query: async (sql: string) => {
      if (sql.includes("select id, name")) return rows.config ?? [];
      return [];
    },
  }),
});

const TENANT = "11111111-1111-4111-8111-111111111111";

const configuredDb = (keyterms: string[]) =>
  fakeDb({
    config: [
      {
        id: TENANT,
        name: "Kano General",
        keyterms,
        voice_id: null,
        greeting: null,
        persona: null,
        config_version: 7,
      },
    ],
  });

describe("tenant registry", () => {
  it("merges tenant keyterms on top of the base rather than replacing it", async () => {
    const log = silentLog();
    const registry = createTenantRegistry({
      dataSource: configuredDb(["Ikeja", "motor cover"]) as never,
      log: log as never,
    });

    const tenant = await registry.resolve("+2348138178550");

    // The tenant's own terms are there...
    expect(tenant.keyterms).toContain("Ikeja");
    // ...and so is every base term. A tenant configuring their products must not
    // silently lose the platform's own vocabulary, which fails on nearly every call
    // without boosting.
    for (const base of BASE_KEYTERMS) expect(tenant.keyterms).toContain(base);
    expect(tenant.configVersion).toBe(7);
  });

  it("drops a keyterm containing a comma instead of sending it", async () => {
    const log = silentLog();
    const registry = createTenantRegistry({
      dataSource: configuredDb(["Ikeja,Yaba"]) as never,
      log: log as never,
    });

    // Deepgram accepts a comma-joined value and then ignores the whole thing silently.
    const tenant = await registry.resolve("+2348138178550");
    expect(tenant.keyterms).not.toContain("Ikeja,Yaba");
  });

  it("deduplicates case-insensitively so a tenant cannot waste the cap", async () => {
    const log = silentLog();
    const registry = createTenantRegistry({
      dataSource: configuredDb(["POLICY", "policy", "Policy"]) as never,
      log: log as never,
    });

    const tenant = await registry.resolve("+2348138178550");
    const policies = tenant.keyterms.filter((t) => t.toLowerCase() === "policy");
    expect(policies).toHaveLength(1);
  });

  it("caps the list, keeps the base terms, and says what it dropped", async () => {
    const log = silentLog();
    const many = Array.from({ length: MAX_KEYTERMS + 20 }, (_, i) => `term-${i}`);
    const registry = createTenantRegistry({
      dataSource: configuredDb(many) as never,
      log: log as never,
    });

    const tenant = await registry.resolve("+2348138178550");
    expect(tenant.keyterms).toHaveLength(MAX_KEYTERMS);
    // Base first, so truncation costs the tenant's tail rather than the platform's own.
    for (const base of BASE_KEYTERMS) expect(tenant.keyterms).toContain(base);
    // Silent truncation reads exactly like a transcriber that mishears the word.
    expect(log.warn).toHaveBeenCalledWith("keyterms truncated", expect.anything());
  });

  it("answers on defaults when the database is down, and does not cache that", async () => {
    const log = silentLog();
    const db = {
      query: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    };
    const registry = createTenantRegistry({ dataSource: db as never, log: log as never });

    expect(await registry.resolve("+2348138178550")).toEqual(UNKNOWN_TENANT);
    // Not cached: a configured tenant should not be served defaults for a whole TTL
    // because of one blip.
    await registry.resolve("+2348138178550");
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it("answers on defaults when no database is configured at all", async () => {
    const registry = createTenantRegistry({ dataSource: null, log: silentLog() as never });
    expect(await registry.resolve("+2348138178550")).toEqual(UNKNOWN_TENANT);
  });

  it("warns and uses defaults when the number is not registered", async () => {
    const log = silentLog();
    const registry = createTenantRegistry({
      dataSource: fakeDb({ config: [] }) as never,
      log: log as never,
    });

    const tenant = await registry.resolve("+15550000000");
    expect(tenant.tenantId).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      "dialled number is not registered to a tenant",
      expect.anything(),
    );
  });

  it("serves the media socket synchronously from what ingress cached", async () => {
    const log = silentLog();
    const db = configuredDb(["Ikeja"]);
    const registry = createTenantRegistry({ dataSource: db as never, log: log as never });

    // Nothing resolved yet: the socket must not block, it must fall back.
    expect(registry.cached(TENANT)).toBeNull();

    await registry.resolve("+2348138178550");
    expect(registry.cached(TENANT)?.name).toBe("Kano General");
  });

  it("re-reads configuration once the TTL expires", async () => {
    const log = silentLog();
    const db = configuredDb(["Ikeja"]);
    let clock = 1_000;
    const registry = createTenantRegistry({
      dataSource: db as never,
      log: log as never,
      ttlMs: 60_000,
      now: () => clock,
    });

    await registry.resolve("+2348138178550");
    await registry.resolve("+2348138178550");
    const afterCached = db.query.mock.calls.length;

    clock += 60_001;
    await registry.resolve("+2348138178550");
    expect(db.query.mock.calls.length).toBeGreaterThan(afterCached);
  });
});

describe("a call that never passed through ingress", () => {
  it("loads config by id, which is what outbound needs", async () => {
    // The first outbound call answered as "unknown" on base vocabulary: the tenant id
    // arrived on the media socket correctly, but nothing in this process had ever looked
    // it up, because outbound inlines its TwiML and never touches the voice webhook.
    const log = silentLog();
    const registry = createTenantRegistry({
      dataSource: configuredDb(["motor cover"]) as never,
      log: log as never,
    });

    expect(registry.cached(TENANT)).toBeNull();

    const loaded = await registry.load(TENANT as never);
    expect(loaded?.name).toBe("Kano General");
    expect(loaded?.keyterms).toContain("motor cover");
    // Warmed, so the rest of the call is a map read.
    expect(registry.cached(TENANT)?.name).toBe("Kano General");
  });

  it("carries the tenant's opening hours through to the call path", async () => {
    const log = silentLog();
    const registry = createTenantRegistry({
      dataSource: fakeDb({
        config: [
          {
            id: TENANT,
            name: "Kano General",
            keyterms: [],
            voice_id: null,
            greeting: null,
            persona: null,
            business_open_hour: 8,
            business_close_hour: 18,
            business_days: [1, 2, 3, 4, 5, 6],
            config_version: 9,
          },
        ],
      }) as never,
      log: log as never,
    });

    const tenant = await registry.resolve("+2348138178550");

    expect(tenant.businessHours).toEqual({
      opensAtHour: 8,
      closesAtHour: 18,
      openDays: [1, 2, 3, 4, 5, 6],
    });
  });

  /**
   * Migration 0012 has to be applied by hand as owner, exactly as 0003 did. Until it is,
   * the config function returns the row without these columns at all — and the tool has
   * to read that as "not configured" rather than as opening hours of NaN.
   */
  it("leaves the hours unset when the migration has not been applied", async () => {
    const log = silentLog();
    const registry = createTenantRegistry({
      dataSource: configuredDb([]) as never,
      log: log as never,
    });

    const tenant = await registry.resolve("+2348138178550");

    expect(tenant.businessHours).toBeNull();
  });

  it("tells a registered tenant's model which tools it has", async () => {
    const log = silentLog();
    const registry = createTenantRegistry({
      dataSource: configuredDb([]) as never,
      log: log as never,
    });

    const tenant = await registry.resolve("+2348138178550");

    for (const name of ["end_call", "transfer_to_human", "business_hours"]) {
      expect(tenant.systemPrompt).toContain(name);
    }
  });

  /**
   * `tenantId: null` disables dispatch outright, so listing tools here would offer the
   * model three things it would then be silently refused.
   */
  it("tells an unregistered number's model that it cannot look anything up", () => {
    expect(UNKNOWN_TENANT.systemPrompt).not.toContain("end_call");
    expect(UNKNOWN_TENANT.systemPrompt).toContain("can't look anything up");
  });

  it("answers on defaults rather than failing when the load does not work", async () => {
    const log = silentLog();
    const registry = createTenantRegistry({
      dataSource: { query: async () => { throw new Error("down"); } } as never,
      log: log as never,
    });

    // Configuration failing must never become silence on the line (R6.2).
    expect(await registry.load(TENANT as never)).toBeNull();
  });
});
