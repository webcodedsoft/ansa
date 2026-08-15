import { asCallId, asOrganizationId, type LogFields, type Logger } from "@ansa/shared";
import { describe, expect, it } from "vitest";

import { breakerKey, createCircuitBreaker } from "./breaker";
import { createToolDispatcher, type HoldContext, type HoldingSpeech } from "./dispatch";
import { createToolRegistry } from "./registry";
import type { ToolAdapter, ToolDefinition } from "./types";

const ORGANIZATION_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORGANIZATION_B = asOrganizationId("22222222-2222-4222-8222-222222222222");
const CALL = asCallId("call-1");

const silentLogger = (): Logger => {
  const make = (): Logger => ({
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    child: (_fields: LogFields) => make(),
  });
  return make();
};

const LOOKUP = (organizationId: ReturnType<typeof asOrganizationId>): ToolDefinition => ({
  name: "order_status",
  description: "Look up an order.",
  parameters: { type: "object" },
  organizationId,
  riskTier: "read",
  summarise: () => "That order is on its way.",
});

describe("the breaker itself", () => {
  it("opens after the threshold and closes again after the window", () => {
    let clock = 1_000;
    const breaker = createCircuitBreaker({ failureThreshold: 3, openMs: 5_000, now: () => clock });
    const key = breakerKey(ORGANIZATION_A, "order_status");

    expect(breaker.allows(key)).toBe(true);
    breaker.failed(key);
    breaker.failed(key);
    expect(breaker.allows(key)).toBe(true);
    breaker.failed(key);
    expect(breaker.allows(key)).toBe(false);

    clock += 4_999;
    expect(breaker.allows(key)).toBe(false);
    clock += 2;
    // Half open: one request goes through, and only one.
    expect(breaker.allows(key)).toBe(true);
    expect(breaker.allows(key)).toBe(false);
  });

  it("a failed probe keeps it open; a successful one closes it", () => {
    let clock = 0;
    const breaker = createCircuitBreaker({ failureThreshold: 1, openMs: 100, now: () => clock });
    const key = breakerKey(ORGANIZATION_A, "order_status");

    breaker.failed(key);
    expect(breaker.allows(key)).toBe(false);

    clock += 101;
    expect(breaker.allows(key)).toBe(true);
    breaker.failed(key);
    expect(breaker.allows(key)).toBe(false);

    clock += 101;
    expect(breaker.allows(key)).toBe(true);
    breaker.succeeded(key);
    expect(breaker.allows(key)).toBe(true);
    expect(breaker.allows(key)).toBe(true);
  });

  it("a run of successes does not accumulate towards opening", () => {
    const breaker = createCircuitBreaker({ failureThreshold: 2, openMs: 100 });
    const key = breakerKey(ORGANIZATION_A, "order_status");
    for (let index = 0; index < 20; index += 1) {
      breaker.failed(key);
      breaker.succeeded(key);
    }
    expect(breaker.allows(key)).toBe(true);
  });

  /** R5.2.3, stated as plainly as it can be tested. */
  it("keeps one organization's outage away from another organization, and one tool away from another", () => {
    const breaker = createCircuitBreaker({ failureThreshold: 2, openMs: 10_000 });
    const broken = breakerKey(ORGANIZATION_A, "order_status");

    breaker.failed(broken);
    breaker.failed(broken);

    expect(breaker.allows(broken)).toBe(false);
    expect(breaker.allows(breakerKey(ORGANIZATION_B, "order_status"))).toBe(true);
    expect(breaker.allows(breakerKey(ORGANIZATION_A, "business_hours"))).toBe(true);
  });
});

