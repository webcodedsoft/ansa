import { createServer, type Server } from "node:http";

import { asTenantId, createLogger } from "@ansa/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createEgressGuard } from "../connector/egress";
import { createTransport } from "../connector/transport";
import { createInMemoryVault, sealCredential } from "../connector/vault";

import { EVENT_TYPES, parseEventConfig, subscribersTo, type EventSubscription } from "./config";
import { deliverOnce, nextAttemptDelayMs } from "./delivery";
import { prepareEvents } from "./prepare";
import {
  ATTEMPT_HEADER,
  EVENT_ID_HEADER,
  EVENT_TYPE_HEADER,
  SIGNATURE_HEADER,
  TENANT_HEADER,
  TIMESTAMP_HEADER,
  verifySignature,
} from "./signature";

const KEY = Buffer.alloc(32, 7);
const TENANT = asTenantId("11111111-1111-4111-8111-111111111111");
const SECRET = "a-signing-secret-long-enough";
const log = createLogger({ component: "events-test" });

// ---------------------------------------------------------------------------
// A receiver that behaves like a real one, because that is what is being tested
// ---------------------------------------------------------------------------

interface Received {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

let server: Server;
let host: string;
let received: Received[];
/** Set by a test to make the next N responses fail. */
let failuresLeft = 0;
let failureStatus = 500;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers[key] = value;
      }
      received.push({
        path: request.url ?? "/",
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        response.writeHead(failureStatus).end("no");
        return;
      }
      if ((request.url ?? "").startsWith("/slow")) {
        setTimeout(() => response.writeHead(204).end(), 3_000);
        return;
      }
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  host = `127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  received = [];
  failuresLeft = 0;
  failureStatus = 500;
});

/**
 * The address filter refuses loopback, which is correct and is exactly what makes it
 * untestable against a local server. Same approach as `connector/transport.test.ts`: a
 * guard that permits this one host, so what is under test is the delivery layer rather
 * than the guard, which has its own suite.
 */
const transport = () =>
  createTransport({
    guard: {
      check: async (raw) => {
        const url = new URL(raw);
        if (url.host !== host) return { ok: false, reason: "host-not-allowed", detail: url.host };
        return { ok: true, target: { url, addresses: [{ address: "127.0.0.1", family: 4 }] } };
      },
    },
  });

const subscription = (over: Partial<EventSubscription> = {}): EventSubscription => ({
  name: "crm",
  url: `http://${host}/hook`,
  events: ["call.ended"],
  signingSecretRef: "hook_secret",
  timeoutMs: 2_000,
  maxAttempts: 5,
  redaction: { categories: [], minDigits: 4, minSpokenDigits: 4 },
  ...over,
});

const signer = () => ({
  sign: (data: string) =>
    // The vault's own signer, reached the way production reaches it.
    data,
  toJSON: () => "[redacted]",
  toString: () => "[redacted]",
});

const realSigner = async () => {
  const vault = createInMemoryVault(
    KEY,
    new Map([[TENANT, new Map([["hook_secret", sealCredential(KEY, TENANT, "hook_secret", { kind: "signing", secret: SECRET })]])]]),
  );
  const found = await vault.resolveSigner(TENANT, "hook_secret");
  if (found === null) throw new Error("no signer");
  return found;
};

// ---------------------------------------------------------------------------

describe("configuration", () => {
  it("is nothing until a tenant writes one", () => {
    expect(parseEventConfig(null).subscriptions).toEqual([]);
    expect(parseEventConfig(undefined).subscriptions).toEqual([]);
  });

  it("refuses a subscription with no way to be verified", () => {
    expect(() =>
      parseEventConfig({
        subscriptions: [{ name: "crm", url: "https://a.example.test/x", events: ["call.ended"] }],
      }),
    ).toThrow(/signingSecretRef/);
  });

  it("refuses an event type it does not emit", () => {
    expect(() =>
      parseEventConfig({
        subscriptions: [
          {
            name: "crm",
            url: "https://a.example.test/x",
            events: ["call.started"],
            signingSecretRef: "s",
          },
        ],
      }),
    ).toThrow(/unknown type/);
  });

  it("defaults to no redaction, and a subscription may narrow the tenant's rule", () => {
    const parsed = parseEventConfig({
      egress: { allowedHosts: ["a.example.test", "b.example.test"] },
      redaction: { categories: ["digit-sequence"] },
      subscriptions: [
        { name: "crm", url: "https://a.example.test/x", events: ["call.ended"], signingSecretRef: "s" },
        {
          name: "analytics",
          url: "https://b.example.test/x",
          events: ["call.ended"],
          signingSecretRef: "s",
          redaction: { categories: ["digit-sequence", "email", "captured-identifier"] },
        },
      ],
    });
    expect(parsed.subscriptions[0]?.redaction.categories).toEqual(["digit-sequence"]);
    expect(parsed.subscriptions[1]?.redaction.categories).toHaveLength(3);

    const bare = parseEventConfig({
      egress: { allowedHosts: ["a.example.test"] },
      subscriptions: [
        { name: "crm", url: "https://a.example.test/x", events: ["call.ended"], signingSecretRef: "s" },
      ],
    });
    expect(bare.subscriptions[0]?.redaction.categories).toEqual([]);
  });

  it("routes each event only to the receivers that asked for it", () => {
    const parsed = parseEventConfig({
      egress: { allowedHosts: ["a.example.test", "b.example.test", "c.example.test"] },
      subscriptions: [
        { name: "crm", url: "https://a.example.test/x", events: ["call.ended"], signingSecretRef: "s" },
        { name: "desk", url: "https://b.example.test/x", events: ["call.transferred"], signingSecretRef: "s" },
        { name: "both", url: "https://c.example.test/x", events: [...EVENT_TYPES], signingSecretRef: "s" },
      ],
    });
    expect(subscribersTo(parsed, "call.ended").map((s) => s.name)).toEqual(["crm", "both"]);
    expect(subscribersTo(parsed, "call.transferred").map((s) => s.name)).toEqual(["desk", "both"]);
  });
});

