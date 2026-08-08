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
    if (sql.includes("tenant_for_number")) return rows.resolve ?? [{ id: null }];
    if (sql.includes("select id, name")) return rows.config ?? [];
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
    resolve: [{ id: TENANT }],
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
    // silently lose "policy", which fails on nearly every call without boosting.
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
    // Base first, so truncation costs the tenant's tail rather than "policy".
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
      dataSource: fakeDb({ resolve: [{ id: null }] }) as never,
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
