import { inspect } from "node:util";

import { asTenantId } from "@ansa/shared";
import { describe, expect, it } from "vitest";

import { redactArgs } from "../redact";

import { createCredentialVault, createInMemoryVault, sealCredential, type CredentialMaterial } from "./vault";

const TENANT_A = asTenantId("11111111-1111-4111-8111-111111111111");
const TENANT_B = asTenantId("22222222-2222-4222-8222-222222222222");

/** Synthetic throughout. Nothing here is a real credential and nothing keys on the value. */
const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);

const MATERIALS: readonly [string, CredentialMaterial, string, string][] = [
  [
    "bearer",
    { kind: "bearer", token: "tok-ZmFrZS0xMjM0NTY" },
    "authorization",
    "Bearer tok-ZmFrZS0xMjM0NTY",
  ],
  [
    "custom header",
    { kind: "header", header: "X-Partner-Key", value: "pk-000-aaa" },
    "x-partner-key",
    "pk-000-aaa",
  ],
  [
    "basic",
    { kind: "basic", username: "svc-ansa", password: "s3cr3t-pw" },
    "authorization",
    `Basic ${Buffer.from("svc-ansa:s3cr3t-pw").toString("base64")}`,
  ],
];

describe("sealing", () => {
  for (const [label, material, header, expected] of MATERIALS) {
    it(`round-trips ${label} and applies it to the right header`, async () => {
      const sealed = sealCredential(KEY, TENANT_A, "partner_api", material);
      const vault = createCredentialVault({ key: KEY, load: async () => sealed });

      const credential = await vault.resolve(TENANT_A, "partner_api");
      expect(credential).not.toBeNull();

      const headers: Record<string, string> = {};
      credential?.applyTo(headers);
      expect(headers[header]).toBe(expected);
    });
  }

  it("produces a different ciphertext every time, so two rows never compare equal", () => {
    const one = sealCredential(KEY, TENANT_A, "partner_api", { kind: "bearer", token: "same" });
    const two = sealCredential(KEY, TENANT_A, "partner_api", { kind: "bearer", token: "same" });
    expect(one).not.toBe(two);
  });

  it("refuses a key that is not 32 bytes rather than deriving one", () => {
    expect(() => sealCredential(Buffer.alloc(16, 1), TENANT_A, "x", { kind: "bearer", token: "t" })).toThrow(
      /32 bytes/,
    );
  });
});

describe("tenant binding", () => {
  /**
   * The interesting failure is not "an attacker guessed the key". It is a row copied, by
   * a bug or by hand, from one tenant's credentials into another's — at which point the
   * platform would authenticate to a partner API as the wrong customer. The tenant id is
   * in the AEAD tag, so the ciphertext simply does not open anywhere else.
   */
  it("will not open a ciphertext sealed for another tenant", async () => {
    const sealed = sealCredential(KEY, TENANT_A, "partner_api", { kind: "bearer", token: "a-only" });
    const vault = createCredentialVault({ key: KEY, load: async () => sealed });

    await expect(vault.resolve(TENANT_B, "partner_api")).rejects.toThrow();
  });

  it("will not open a ciphertext filed under another name", async () => {
    const sealed = sealCredential(KEY, TENANT_A, "partner_api", { kind: "bearer", token: "a-only" });
    const vault = createCredentialVault({ key: KEY, load: async () => sealed });

    await expect(vault.resolve(TENANT_A, "billing_api")).rejects.toThrow();
  });

  it("will not open under a different key, and will not open a tampered value", async () => {
    const sealed = sealCredential(KEY, TENANT_A, "partner_api", { kind: "bearer", token: "a-only" });

    await expect(
      createCredentialVault({ key: OTHER_KEY, load: async () => sealed }).resolve(TENANT_A, "partner_api"),
    ).rejects.toThrow();

    const parts = sealed.split(".");
    const flipped = [parts[0], parts[1], parts[2], Buffer.from("nonsense").toString("base64")].join(".");
    await expect(
      createCredentialVault({ key: KEY, load: async () => flipped }).resolve(TENANT_A, "partner_api"),
    ).rejects.toThrow();
  });

  it("keeps two tenants' credentials of the same name apart", async () => {
    const vault = createInMemoryVault(
      KEY,
      new Map([
        [TENANT_A, new Map([["api_key", sealCredential(KEY, TENANT_A, "api_key", { kind: "bearer", token: "for-a" })]])],
        [TENANT_B, new Map([["api_key", sealCredential(KEY, TENANT_B, "api_key", { kind: "bearer", token: "for-b" })]])],
      ]),
    );

    const headersA: Record<string, string> = {};
    (await vault.resolve(TENANT_A, "api_key"))?.applyTo(headersA);
    const headersB: Record<string, string> = {};
    (await vault.resolve(TENANT_B, "api_key"))?.applyTo(headersB);

    expect(headersA.authorization).toBe("Bearer for-a");
    expect(headersB.authorization).toBe("Bearer for-b");
  });

  it("returns null, not an error, when the tenant has no credential of that name", async () => {
    const vault = createInMemoryVault(KEY, new Map());
    expect(await vault.resolve(TENANT_A, "nothing_here")).toBeNull();
  });
});

describe("R5.2.1 — the plaintext has nowhere to go", () => {
  const secret = "tok-do-not-log-me";

  it("stringifies, serialises and inspects as redacted", async () => {
    const sealed = sealCredential(KEY, TENANT_A, "partner_api", { kind: "bearer", token: secret });
    const credential = await createCredentialVault({ key: KEY, load: async () => sealed }).resolve(
      TENANT_A,
      "partner_api",
    );
    if (credential === null) throw new Error("expected a credential");

    // The three ways a value reaches a log line in this codebase.
    expect(JSON.stringify({ credential })).not.toContain(secret);
    expect(`${credential}`).not.toContain(secret);
    expect(inspect({ credential }, { depth: 5 })).not.toContain(secret);

    // And it is still usable, which is the point of the exercise.
    const headers: Record<string, string> = {};
    credential.applyTo(headers);
    expect(headers.authorization).toContain(secret);
  });

  it("redacts credential-shaped argument keys on the way to the log", () => {
    const redacted = redactArgs({
      policyNumber: "AB-1234",
      apiKey: secret,
      access_token: secret,
      sessionId: secret,
      signature: secret,
      passphrase: secret,
      nested: { privateKey: secret, cookie: secret, reference: "keep-me" },
    });

    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted.policyNumber).toBe("AB-1234");
    expect((redacted.nested as Record<string, unknown>).reference).toBe("keep-me");
  });
});
