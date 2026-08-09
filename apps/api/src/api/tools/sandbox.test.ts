import { randomUUID } from "node:crypto";

import { asTenantId } from "@ansa/shared";
import { describe, expect, it } from "vitest";

import { runToolInSandbox, type SandboxRun } from "./sandbox";

/**
 * What a sandbox run is, and what these tests can and cannot establish.
 *
 * They establish the half that matters most and needs no server: that the risk tiers a
 * caller is protected by are the tiers a tenant meets here. A `write` tool comes back with
 * its readback and does not fire; an `irreversible` one comes back as a transfer; a tool
 * that identifies a person refuses until the caller's detail is asserted. Every one of those
 * decisions is taken before an adapter is invoked, so no endpoint has to exist for them.
 *
 * They cannot establish the `ok` path, and that is worth being plain about rather than
 * faking. Reaching it means a tenant endpoint answering over HTTPS on a public address —
 * the egress guard refuses loopback deliberately, so a test server on this machine is not a
 * substitute — and a fake transport would be testing a fake. What sits underneath is tested
 * where it belongs: the connector's request and response handling in
 * `packages/tools/src/connector/http.test.ts`, and the observer this file reads the raw
 * response through in `packages/tools/src/dispatch.test.ts`.
 */

const owner = asTenantId(randomUUID());

const HOST = "api.example.invalid";

const document = {
  egress: { allowedHosts: [HOST] },
  http: [
    {
      name: "policy_lookup",
      description: "Look up a policy by its number.",
      parameters: { type: "object", properties: { policyNumber: { type: "string" } } },
      riskTier: "read",
      url: `https://${HOST}/policies`,
      method: "GET",
      send: "query",
      speech: { template: "That policy is {state}.", fallback: "I cannot find that policy." },
    },
    {
      name: "change_address",
      description: "Change the address held for a policy.",
      parameters: { type: "object", properties: { line1: { type: "string" } } },
      riskTier: "write",
      url: `https://${HOST}/address`,
      method: "POST",
      send: "body",
      readback: "I will change the address to {line1}.",
      speech: { template: "That is changed to {line1}.", fallback: "I could not change it." },
    },
    {
      name: "cancel_policy",
      description: "Cancel a policy outright.",
      parameters: { type: "object" },
      riskTier: "irreversible",
      url: `https://${HOST}/cancellations`,
      method: "POST",
      send: "body",
      transferReason: "a cancellation needs a person",
    },
    {
      name: "named_lookup",
      description: "Look up a record by the caller's own policy number.",
      parameters: { type: "object", properties: { policyNumber: { type: "string" } } },
      riskTier: "read",
      url: `https://${HOST}/records`,
      method: "GET",
      send: "query",
      identifiers: { policyNumber: "policyNumber" },
      speech: { template: "That record says {state}.", fallback: "I cannot find that record." },
    },
  ],
  mcp: [],
};

const run = (name: string, overrides: Partial<SandboxRun> = {}) =>
  runToolInSandbox({
    owner,
    toolConfig: document,
    sealedCredentials: new Map(),
    credentialKey: null,
    name,
    args: {},
    confirmed: new Map(),
    ...overrides,
  });

describe("a tool the organisation does not have", () => {
  it("is null rather than an apology, because the question was whether it exists", async () => {
    expect(await run("no_such_tool")).toBeNull();
  });

  /**
   * The platform's own tools hang up calls and hand them to people. They are not registered
   * here, so asking for one is the same answer as asking for a tool nobody configured.
   */
  it("includes the platform's call-control tools, which need a call", async () => {
    expect(await run("end_call")).toBeNull();
    expect(await run("transfer_to_human")).toBeNull();
  });
});

describe("the risk tier a caller is protected by", () => {
  it("reads back a write tool instead of firing it", async () => {
    const result = await run("change_address", { args: { line1: "12 Marina Road" } });

    expect(result).toMatchObject({ outcome: "confirm", riskTier: "write" });
    expect(result?.summary).toBe("I will change the address to 12 Marina Road.");
    // Nothing ran, so there is nothing to show on the raw side. That is the point of the
    // field being nullable rather than an empty object.
    expect(result?.raw).toBeNull();
    expect(result?.route).toBeNull();
  });

  it("transfers an irreversible tool, with the reason the tenant wrote", async () => {
    const result = await run("cancel_policy");

    expect(result).toMatchObject({ outcome: "transfer", riskTier: "irreversible" });
    expect(result?.reason).toBe("a cancellation needs a person");
    expect(result?.raw).toBeNull();
  });

  /**
   * The gate that exists because of a measured failure: the transcriber returns a stable
   * wrong name for a Nigerian caller, and a lookup on a misheard value does not fail — it
   * confidently returns the wrong customer. A sandbox that exempted itself from this would
   * be teaching an organisation that their tool runs when it does not.
   */
  it("refuses a tool that identifies a person until the detail is asserted", async () => {
    const refused = await run("named_lookup", { args: { policyNumber: "AXA4421" } });
    expect(refused).toMatchObject({ outcome: "failed", reason: "unconfirmed-identity" });
    expect(refused?.speech).not.toBe("");
  });

  it("still checks the argument against what was asserted, rather than trusting it", async () => {
    const mismatched = await run("named_lookup", {
      args: { policyNumber: "AXA4421" },
      confirmed: new Map([["policyNumber", "AXA9999"]]),
    });
    expect(mismatched).toMatchObject({ outcome: "failed", reason: "unconfirmed-identity" });
  });
});

describe("every run", () => {
  /**
   * Silence is the one failure this product may not have, so every branch of the dispatcher
   * produces speech — and the sandbox shows it, because "what would the caller hear" has an
   * answer even when the answer is an apology.
   */
  it("has something the agent would say, whatever happened", async () => {
    for (const name of ["change_address", "cancel_policy", "named_lookup"]) {
      const result = await run(name, { args: { line1: "somewhere", policyNumber: "x" } });
      expect(result?.speech.trim()).not.toBe("");
      expect(result?.summary.trim()).not.toBe("");
    }
  });
});
