import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEgressGuard, type EgressGuard } from "./egress";
import { createTransport, EgressRefusedError } from "./transport";

/**
 * The transport against a real socket, because the things worth testing here — a redirect
 * being re-checked, a response that never stops, an abort mid-flight — are behaviours of
 * the network layer and a fake would only test the fake.
 */

let server: Server;
let host: string;
let seen: string[];

beforeAll(async () => {
  seen = [];
  server = createServer((request, response) => {
    const path = request.url ?? "/";
    seen.push(path);

    if (path === "/ok") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ fine: true }));
      return;
    }
    if (path === "/elsewhere") {
      // A redirect off the allowlist: the organization's own server sending us somewhere the
      // organization's operator never declared. This is the hop the guard has to see.
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
      return;
    }
    if (path === "/relative") {
      response.writeHead(302, { location: "/ok" }).end();
      return;
    }
    if (path.startsWith("/loop")) {
      response.writeHead(302, { location: `/loop${path.length}` }).end();
      return;
    }
    if (path === "/huge") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("x".repeat(64 * 1024));
      return;
    }
    if (path === "/slow") {
      setTimeout(() => response.writeHead(200).end("{}"), 2_000);
      return;
    }
    if (path === "/echo-method") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ method: request.method }));
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  host = `127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const guardFor = (allowed: string): EgressGuard => ({
  check: async (raw) => {
    const url = new URL(raw);
    if (url.host !== allowed) return { ok: false, reason: "host-not-allowed", detail: url.host };
    return { ok: true, target: { url, addresses: [{ address: "127.0.0.1", family: 4 }] } };
  },
});

const send = (path: string, options: { maxBytes?: number; maxRedirects?: number; signal?: AbortSignal } = {}) =>
  createTransport({ guard: guardFor(host), maxBytes: options.maxBytes, maxRedirects: options.maxRedirects }).send({
    url: `http://${host}${path}`,
    method: "GET",
    headers: { accept: "application/json" },
    signal: options.signal ?? new AbortController().signal,
  });

describe("the guarded transport", () => {
  it("makes an ordinary request", async () => {
    const response = await send("/ok");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ fine: true });
  });

  it("re-checks every redirect, so a hop off the allowlist is refused", async () => {
    await expect(send("/elsewhere")).rejects.toBeInstanceOf(EgressRefusedError);
  });

  it("follows a redirect that stays inside the allowlist", async () => {
    const response = await send("/relative");
    expect(JSON.parse(response.body)).toEqual({ fine: true });
  });

  it("stops following after the configured number of hops", async () => {
    await expect(send("/loop", { maxRedirects: 2 })).rejects.toThrow(/too many redirects/);
  });

  it("refuses to be fed an unbounded response", async () => {
    await expect(send("/huge", { maxBytes: 1_024 })).rejects.toThrow(/exceeded/);
  });

  it("stops when the dispatcher's ceiling aborts it, rather than holding the socket", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await expect(send("/slow", { signal: controller.signal })).rejects.toThrow();
  });

  it("does not replay a body to a location it did not address", async () => {
    const transport = createTransport({ guard: guardFor(host) });
    const response = await transport.send({
      url: `http://${host}/relative`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
      signal: new AbortController().signal,
    });
    // /relative answers 302, which turns the follow-up into a GET with no body.
    expect(response.status).toBe(200);
  });

  it("refuses a host the guard does not know at all", async () => {
    const transport = createTransport({ guard: guardFor(host) });
    await expect(
      transport.send({
        url: "http://somewhere.else.test/x",
        method: "GET",
        headers: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(EgressRefusedError);
  });

  it("refuses loopback under the real guard, even when the organization allowlisted it", async () => {
    // The guard used everywhere else in this file is a test double. This is the real one,
    // and it is what runs in production: a organization pointing a connector at our own machine
    // is refused however the hostname is spelled.
    const real = createEgressGuard({ policy: { allowedHosts: ["127.0.0.1"], allowPlaintextHttp: true } });
    const transport = createTransport({ guard: real });
    await expect(
      transport.send({
        url: `http://${host}/ok`,
        method: "GET",
        headers: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(EgressRefusedError);
  });
});
