import { randomBytes, randomUUID } from "node:crypto";

import { asTenantId } from "@ansa/shared";
import { parseConnectorConfig, parseEventConfig, sealCredential } from "@ansa/tools";
import { describe, expect, it } from "vitest";

import { toEventDocument, toEventResponseBody } from "./events.controller";
import { toToolDocument, toToolResponseBody } from "./tools.controller";
import {
  classifyCredentials,
  credentialUses,
  referencedCredentials,
  refuseUnusableReferences,
  toMaterial,
  vaultKey,
} from "./vault";

const tenant = asTenantId(randomUUID());
const other = asTenantId(randomUUID());

const HOST = "api.example.invalid";
const RECEIVER = "hooks.example.invalid";

/**
 * A configuration read back and published again must be the same configuration.
 *
 * This is the assertion that makes a whole-document `PUT` safe to build a screen on. The
 * dashboard's only way to change one tool is `GET`, edit, `PUT`, so anything the response
 * cannot express is something the next save silently deletes — a JSON Schema with nested
 * properties, an identifier map, a per-receiver redaction rule. Each of those was a real
 * temptation to model as something tidier than it is, and each is round-tripped here
 * instead.
 */
describe("a tool configuration, read back and published again", () => {
  const document = {
    egress: { allowedHosts: [`*.${HOST}`], allowPlaintextHttp: true },
    http: [
      {
        name: "policy_lookup",
        description: "Look up a policy by its number.",
        parameters: {
          type: "object",
          properties: {
            policyNumber: { type: "string", description: "As the caller read it out" },
            nested: { type: "object", properties: { deep: { type: "integer" } } },
          },
          required: ["policyNumber"],
        },
        riskTier: "read",
        url: `https://one.${HOST}/policies`,
        method: "GET",
        send: "query",
        timeoutMs: 2000,
        credentialRef: "partner_api",
        speech: { template: "Policy {number} is {state}.", fallback: "I cannot find that policy." },
        identifiers: { policyNumber: "policyNumber", callerName: "callerName" },
      },
      {
        name: "change_address",
        description: "Change the address held for a policy.",
        parameters: { type: "object", properties: { line1: { type: "string" } } },
        riskTier: "write",
        url: `https://two.${HOST}/address`,
        method: "POST",
        send: "body",
        readback: "I will change the address to {line1}.",
        speech: { template: "That is changed to {line1}.", fallback: "I could not change it." },
      },
    ],
    mcp: [
      {
        url: `https://three.${HOST}/mcp`,
        credentialRef: "partner_api",
        tools: [
          { name: "claims_status", riskTier: "read" },
          {
            name: "cancel_policy",
            riskTier: "irreversible",
            transferReason: "a cancellation is not something the assistant may do",
          },
        ],
      },
    ],
  };

  it("survives the round trip unchanged, nesting and all", () => {
    const parsed = parseConnectorConfig(document);
    const response = toToolResponseBody(parsed);
    expect(toToolDocument({ expectedVersion: 0, ...response })).toEqual(document);
  });

  it("carries the argument schema verbatim rather than describing it", () => {
    const response = toToolResponseBody(parseConnectorConfig(document));
    expect(JSON.parse(response.http[0]?.parametersJson ?? "null")).toEqual(
      document.http[0]?.parameters,
    );
  });

  it("turns the identifier map into pairs and back, in a stable order", () => {
    const response = toToolResponseBody(parseConnectorConfig(document));
    expect(response.http[0]?.identifiers).toEqual([
      { argument: "callerName", fact: "callerName" },
      { argument: "policyNumber", fact: "policyNumber" },
    ]);
    expect(response.http[1]?.identifiers).toBeUndefined();
  });

  it("does not invent a credential reference for a tool that has none", () => {
    const response = toToolResponseBody(parseConnectorConfig(document));
    expect(response.http[1]).not.toHaveProperty("credentialRef");
  });
});

