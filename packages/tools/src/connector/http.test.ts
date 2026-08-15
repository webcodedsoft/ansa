import { createServer, type Server } from "node:http";

import { asCallId, asOrganizationId, type LogFields, type Logger } from "@ansa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createToolDispatcher } from "../dispatch";
import { createToolRegistry } from "../registry";

import { parseConnectorConfig, type HttpToolConfig } from "./config";
import type { EgressGuard } from "./egress";
import { registerHttpTools } from "./http";
import { createTransport } from "./transport";
import { createInMemoryVault, sealCredential } from "./vault";

/**
 * The failure modes of somebody else's endpoint.
 *
 * The happy path is proved in `equivalence.test.ts` against both routes. What is here is
 * what a organization's server does when it is having a bad day, plus the one thing that must
 * never happen when it does: the credential appearing in something we wrote down.
 */

const ORGANIZATION = asOrganizationId("44444444-4444-4444-8444-444444444444");
const CALL = asCallId("call-http");
const KEY = Buffer.alloc(32, 5);
const SECRET = "tok-never-write-this-down";

interface Line {
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

const recordingLogger = (): { lines: Line[]; log: Logger } => {
  const lines: Line[] = [];
  const make = (base: LogFields): Logger => {
    const write = () => (message: string, fields?: LogFields) => {
      lines.push({ message, fields: { ...base, ...fields } });
    };
    return { debug: write(), info: write(), warn: write(), error: write(), child: (fields) => make({ ...base, ...fields }) };
  };
  return { lines, log: make({}) };
};

let server: Server;
let host: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path.startsWith("/broken")) {
      // A real API's error body, which quotes the request back at us — credential header
      // and all. This is why the adapter must never put a body into an error message.
      response
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "upstream", echo: { authorization: request.headers.authorization } }));
      return;
    }
    if (path.startsWith("/html")) {
      response.writeHead(200, { "content-type": "text/html" }).end("<html>maintenance</html>");
      return;
    }
    if (path.startsWith("/anonymous")) {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ reference: "OK-1", state: "seen", authorization: request.headers.authorization ?? "none" }));
      return;
    }
    if (path.startsWith("/echo")) {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          reference: "OK-1",
          state: "seen",
          sawPath: path,
          sawTenant: request.headers["x-tenant"] ?? "none",
          sawAccept: request.headers.accept ?? "none",
        }),
      );
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

const guard: EgressGuard = {
  check: async (raw) => {
    const url = new URL(raw);
    return url.hostname === "127.0.0.1"
      ? { ok: true, target: { url, addresses: [{ address: "127.0.0.1", family: 4 }] } }
      : { ok: false, reason: "host-not-allowed", detail: url.host };
  },
};

const dispatcherFor = (
  path: string,
  credentialRef: string | undefined,
  sealed: ReadonlyMap<string, string>,
  over: Record<string, unknown> = {},
) => {
  const recorder = recordingLogger();
  const registry = createToolRegistry();
  const config = parseConnectorConfig({
    // Hostname only: the allowlist matches `URL.hostname`, so an entry carrying the port
    // would match nothing and parseConnectorConfig now refuses the pair rather than
    // leaving it to fail on a call.
    egress: { allowedHosts: [new URL(`http://${host}`).hostname], allowPlaintextHttp: true },
    http: [
      {
        name: "order_status",
        description: "Look up an order.",
        parameters: { type: "object" },
        riskTier: "read",
        url: `http://${host}${path}`,
        method: "GET",
        send: "query",
        credentialRef,
        speech: { template: "Order {reference} is {state}.", fallback: "I can't find that order." },
        ...over,
      } satisfies Partial<HttpToolConfig> as unknown,
    ],
  });

  registerHttpTools(registry, config.http, {
    organizationId: ORGANIZATION,
    transport: createTransport({ guard }),
    vault: createInMemoryVault(KEY, new Map([[ORGANIZATION, sealed]])),
    log: recorder.log,
  });

  return {
    lines: recorder.lines,
    dispatcher: createToolDispatcher({ registry, log: recorder.log, readRetries: 0 }),
  };
};

const withCredential = new Map([["partner", sealCredential(KEY, ORGANIZATION, "partner", { kind: "bearer", token: SECRET })]]);

