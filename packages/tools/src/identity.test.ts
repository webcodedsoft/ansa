import { asCallId, asTenantId, type LogFields, type Logger } from "@ansa/shared";
import { describe, expect, it } from "vitest";

import { createToolDispatcher, modelMessage, type IdentityGate } from "./dispatch";
import { createToolRegistry } from "./registry";
import type { ToolAdapter, ToolDefinition } from "./types";

/**
 * A lookup keyed on who the caller is, and the reason it is gated.
 *
 * The transcriber returns a stable wrong name for a Nigerian caller — six runs out of six
 * on 2026-08-08, the same wrong name each time. Nothing in this package fixes that. What
 * it can do is refuse to look somebody up by a value nobody has agreed to, because a
 * lookup on a misheard identifier does not fail: it confidently returns the wrong person,
 * and everything the agent says afterwards is about a stranger.
 *
 * Parameterised over unrelated values throughout — the gate keys on confirmation state,
 * never on any particular string.
 */

const TENANT = asTenantId("55555555-5555-4555-8555-555555555555");
const CALL = asCallId("call-identity");

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

const LOOKUP: ToolDefinition = {
  name: "account_lookup",
  description: "Look up the caller's account.",
  parameters: { type: "object" },
  tenantId: TENANT,
  riskTier: "read",
  identifiers: { reference: "policyNumber" },
  summarise: (result) => `Your account is ${String((result as { state: string }).state)}.`,
};

const gateWith = (confirmed: Readonly<Record<string, string>>): IdentityGate => ({
  confirmed: (fact) => confirmed[fact] ?? null,
});

const setup = (identity: IdentityGate | undefined, definition: ToolDefinition = LOOKUP) => {
  const seen: unknown[] = [];
  const adapter: ToolAdapter = {
    route: "http",
    execute: async (call) => {
      seen.push(call.args);
      return { state: "in good standing" };
    },
  };
  const registry = createToolRegistry();
  registry.register(definition, adapter);
  return {
    seen,
    dispatcher: createToolDispatcher({ registry, log: silentLogger(), identity, readRetries: 0 }),
  };
};

const run = (dispatcher: ReturnType<typeof setup>["dispatcher"], reference: unknown) =>
  dispatcher.dispatch({ tenantId: TENANT, callId: CALL, name: "account_lookup", args: { reference } });

