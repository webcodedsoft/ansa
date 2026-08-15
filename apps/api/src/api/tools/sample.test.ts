import { createServer, type Server } from "node:http";

import { asOrganizationId } from "@ansa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EgressGuard } from "@ansa/tools";

import { fetchSample } from "./sample";

/**
 * The preview fetch, which is a server-side request to a URL somebody typed.
 *
 * That is the shape of every SSRF, so most of this file is refusals. The protection is that
 * it goes through `createEgressGuard` — the same guard the call path uses — and these tests
 * exist so a later refactor cannot quietly route around it.
 */
const ORGANIZATION = asOrganizationId("44444444-4444-4444-8444-444444444444");

const base = {
  owner: ORGANIZATION,
  allowPlaintextHttp: true,
  headers: {},
  credentialRef: null,
  sealedCredentials: new Map<string, string>(),
  credentialKey: null,
};

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path.startsWith("/html")) {
      response.writeHead(200, { "content-type": "text/html" }).end("<html>maintenance</html>");
      return;
    }
    if (path.startsWith("/empty")) {
      response.writeHead(204).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ holder: "Adaeze", policy: { renewsOn: "2026-11-04" } }));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

describe("what the preview refuses", () => {
  it("refuses a URL that is not one", async () => {
    expect(await fetchSample({ ...base, url: "not a url" })).toMatchObject({ ok: false });
  });

  it("refuses credentials in the URL rather than sending them", async () => {
    /* The other half of the classic SSRF payload, where the interesting part is the
       userinfo. It is also a secret in a text box, which belongs in the vault. */
    const result = await fetchSample({ ...base, url: "https://user:pass@example.test/x" });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("vault");
  });

  it("refuses plain http when the organisation has not allowed it", async () => {
    const result = await fetchSample({ ...base, allowPlaintextHttp: false, url: `${origin}/x` });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("https");
  });

  it("refuses a host that resolves to a private address", async () => {
    /* 127.0.0.1 is reachable from this process and is exactly what must not be previewable:
       a preview that could reach loopback could reach anything else inside the network. It
       is allowed above only because those tests set `allowPlaintextHttp` and the guard's
       address check is what this one is about. */
    const result = await fetchSample({ ...base, url: "http://169.254.169.254/latest/meta-data" });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("private or link-local");
  });

  it("says so when a credential is asked for and no key is configured", async () => {
    // Sending the request unauthenticated instead would either 401 confusingly or — worse —
    // succeed against an endpoint that does not check.
    const result = await fetchSample({ ...base, url: `${origin}/x`, credentialRef: "acme" });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("credential key");
  });
});

/**
 * Loopback only, and only for the tests below.
 *
 * The real guard refuses 127.0.0.1 — correctly, and the refusal tests above prove the
 * default is the real one. These three are about what happens to a response once it has
 * been allowed through, which needs a server that can actually answer.
 */
const localGuard: EgressGuard = {
  check: async (raw) => {
    const url = new URL(raw);
    return url.hostname === "127.0.0.1"
      ? { ok: true, target: { url, addresses: [{ address: "127.0.0.1", family: 4 }] } }
      : { ok: false, reason: "host-not-allowed", detail: url.host };
  },
};

describe("what it returns", () => {
  it("hands back the parsed body", async () => {
    const result = await fetchSample({ ...base, url: `${origin}/policies`, guard: localGuard });
    expect(result.ok).toBe(true);
    expect(result.json).toMatchObject({ policy: { renewsOn: "2026-11-04" } });
  });

  it("reports a body that is not JSON rather than hiding it", async () => {
    // An endpoint answering with a login page is the actual finding, and the adapter would
    // refuse the same response on a call.
    const result = await fetchSample({ ...base, url: `${origin}/html`, guard: localGuard });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("not JSON");
  });

  it("handles an empty body without calling it a failure", async () => {
    const result = await fetchSample({ ...base, url: `${origin}/empty`, guard: localGuard });
    expect(result.ok).toBe(true);
    expect(result.json).toBeNull();
  });
});