describe("when the organization's endpoint misbehaves", () => {
  it("turns a 500 into an apology and never quotes the body back into a log", async () => {
    const { lines, dispatcher } = dispatcherFor("/broken", "partner", withCredential);
    const outcome = await dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      name: "order_status",
      args: { reference: "QT-1" },
    });

    expect(outcome).toMatchObject({ kind: "failed", reason: "adapter-error" });
    expect(outcome.speech.length).toBeGreaterThan(0);
    const written = JSON.stringify(lines);
    expect(written).toContain("500");
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain("authorization");
  });

  it("refuses a response that is not JSON rather than reading markup aloud", async () => {
    const { dispatcher } = dispatcherFor("/html", "partner", withCredential);
    expect(
      await dispatcher.dispatch({ organizationId: ORGANIZATION, callId: CALL, name: "order_status", args: {} }),
    ).toMatchObject({ kind: "failed", reason: "adapter-error" });
  });

  it("will not fall back to an unauthenticated request when the credential is missing", async () => {
    const { dispatcher } = dispatcherFor("/anonymous", "partner", new Map());
    expect(
      await dispatcher.dispatch({ organizationId: ORGANIZATION, callId: CALL, name: "order_status", args: {} }),
    ).toMatchObject({ kind: "failed", reason: "adapter-error" });
  });

  it("logs the endpoint it called without the arguments in the query string", async () => {
    const { lines, dispatcher } = dispatcherFor("/anonymous", undefined, new Map());
    await dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      name: "order_status",
      args: { reference: "ZR/88/AA" },
    });

    const line = lines.find((entry) => entry.message === "connector responded");
    expect(line?.fields.endpoint).toBe(`${host}/anonymous`);
    expect(JSON.stringify(line)).not.toContain("ZR/88/AA");
  });
});

/**
 * Path parameters and static headers on a real socket.
 *
 * `config.test.ts` proves what is refused at parse time. These prove what actually goes
 * down the wire, which is the half that matters for encoding: a value that escapes its
 * segment is a request to a different path than the one anybody configured.
 */
describe("a URL with a path parameter", () => {
  const raw = async (over: Record<string, unknown>, args: Record<string, unknown>) => {
    const { dispatcher } = dispatcherFor("/echo/{orderId}", undefined, new Map(), over);
    return dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      name: "order_status",
      args,
    });
  };

  it("puts the argument in the path and not also in the query string", async () => {
    const { dispatcher } = dispatcherFor("/echo/{orderId}", undefined, new Map(), {
      speech: { template: "Path was {sawPath}.", fallback: "no" },
    });
    const outcome = await dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      name: "order_status",
      args: { orderId: "QT-1" },
    });

    // Consumed by the path. Sending it again as ?orderId=QT-1 would give an endpoint that
    // reads both two chances to disagree with itself.
    expect(outcome.speech).toContain("/echo/QT-1");
    expect(outcome.speech).not.toContain("orderId=");
  });

  it("encodes a value that would otherwise climb out of its segment", async () => {
    const { dispatcher } = dispatcherFor("/echo/{orderId}", undefined, new Map(), {
      speech: { template: "Path was {sawPath}.", fallback: "no" },
    });
    const outcome = await dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      name: "order_status",
      args: { orderId: "../../admin" },
    });

    /* The model chooses this value from words a caller said, so it is untrusted in the
       ordinary sense. Unencoded it reaches /admin; encoded it stays one segment. */
    expect(outcome.speech).not.toContain("/admin");
    expect(outcome.speech).toContain("%2F");
  });

  it("refuses the call when the path parameter is missing", async () => {
    /* Sending `{orderId}` as a literal would produce a 404, and a 404 means "no such
       record" — so the caller would be told their order does not exist when in fact the
       tool was misconfigured. */
    expect(await raw({}, {})).toMatchObject({ kind: "failed" });
  });
});

describe("static headers on the way out", () => {
  it("sends the organisation's own header", async () => {
    const { dispatcher } = dispatcherFor("/echo", undefined, new Map(), {
      headers: { "X-Tenant": "acme" },
      speech: { template: "Tenant {sawTenant}.", fallback: "no" },
    });
    const outcome = await dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      name: "order_status",
      args: {},
    });
    expect(outcome.speech).toContain("acme");
  });

  it("still defaults accept to JSON when the organisation set other headers", async () => {
    const { dispatcher } = dispatcherFor("/echo", undefined, new Map(), {
      headers: { "X-Tenant": "acme" },
      speech: { template: "Accept {sawAccept}.", fallback: "no" },
    });
    const outcome = await dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      name: "order_status",
      args: {},
    });
    expect(outcome.speech).toContain("application/json");
  });
});