describe("the breaker in the dispatch path", () => {
  const setup = (options: { fails: boolean; breaker: ReturnType<typeof createCircuitBreaker> }) => {
    const attempts: string[] = [];
    const heard: string[] = [];
    const holding: HoldingSpeech = {
      start: (context: HoldContext) => heard.push(`start:${context.name}`),
      stop: () => undefined,
    };

    const adapter: ToolAdapter = {
      route: "http",
      execute: async (call) => {
        attempts.push(call.name);
        if (options.fails) throw new Error("connect ECONNREFUSED");
        return { state: "shipped" };
      },
    };

    const registry = createToolRegistry();
    registry.register(LOOKUP(ORGANIZATION_A), adapter);
    registry.register(LOOKUP(ORGANIZATION_B), adapter);

    return {
      attempts,
      heard,
      dispatcher: createToolDispatcher({
        registry,
        log: silentLogger(),
        holding,
        breaker: options.breaker,
        readRetries: 0,
      }),
    };
  };

  it("stops calling a tool that keeps failing, and says so instead of going quiet", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 2, openMs: 60_000 });
    const { attempts, heard, dispatcher } = setup({ fails: true, breaker });
    const call = { organizationId: ORGANIZATION_A, callId: CALL, name: "order_status", args: {} };

    expect(await dispatcher.dispatch(call)).toMatchObject({ kind: "failed", reason: "adapter-error" });
    expect(await dispatcher.dispatch(call)).toMatchObject({ kind: "failed", reason: "adapter-error" });

    const third = await dispatcher.dispatch(call);
    expect(third).toMatchObject({ kind: "failed", reason: "circuit-open" });
    expect(third.speech.length).toBeGreaterThan(0);

    // The endpoint was left alone, and no "let me pull that up" was played in front of an
    // apology that was already decided.
    expect(attempts).toHaveLength(2);
    expect(heard).toEqual(["start:order_status", "start:order_status"]);
  });

  it("a second organization's identical tool is unaffected", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, openMs: 60_000 });
    const failing = setup({ fails: true, breaker });
    const working = setup({ fails: false, breaker });

    await failing.dispatcher.dispatch({ organizationId: ORGANIZATION_A, callId: CALL, name: "order_status", args: {} });
    expect(
      await failing.dispatcher.dispatch({ organizationId: ORGANIZATION_A, callId: CALL, name: "order_status", args: {} }),
    ).toMatchObject({ reason: "circuit-open" });

    expect(
      await working.dispatcher.dispatch({ organizationId: ORGANIZATION_B, callId: CALL, name: "order_status", args: {} }),
    ).toMatchObject({ kind: "ok" });
  });
});

describe("retry", () => {
  const registryWith = (adapter: ToolAdapter) => {
    const registry = createToolRegistry();
    registry.register(LOOKUP(ORGANIZATION_A), adapter);
    registry.register(
      {
        name: "update_contact",
        description: "Change the number.",
        parameters: { type: "object" },
        organizationId: ORGANIZATION_A,
        riskTier: "write",
        readback: (args) => `Changing it to ${String(args.contactNumber)}. Should I go ahead?`,
        summarise: () => "Done.",
      },
      adapter,
    );
    return registry;
  };

  it("retries a read once and speaks the answer the second attempt returned", async () => {
    let attempts = 0;
    const registry = registryWith({
      route: "http",
      execute: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("socket hang up");
        return { state: "shipped" };
      },
    });

    const dispatcher = createToolDispatcher({ registry, log: silentLogger() });
    const outcome = await dispatcher.dispatch({
      organizationId: ORGANIZATION_A,
      callId: CALL,
      name: "order_status",
      args: {},
    });

    expect(outcome).toMatchObject({ kind: "ok", speech: "That order is on its way." });
    expect(attempts).toBe(2);
  });

  /**
   * A write that failed may still have been applied — the response is what was lost, not
   * necessarily the effect. Retrying it is how somebody's details get changed twice.
   */
  it("never retries a write", async () => {
    let attempts = 0;
    const registry = registryWith({
      route: "http",
      execute: async () => {
        attempts += 1;
        throw new Error("socket hang up");
      },
    });

    const dispatcher = createToolDispatcher({ registry, log: silentLogger() });
    const asked = await dispatcher.dispatch({
      organizationId: ORGANIZATION_A,
      callId: CALL,
      name: "update_contact",
      args: { contactNumber: "0803 000 0000" },
    });
    if (asked.kind !== "confirm") throw new Error("expected a readback");

    const done = await dispatcher.dispatch({
      organizationId: ORGANIZATION_A,
      callId: CALL,
      name: "update_contact",
      args: { contactNumber: "0803 000 0000" },
      confirmationId: asked.confirmationId,
    });

    expect(done).toMatchObject({ kind: "failed", reason: "adapter-error" });
    expect(attempts).toBe(1);
  });

  it("keeps every attempt inside the one ceiling rather than buying a second one", async () => {
    let attempts = 0;
    const registry = registryWith({
      route: "http",
      execute: async ({ signal }) =>
        new Promise((_resolve, reject) => {
          attempts += 1;
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });

    const started = Date.now();
    const dispatcher = createToolDispatcher({
      registry,
      log: silentLogger(),
      softTimeoutMs: 20,
      hardTimeoutMs: 60,
      readRetries: 3,
    });
    const outcome = await dispatcher.dispatch({
      organizationId: ORGANIZATION_A,
      callId: CALL,
      name: "order_status",
      args: {},
    });

    expect(outcome).toMatchObject({ kind: "failed", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(400);
    expect(attempts).toBe(1);
  });

  it("honours a organization's own tighter timeout", async () => {
    const registry = createToolRegistry();
    registry.register(
      { ...LOOKUP(ORGANIZATION_A), timeoutMs: 30 },
      { route: "http", execute: async () => new Promise(() => undefined) },
    );

    const started = Date.now();
    const outcome = await createToolDispatcher({
      registry,
      log: silentLogger(),
      softTimeoutMs: 20,
      hardTimeoutMs: 3_000,
    }).dispatch({ organizationId: ORGANIZATION_A, callId: CALL, name: "order_status", args: {} });

    expect(outcome).toMatchObject({ kind: "failed", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