describe("a tool that identifies a person", () => {
  /** Every one of these is a value the caller never agreed to. */
  const unconfirmed: readonly [string, Readonly<Record<string, string>>, unknown][] = [
    ["nothing is confirmed at all", {}, "AB-1234"],
    ["a different reference is confirmed", { policyNumber: "ZR/88/AA" }, "AB-1234"],
    ["a near miss on a long number", { policyNumber: "99200145" }, "99200146"],
    ["a transposition", { policyNumber: "AB-1234" }, "AB-1243"],
    ["a different name entirely", { policyNumber: "Adebayo" }, "Aditi"],
    ["a plausible mishearing", { policyNumber: "Chukwuemeka" }, "Chuck we America"],
    ["another fact is confirmed but not this one", { callerName: "Ngozi" }, "Ngozi"],
    ["the model passed a number instead of a string", { policyNumber: "1234" }, 1234],
    ["the model passed nothing", { policyNumber: "AB-1234" }, undefined],
    ["the model passed an empty string", { policyNumber: "AB-1234" }, ""],
  ];

  for (const [why, confirmed, supplied] of unconfirmed) {
    it(`refuses to run when ${why}`, async () => {
      const { seen, dispatcher } = setup(gateWith(confirmed));
      const outcome = await run(dispatcher, supplied);

      expect(outcome).toMatchObject({ kind: "failed", reason: "unconfirmed-identity" });
      expect(seen).toHaveLength(0);
      // And it is speech, not silence, and not an apology for a fault that did not happen.
      expect(outcome.speech.length).toBeGreaterThan(0);
    });
  }

  /** Confirmed, and written differently from how the model wrote it down. */
  const spellings: readonly [string, string][] = [
    ["AB-1234", "AB-1234"],
    ["AB-1234", "ab1234"],
    ["AB-1234", "AB 1234"],
    ["ZR/88/AA", "zr 88 aa"],
    ["0803 111 2222", "08031112222"],
    ["Adedeji Sikiru", "adedeji sikiru"],
    ["Ngozi Okonkwo-Bello", "Ngozi Okonkwo Bello"],
    ["99200145", "99200145"],
  ];

  for (const [confirmed, supplied] of spellings) {
    it(`runs when the caller confirmed ${confirmed} and the model wrote ${supplied}`, async () => {
      const { seen, dispatcher } = setup(gateWith({ policyNumber: confirmed }));
      const outcome = await run(dispatcher, supplied);

      expect(outcome).toMatchObject({ kind: "ok" });
      // Canonicalised to the value the caller actually agreed to, so the tenant's system
      // is queried with the confirmed spelling rather than the model's paraphrase of it.
      expect(seen[0]).toEqual({ reference: confirmed });
    });
  }

  it("refuses when there is no identity gate at all", async () => {
    const { seen, dispatcher } = setup(undefined);
    expect(await run(dispatcher, "AB-1234")).toMatchObject({
      kind: "failed",
      reason: "unconfirmed-identity",
    });
    expect(seen).toHaveLength(0);
  });

  it("refuses when the configured fact name is one the call does not know", async () => {
    // A typo in a tenant's configuration disables the tool rather than opening it.
    const { dispatcher } = setup(gateWith({ policyNumber: "AB-1234" }), {
      ...LOOKUP,
      identifiers: { reference: "polcyNumber" },
    });
    expect(await run(dispatcher, "AB-1234")).toMatchObject({ reason: "unconfirmed-identity" });
  });

  it("leaves a tool that identifies nobody alone", async () => {
    const { seen, dispatcher } = setup(undefined, {
      ...LOOKUP,
      identifiers: undefined,
      summarise: () => "That order is on its way.",
    });
    expect(await run(dispatcher, "anything at all")).toMatchObject({ kind: "ok" });
    expect(seen).toHaveLength(1);
  });

  it("tells the model what to do rather than only that something failed", async () => {
    const { dispatcher } = setup(gateWith({}));
    const outcome = await run(dispatcher, "AB-1234");
    const message = modelMessage(outcome);

    expect(message).toContain("has NOT run");
    expect(message.toLowerCase()).toContain("read it back");
    // The single most important instruction: the value it just used came from somewhere,
    // and going back to the same place produces the same wrong answer.
    expect(message.toLowerCase()).toContain("do not guess");
  });

  it("gates a write before the readback, not after it", async () => {
    const { seen, dispatcher } = setup(gateWith({}), {
      name: "account_lookup",
      description: "Change the number on the caller's account.",
      parameters: { type: "object" },
      tenantId: TENANT,
      riskTier: "write",
      identifiers: { reference: "policyNumber" },
      readback: (args) => `Updating ${String(args.reference)}. Should I go ahead?`,
      summarise: () => "Done.",
    });

    // Reading back a change to an account we have not established belongs to this caller
    // is worse than not offering it.
    expect(await run(dispatcher, "AB-1234")).toMatchObject({ reason: "unconfirmed-identity" });
    expect(seen).toHaveLength(0);
  });

  it("still transfers an irreversible tool rather than asking for a detail nobody will use", async () => {
    const { dispatcher } = setup(gateWith({}), {
      name: "account_lookup",
      description: "Close the caller's account.",
      parameters: { type: "object" },
      tenantId: TENANT,
      riskTier: "irreversible",
      identifiers: { reference: "policyNumber" },
      transferReason: "account closure",
    });

    expect(await run(dispatcher, "AB-1234")).toMatchObject({ kind: "transfer" });
  });

  it("refuses a tool whose identifiers are not a map of names", () => {
    const registry = createToolRegistry();
    for (const identifiers of [[], "policyNumber", { reference: "" }, { reference: 7 }]) {
      expect(() =>
        registry.register({ ...LOOKUP, identifiers } as unknown as ToolDefinition, {
          route: "http",
          execute: async () => null,
        }),
      ).toThrow(/identifiers/);
    }
  });
});