describe("an event configuration, read back and published again", () => {
  const document = {
    egress: { allowedHosts: [RECEIVER] },
    redaction: { categories: ["card-number"], minDigits: 4, minSpokenDigits: 4 },
    subscriptions: [
      {
        name: "crm",
        url: `https://${RECEIVER}/crm`,
        events: ["call.ended", "call.transferred"],
        signingSecretRef: "crm_hook",
        credentialRef: "crm_api",
        timeoutMs: 10_000,
        maxAttempts: 8,
      },
      {
        name: "analytics",
        url: `https://${RECEIVER}/analytics`,
        events: ["call.ended"],
        signingSecretRef: "analytics_hook",
        timeoutMs: 5000,
        maxAttempts: 3,
        redaction: {
          categories: ["captured-identifier", "digit-sequence"],
          minDigits: 6,
          minSpokenDigits: 4,
        },
      },
    ],
  };

  it("survives the round trip unchanged", () => {
    const parsed = parseEventConfig(document);
    const response = toEventResponseBody(parsed, document);
    expect(toEventDocument({ expectedVersion: 0, ...response })).toEqual(document);
  });

  /**
   * The one that would be easy to get wrong and hard to notice: `parseEventConfig` resolves
   * every receiver's rules from the organisation's default, and reporting that resolved
   * value as the receiver's own would freeze the inheritance on the next save.
   */
  it("keeps inheritance as inheritance rather than copying it into each receiver", () => {
    const response = toEventResponseBody(parseEventConfig(document), document);
    expect(response.redaction?.categories).toEqual(["card-number"]);
    expect(response.subscriptions[0]).not.toHaveProperty("redaction");
    expect(response.subscriptions[1]?.redaction?.categories).toEqual([
      "captured-identifier",
      "digit-sequence",
    ]);
  });

  it("reports no redaction at all when none was asked for", () => {
    const plain = {
      egress: { allowedHosts: [RECEIVER] },
      subscriptions: [
        {
          name: "crm",
          url: `https://${RECEIVER}/crm`,
          events: ["call.ended"],
          signingSecretRef: "crm_hook",
        },
      ],
    };
    const response = toEventResponseBody(parseEventConfig(plain), plain);
    expect(response).not.toHaveProperty("redaction");
    expect(response.subscriptions[0]).not.toHaveProperty("redaction");
  });
});