describe("signing", () => {
  it("produces a signature the receiver can verify", async () => {
    const body = JSON.stringify({ type: "call.ended", callerSaid: "hello" });
    await deliverOnce(
      { transport: transport(), subscription: subscription(), signer: await realSigner() },
      { id: "e-1", type: "call.ended", tenantId: TENANT, attempt: 1, body },
    );

    const hit = received[0];
    expect(hit).toBeDefined();
    if (hit === undefined) return;
    expect(hit.body).toBe(body);
    // The receiver routes on these before it verifies anything, so they have to be there.
    expect(hit.headers[EVENT_TYPE_HEADER]).toBe("call.ended");
    expect(hit.headers[TENANT_HEADER]).toBe(TENANT);
    expect(hit.headers["content-type"]).toContain("application/json");
    expect(
      verifySignature({
        secret: SECRET,
        header: hit.headers[SIGNATURE_HEADER] ?? "",
        timestampSeconds: Number(hit.headers[TIMESTAMP_HEADER]),
        eventId: hit.headers[EVENT_ID_HEADER] ?? "",
        body: hit.body,
      }),
    ).toBe(true);
  });

  it("refuses a body that was altered in flight", async () => {
    const body = JSON.stringify({ amount: 1 });
    await deliverOnce(
      { transport: transport(), subscription: subscription(), signer: await realSigner() },
      { id: "e-2", type: "call.ended", tenantId: TENANT, attempt: 1, body },
    );
    const hit = received[0];
    if (hit === undefined) throw new Error("nothing received");

    expect(
      verifySignature({
        secret: SECRET,
        header: hit.headers[SIGNATURE_HEADER] ?? "",
        timestampSeconds: Number(hit.headers[TIMESTAMP_HEADER]),
        eventId: hit.headers[EVENT_ID_HEADER] ?? "",
        body: JSON.stringify({ amount: 2 }),
      }),
    ).toBe(false);
  });

  it("refuses a delivery replayed outside the tolerance window", async () => {
    const body = "{}";
    await deliverOnce(
      { transport: transport(), subscription: subscription(), signer: await realSigner() },
      { id: "e-3", type: "call.ended", tenantId: TENANT, attempt: 1, body },
    );
    const hit = received[0];
    if (hit === undefined) throw new Error("nothing received");

    const sent = Number(hit.headers[TIMESTAMP_HEADER]);
    expect(
      verifySignature({
        secret: SECRET,
        header: hit.headers[SIGNATURE_HEADER] ?? "",
        timestampSeconds: sent,
        eventId: hit.headers[EVENT_ID_HEADER] ?? "",
        body: hit.body,
        nowSeconds: sent + 3_600,
      }),
    ).toBe(false);
  });

  it("refuses a signature made with a different secret", () => {
    expect(
      verifySignature({
        secret: "a-different-secret-entirely",
        header: "v1=00",
        timestampSeconds: Math.floor(Date.now() / 1000),
        eventId: "e",
        body: "{}",
      }),
    ).toBe(false);
  });

  it("sends the same bytes and the same event id on a retry", async () => {
    const body = JSON.stringify({ n: 1 });
    const deps = { transport: transport(), subscription: subscription(), signer: signer() };
    await deliverOnce(deps, { id: "e-4", type: "call.ended", tenantId: TENANT, attempt: 1, body });
    await deliverOnce(deps, { id: "e-4", type: "call.ended", tenantId: TENANT, attempt: 2, body });

    expect(received).toHaveLength(2);
    expect(received[0]?.body).toBe(received[1]?.body);
    expect(received[0]?.headers[EVENT_ID_HEADER]).toBe(received[1]?.headers[EVENT_ID_HEADER]);
    // The attempt number is reported and is deliberately outside the signature, so the
    // receiver can deduplicate on the id without the signature changing underneath it.
    expect(received[0]?.headers[ATTEMPT_HEADER]).toBe("1");
    expect(received[1]?.headers[ATTEMPT_HEADER]).toBe("2");
  });
});