describe("credentials", () => {
  const key = randomBytes(32);
  const secret = `${randomUUID()}${randomUUID()}`;

  const sealed = (): Map<string, string> =>
    new Map([
      ["partner_api", sealCredential(key, tenant, "partner_api", { kind: "bearer", token: secret })],
      ["crm_hook", sealCredential(key, tenant, "crm_hook", { kind: "signing", secret })],
    ]);

  it("tells an auth credential from a signing secret without revealing either", async () => {
    const kinds = await classifyCredentials(key, tenant, sealed());
    expect(kinds.get("partner_api")).toBe("auth");
    expect(kinds.get("crm_hook")).toBe("signing");
    // The plaintext is in a closure the vault owns; nothing this layer produces contains it.
    expect(JSON.stringify([...kinds])).not.toContain(secret);
  });

  /**
   * The AAD binds the tenant id and the reference into the authentication tag, so a
   * ciphertext row copied into another organisation's row does not open. This is the test
   * that a write bug in the credentials table cannot become a cross-tenant credential leak.
   */
  it("will not open a value sealed for another organisation", async () => {
    const stolen = new Map([
      ["partner_api", sealCredential(key, other, "partner_api", { kind: "bearer", token: secret })],
    ]);
    expect((await classifyCredentials(key, tenant, stolen)).get("partner_api")).toBe("unreadable");
  });

  it("will not open a value sealed under a different name", async () => {
    const moved = new Map([
      ["renamed", sealCredential(key, tenant, "partner_api", { kind: "bearer", token: secret })],
    ]);
    expect((await classifyCredentials(key, tenant, moved)).get("renamed")).toBe("unreadable");
  });

  it("reports a value it cannot open rather than pretending it is fine", async () => {
    const broken = new Map([["partner_api", "v1.aaaa.bbbb.cccc"]]);
    expect((await classifyCredentials(key, tenant, broken)).get("partner_api")).toBe("unreadable");
  });

  it("refuses a configuration that names a credential nobody has stored", async () => {
    const tools = parseConnectorConfig({
      egress: { allowedHosts: [HOST] },
      http: [
        {
          name: "order_status",
          description: "Look up an order.",
          parameters: { type: "object" },
          riskTier: "read",
          url: `https://${HOST}/orders`,
          method: "GET",
          send: "query",
          credentialRef: "missing_key",
          speech: { template: "It is {state}.", fallback: "I cannot check." },
        },
      ],
    });
    const uses = credentialUses(tools, parseEventConfig(null));
    expect(() => refuseUnusableReferences(uses, new Set(), null)).toThrow("has not stored");
  });

  /**
   * A receiver holds the signing secret. It must never turn out to be the token that opens
   * the organisation's own API, and the vault keeps the two apart in both directions — so
   * publishing a configuration that swaps them is refused here rather than at 3am.
   */
  it("refuses a signing secret used as an auth credential, and the reverse", async () => {
    const kinds = await classifyCredentials(key, tenant, sealed());
    const known = new Set(["partner_api", "crm_hook"]);

    expect(() =>
      refuseUnusableReferences(
        [{ ref: "crm_hook", needs: "auth", where: "tools.http[order_status]" }],
        known,
        kinds,
      ),
    ).toThrow("needs a auth credential");

    expect(() =>
      refuseUnusableReferences(
        [{ ref: "partner_api", needs: "signing", where: "events.crm.signingSecretRef" }],
        known,
        kinds,
      ),
    ).toThrow("needs a signing credential");
  });

  it("checks existence but not kind when the deployment holds no key", () => {
    const uses = [{ ref: "partner_api", needs: "signing" as const, where: "events.crm" }];
    expect(() => refuseUnusableReferences(uses, new Set(["partner_api"]), null)).not.toThrow();
    expect(() => refuseUnusableReferences(uses, new Set(), null)).toThrow("has not stored");
  });

  /**
   * Deleting a credential a configuration still names would leave a tool that registers and
   * then refuses every caller, so the check has to keep working on a document that does not
   * validate — which is exactly the state a hand-edited row is in.
   */
  it("finds references in a document that would not parse", () => {
    const found = referencedCredentials([
      { http: [{ credentialRef: "partner_api", riskTier: "nonsense" }], egress: 7 },
      { subscriptions: [{ signingSecretRef: "crm_hook" }, { credentialRef: "crm_api" }] },
      null,
    ]);
    expect([...found].sort()).toEqual(["crm_api", "crm_hook", "partner_api"]);
  });

  it("builds only the four schemes, and nothing from a body that is missing a field", () => {
    expect(toMaterial({ kind: "bearer", token: secret })).toEqual({ kind: "bearer", token: secret });
    expect(toMaterial({ kind: "signing", secret })).toEqual({ kind: "signing", secret });
    expect(toMaterial({ kind: "bearer" })).toBeNull();
    expect(toMaterial({ kind: "header", header: "x-api-key" })).toBeNull();
    // A query-string scheme is not offered: the URL is the one part of a request everybody
    // logs, so a secret there cannot satisfy R5.2.1 however careful the vault is.
    expect(toMaterial({ kind: "query", value: secret })).toBeNull();
  });

  it("reads the vault key from the environment, or reports that there is none", () => {
    expect(vaultKey({})).toBeNull();
    expect(vaultKey({ TOOL_CREDENTIAL_KEY: "  " })).toBeNull();
    expect(vaultKey({ TOOL_CREDENTIAL_KEY: key.toString("base64") })).toEqual(key);
    // A key of the wrong length makes every stored credential unopenable, which must not
    // present three layers away as "this organisation's tools are all broken".
    expect(() => vaultKey({ TOOL_CREDENTIAL_KEY: randomBytes(16).toString("base64") })).toThrow(
      "32 bytes",
    );
  });
});