describe("what is worth trying again", () => {
  it("treats a 5xx as the receiver having a bad minute", async () => {
    failuresLeft = 1;
    const outcome = await deliverOnce(
      { transport: transport(), subscription: subscription(), signer: signer() },
      { id: "e-5", type: "call.ended", tenantId: TENANT, attempt: 1, body: "{}" },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.retryable).toBe(true);
  });

  it("gives up on a 4xx the receiver will never accept", async () => {
    failuresLeft = 1;
    failureStatus = 422;
    const outcome = await deliverOnce(
      { transport: transport(), subscription: subscription(), signer: signer() },
      { id: "e-6", type: "call.ended", tenantId: TENANT, attempt: 1, body: "{}" },
    );
    expect(outcome.retryable).toBe(false);
  });

  it("retries a 429, which means later rather than never", async () => {
    failuresLeft = 1;
    failureStatus = 429;
    const outcome = await deliverOnce(
      { transport: transport(), subscription: subscription(), signer: signer() },
      { id: "e-7", type: "call.ended", tenantId: TENANT, attempt: 1, body: "{}" },
    );
    expect(outcome.retryable).toBe(true);
  });

  it("times out on its own deadline rather than the voice budget", async () => {
    const outcome = await deliverOnce(
      {
        transport: transport(),
        subscription: subscription({ url: `http://${host}/slow`, timeoutMs: 300 }),
        signer: signer(),
      },
      { id: "e-8", type: "call.ended", tenantId: TENANT, attempt: 1, body: "{}" },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.retryable).toBe(true);
    expect(outcome.latencyMs).toBeLessThan(2_000);
  });

  it("does not retry a host the tenant never allowed", async () => {
    const outcome = await deliverOnce(
      {
        transport: createTransport({ guard: createEgressGuard({ policy: { allowedHosts: [] } }) }),
        subscription: subscription({ url: "https://somewhere.example.test/hook" }),
        signer: signer(),
      },
      { id: "e-9", type: "call.ended", tenantId: TENANT, attempt: 1, body: "{}" },
    );
    expect(outcome.retryable).toBe(false);
    expect(outcome.error).toContain("host-not-allowed");
  });

  it("backs off exponentially, with jitter, and never instantly", () => {
    // Highest jitter draw, so the shape of the curve is visible rather than the noise.
    const top = (attempt: number) => nextAttemptDelayMs(attempt, () => 0.999);
    expect(top(1)).toBeLessThanOrEqual(10_000);
    expect(top(2)).toBeGreaterThan(top(1));
    expect(top(3)).toBeGreaterThan(top(2));
    expect(top(20)).toBeLessThanOrEqual(900_000);
    // Lowest draw. A retry landing in the same second as its failure is not a retry.
    expect(nextAttemptDelayMs(1, () => 0)).toBeGreaterThanOrEqual(1_000);
  });
});

describe("preparation refuses to half-work", () => {
  it("delivers nothing when there is no vault key to sign with", async () => {
    const prepared = await prepareEvents({
      tenantId: TENANT,
      config: {
        subscriptions: [
          { name: "crm", url: "https://a.example.test/x", events: ["call.ended"], signingSecretRef: "s" },
        ],
      },
      credentialKey: null,
      sealedCredentials: new Map(),
      log,
    });
    expect(prepared.empty).toBe(true);
  });

  it("delivers nothing when the config is malformed, and does not throw", async () => {
    const prepared = await prepareEvents({
      tenantId: TENANT,
      config: { subscriptions: [{ name: "crm" }] },
      credentialKey: KEY,
      sealedCredentials: new Map(),
      log,
    });
    expect(prepared.empty).toBe(true);
  });

  it("skips a receiver whose signing secret is missing and keeps the others", async () => {
    const sealed = new Map([
      ["good_secret", sealCredential(KEY, TENANT, "good_secret", { kind: "signing", secret: SECRET })],
    ]);
    const prepared = await prepareEvents({
      tenantId: TENANT,
      config: {
        egress: { allowedHosts: ["a.example.test", "b.example.test"] },
        subscriptions: [
          { name: "missing", url: "https://a.example.test/x", events: ["call.ended"], signingSecretRef: "absent" },
          { name: "present", url: "https://b.example.test/x", events: ["call.ended"], signingSecretRef: "good_secret" },
        ],
      },
      credentialKey: KEY,
      sealedCredentials: sealed,
      log,
    });

    expect(prepared.empty).toBe(false);
    expect(prepared.subscribersTo("call.ended").map((s) => s.subscription.name)).toEqual(["present"]);
    expect(prepared.subscribersTo("call.transferred")).toEqual([]);
  });

  it("refuses to sign with a secret that was sealed as an auth credential", async () => {
    const sealed = new Map([
      ["mixed_up", sealCredential(KEY, TENANT, "mixed_up", { kind: "bearer", token: "not-for-signing" })],
    ]);
    const prepared = await prepareEvents({
      tenantId: TENANT,
      config: {
        egress: { allowedHosts: ["a.example.test"] },
        subscriptions: [
          { name: "crm", url: "https://a.example.test/x", events: ["call.ended"], signingSecretRef: "mixed_up" },
        ],
      },
      credentialKey: KEY,
      sealedCredentials: sealed,
      log,
    });
    expect(prepared.empty).toBe(true);
  });
});
