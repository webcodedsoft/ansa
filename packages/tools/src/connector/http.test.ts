import { createServer, type Server } from "node:http";

import { asCallId, asOrganizationId, type LogFields, type Logger } from "@ansa/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createToolDispatcher, type IdentityGate } from "../dispatch";
import { createToolRegistry } from "../registry";

import { parseConnectorConfig, type HttpToolConfig } from "./config";
import type { EgressGuard } from "./egress";
import { registerHttpTools } from "./http";
import { prepareConnectors } from "./prepare";
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
/** A second origin, for the one thing a single host cannot show: a redirect off it. */
let elsewhere: Server;
let otherHost: string;
/** Every path the organisation's server was actually asked for, in order. */
let seenPaths: string[];

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "/";
    seenPaths.push(path);
    if (path.startsWith("/redirect-away")) {
      // The organisation's own server choosing the next host, which is the case the
      // allowlist cannot judge on its own: it still holds every host ever saved.
      response.writeHead(302, { location: `http://${otherHost}/landing` }).end();
      return;
    }
    if (path.startsWith("/redirect-here")) {
      response.writeHead(302, { location: "/echo" }).end();
      return;
    }
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
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            reference: "OK-1",
            state: "seen",
            sawPath: path,
            sawTenant: request.headers["x-tenant"] ?? "none",
            sawAccept: request.headers.accept ?? "none",
            sawContentType: request.headers["content-type"] ?? "none",
            sawBody: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  host = `127.0.0.1:${address.port}`;

  elsewhere = createServer((request, response) => {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ reference: "OK-1", state: request.headers.authorization ?? "no credential" }));
  });
  await new Promise<void>((ready) => elsewhere.listen(0, "127.0.0.1", ready));
  const other = elsewhere.address();
  if (other === null || typeof other === "string") throw new Error("no address");
  otherHost = `127.0.0.1:${other.port}`;
});

beforeEach(() => {
  seenPaths = [];
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await new Promise<void>((done) => elsewhere.close(() => done()));
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
  identity?: IdentityGate,
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
    dispatcher: createToolDispatcher({ registry, log: recorder.log, readRetries: 0, identity }),
  };
};

const withCredential = new Map([["partner", sealCredential(KEY, ORGANIZATION, "partner", { kind: "bearer", token: SECRET })]]);

describe("when the organization's endpoint misbehaves", () => {
  it("turns a 500 into an apology and never quotes the body back into a log", async () => {
    const { lines, dispatcher } = dispatcherFor("/broken", "partner", withCredential);
    const outcome = await dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      direction: "inbound" as const,
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
      await dispatcher.dispatch({ organizationId: ORGANIZATION, callId: CALL, direction: "inbound" as const, name: "order_status", args: {} }),
    ).toMatchObject({ kind: "failed", reason: "adapter-error" });
  });

  it("will not fall back to an unauthenticated request when the credential is missing", async () => {
    const { dispatcher } = dispatcherFor("/anonymous", "partner", new Map());
    expect(
      await dispatcher.dispatch({ organizationId: ORGANIZATION, callId: CALL, direction: "inbound" as const, name: "order_status", args: {} }),
    ).toMatchObject({ kind: "failed", reason: "adapter-error" });
  });

  it("logs the endpoint it called without the arguments in the query string", async () => {
    const { lines, dispatcher } = dispatcherFor("/anonymous", undefined, new Map());
    await dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      direction: "inbound" as const,
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
describe("a URL with a placeholder", () => {
  const raw = async (over: Record<string, unknown>, args: Record<string, unknown>) => {
    const { dispatcher } = dispatcherFor("/echo/{orderId}", undefined, new Map(), over);
    return dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      direction: "inbound" as const,
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
      direction: "inbound" as const,
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
      direction: "inbound" as const,
      name: "order_status",
      args: { orderId: "../../admin" },
    });

    /* The model chooses this value from words a caller said, so it is untrusted in the
       ordinary sense. Unencoded it reaches /admin; encoded it stays one segment. */
    expect(outcome.speech).not.toContain("/admin");
    expect(outcome.speech).toContain("%2F");
  });

  it("fills one in the query string, and does not append it a second time", async () => {
    /* `?regNo={id}` is how a great many real endpoints are shaped. It is substituted like
       any other placeholder and consumed with it, so the endpoint sees one `regNo` rather
       than a filled one and an appended one disagreeing with each other. */
    const { dispatcher } = dispatcherFor("/echo?regNo={orderId}", undefined, new Map(), {
      speech: { template: "Path was {sawPath}.", fallback: "no" },
    });
    const outcome = await dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      direction: "inbound" as const,
      name: "order_status",
      args: { orderId: "QT-1" },
    });

    expect(outcome.speech).toContain("regNo=QT-1");
    expect(outcome.speech).not.toContain("orderId=");
  });

  it("refuses the call when the placeholder has no argument", async () => {
    /* Sending `{orderId}` as a literal would produce a 404, and a 404 means "no such
       record" — so the caller would be told their order does not exist when in fact the
       tool was misconfigured. */
    expect(await raw({}, {})).toMatchObject({ kind: "failed" });
  });

  /**
   * Every way an argument can be unusable, and the one property they share.
   *
   * The adapter throws, and the throw has to arrive as a sentence. `fillPath` runs inside
   * `execute`, which is inside the dispatcher's one `adapter.execute` call site, so the
   * failure lands on the same path a 500 does — but nothing proved that until here, and a
   * gap over two seconds reads as a dropped call (R6.2).
   */
  const unusable: readonly [string, unknown][] = [
    ["an object", { nested: true }],
    ["an array", ["QT-1"]],
    ["null", null],
    ["an empty string", ""],
    ["whitespace the model padded", "   "],
  ];

  for (const [why, value] of unusable) {
    it(`turns ${why} into speech rather than silence`, async () => {
      const outcome = await raw({}, { orderId: value });
      expect(outcome).toMatchObject({ kind: "failed", reason: "adapter-error" });
      expect(outcome.speech.trim().length).toBeGreaterThan(0);
      // And the endpoint was never asked for anything, so nothing half-happened.
      expect(seenPaths).toEqual([]);
    });
  }

  /**
   * The one value `encodeURIComponent` does not neutralise.
   *
   * `.` and `..` are unreserved, so they survive the encoder unchanged and the URL parser
   * reads them as navigation. `/customers/{id}/orders` with an id of `..` resolves to
   * `/customers/orders` — a different endpoint, and on a good many APIs the one that lists
   * everybody. The slashes in `../../admin` were what the encoder was catching.
   */
  for (const climb of ["..", "."]) {
    it(`refuses ${JSON.stringify(climb)}, which climbs out of its segment despite the encoding`, async () => {
      const { dispatcher } = dispatcherFor("/echo/{orderId}/orders", undefined, new Map(), {
        speech: { template: "Path was {sawPath}.", fallback: "no" },
      });
      const outcome = await dispatcher.dispatch({
        organizationId: ORGANIZATION,
        callId: CALL,
        direction: "inbound" as const,
        name: "order_status",
        args: { orderId: climb },
      });

      expect(outcome).toMatchObject({ kind: "failed", reason: "adapter-error" });
      expect(seenPaths).toEqual([]);
    });
  }

  it("shows what that argument would otherwise have done", () => {
    // Not a claim about our code: a claim about the URL parser both we and the
    // organisation's server run, which is why the check above cannot be an encoding.
    expect(new URL(`http://${host}/echo/${encodeURIComponent("..")}/orders`).pathname).toBe("/orders");
  });
});

/**
 * A tool keyed on who the caller is, whose identifier the URL consumes.
 *
 * Worth its own block because the two features meet in an order nothing states: the gate
 * reads `call.args` in `dispatch.ts`, and `fillPath` deletes the argument in the adapter.
 * If those ran the other way round a placeholder would be a way to skip the gate, and a
 * tool would fire on an identifier nobody confirmed.
 */
describe("the identity gate and a URL placeholder", () => {
  const gated = (confirmed: Readonly<Record<string, string>>) =>
    dispatcherFor(
      "/echo/{orderId}",
      undefined,
      new Map(),
      {
        identifiers: { orderId: "policyNumber" },
        speech: { template: "Path was {sawPath}.", fallback: "no" },
      },
      { confirmed: (fact) => confirmed[fact] ?? null },
    );

  it("still refuses when the value the URL would consume is unconfirmed", async () => {
    const { dispatcher } = gated({});
    const outcome = await dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      direction: "inbound" as const,
      name: "order_status",
      args: { orderId: "QT-1" },
    });

    expect(outcome).toMatchObject({ kind: "failed", reason: "unconfirmed-identity" });
    // The gate is above the adapter, so the request is never made at all.
    expect(seenPaths).toEqual([]);
  });

  it("puts the spelling the caller agreed to in the path, not the model's paraphrase", async () => {
    /* The gate canonicalises the argument and the adapter fills from the canonical copy.
       If it filled from `call.args` instead, the organisation's system would be queried
       with whatever the transcriber produced — which is the thing the readback exists to
       stop being the query. */
    const { dispatcher } = gated({ policyNumber: "ZR/88/AA" });
    const outcome = await dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      direction: "inbound" as const,
      name: "order_status",
      args: { orderId: "zr 88 aa" },
    });

    expect(outcome).toMatchObject({ kind: "ok" });
    expect(seenPaths).toEqual(["/echo/ZR%2F88%2FAA"]);
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
      direction: "inbound" as const,
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
      direction: "inbound" as const,
      name: "order_status",
      args: {},
    });
    expect(outcome.speech).toContain("application/json");
  });

  /**
   * Headers, a credential and a body at once, judged at the socket rather than in the map.
   *
   * `execute` writes the organisation's headers first and everything else over them, which
   * is only half the argument: the map is keyed by the case the operator typed, so
   * `Content-Type` and `content-type` are two entries in it and the promise is really about
   * what Node does with both. Proved here on the wire, where it is one header either way.
   */
  it("keeps content-type as JSON even when the organisation set its own", async () => {
    const { dispatcher } = dispatcherFor("/echo", undefined, new Map(), {
      method: "POST",
      send: "body",
      headers: { "Content-Type": "application/xml", "X-Tenant": "acme" },
      speech: { template: "Type {sawContentType} body {sawBody}.", fallback: "no" },
    });
    const outcome = await dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      direction: "inbound" as const,
      name: "order_status",
      args: { reference: "QT-1" },
    });

    expect(outcome.speech).toContain("application/json");
    expect(outcome.speech).not.toContain("application/xml");
    expect(outcome.speech).toContain('{"reference":"QT-1"}');
  });

  it("will not let a static header displace the credential that shares its name", async () => {
    /* `parseHeaders` refuses `authorization` and friends outright, but a vault credential
       can be a header of the organisation's own choosing — so the two can still collide by
       name, and the credential has to win. If the static value won, the request would go
       out authenticated as whatever an operator typed into a text box. */
    const smuggled = new Map([
      ["partner", sealCredential(KEY, ORGANIZATION, "partner", { kind: "header", header: "X-Tenant", value: SECRET })],
    ]);
    const { dispatcher } = dispatcherFor("/echo", "partner", smuggled, {
      headers: { "X-Tenant": "acme" },
      speech: { template: "Tenant {sawTenant}.", fallback: "no" },
    });
    const outcome = await dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      direction: "inbound" as const,
      name: "order_status",
      args: {},
    });

    expect(outcome.speech).toContain(SECRET);
    expect(outcome.speech).not.toContain("acme");
  });
});

/**
 * A redirect the organisation's own server chose, and where the credential goes with it.
 *
 * The allowlist only accumulates: every tool save adds its host and nothing removes one, so
 * a host edited away in the console is still a host this transport will follow a redirect
 * to. The guard is right to allow it — it is on the list — which is exactly why the
 * credential must not travel.
 */
describe("a redirect off the configured host", () => {
  const followTo = (path: string) =>
    dispatcherFor(path, "partner", withCredential, {
      speech: { template: "Saw {state}.", fallback: "no" },
    });

  it("does not carry the credential to a different origin", async () => {
    const { dispatcher } = followTo("/redirect-away");
    const outcome = await dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      direction: "inbound" as const,
      name: "order_status",
      args: {},
    });

    expect(outcome).toMatchObject({ kind: "ok" });
    expect(outcome.speech).toContain("no credential");
    expect(outcome.speech).not.toContain(SECRET);
  });

  it("still sends it on a redirect that stays on the same origin", async () => {
    // The other half of the rule. Dropping it on every hop would break an organisation
    // whose API answers 302 to its own canonical path, which is ordinary.
    const { dispatcher } = dispatcherFor("/redirect-here", "partner", withCredential, {
      speech: { template: "Tenant {sawTenant} accept {sawAccept}.", fallback: "no" },
    });
    const outcome = await dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      direction: "inbound" as const,
      name: "order_status",
      args: {},
    });

    expect(outcome).toMatchObject({ kind: "ok" });
    expect(seenPaths).toEqual(["/redirect-here", "/echo"]);
  });
});

/**
 * The stored column, through the function the call path actually calls.
 *
 * `config.test.ts` proves the stamps parse. This proves the next two steps with them still
 * in the document: `prepareConnectors` briefs the tool to the prompt, and `register` puts it
 * in the registry the dispatcher resolves against. Those are the steps that run on a real
 * call, and a stamp the parser tolerated but a later step tripped over would show up here
 * and nowhere else.
 */
describe("a stored tool with stamps, through prepareConnectors", () => {
  const stored = (extra: Record<string, unknown>) => ({
    egress: { allowedHosts: ["api.partner.test"] },
    http: [
      {
        name: "risk_lookup",
        description: "Look up a vehicle by its plate number.",
        parameters: { type: "object", required: ["riskId"], properties: { riskId: { type: "string" } } },
        riskTier: "read",
        url: "https://api.partner.test/vehicles?regNo={riskId}",
        method: "GET",
        send: "query",
        speech: { template: "Chassis {chassisNumber}.", fallback: "We could not find your risk." },
        ...extra,
      },
    ],
    mcp: [],
  });

  const prepare = (extra: Record<string, unknown>) =>
    prepareConnectors({
      organizationId: ORGANIZATION,
      config: stored(extra),
      credentialKey: KEY,
      sealedCredentials: new Map(),
      log: recordingLogger().log,
    });

  it("registers identically with the stamps and without them", async () => {
    const withStamps = await prepare({
      createdAt: "2026-08-15T21:10:38.442Z",
      updatedAt: "2026-08-15T21:10:38.442Z",
    });
    const without = await prepare({});

    expect(withStamps.tools).toEqual(without.tools);
    // What the prompt is told, which is the half a parse test cannot see.
    expect(withStamps.tools).toEqual([
      { name: "risk_lookup", description: "Look up a vehicle by its plate number.", riskTier: "read" },
    ]);

    const registry = createToolRegistry();
    withStamps.register(registry);
    expect(registry.resolve(ORGANIZATION, "risk_lookup")).not.toBeNull();
  });
});

/**
 * One tool the registry will not take, and the ones either side of it.
 *
 * A single registrar held every HTTP tool, so `prepare.ts`'s catch fired once for the whole
 * list and the first refusal — a name shadowing a platform tool, a duplicate, one the
 * pattern will not take — cost every tool after it in the document. The prompt had already
 * been told about all of them, because the brief comes from the parsed config rather than
 * from what registered, so the caller heard "that's not something I can do on this line"
 * about a tool the organisation had configured and nothing on any screen said why.
 */
describe("a document with one unregistrable tool in it", () => {
  // `Second Tool` parses — configuration only asks for a non-empty name — and is refused by
  // `registry.register`, which insists on a name the model can actually ask for.
  // A function, because `host` is only known once the fixture server is listening.
  const document = () => ({
    egress: { allowedHosts: ["127.0.0.1"], allowPlaintextHttp: true },
    http: ["first_tool", "Second Tool", "third_tool"].map((name) => ({
      name,
      description: "Look up an order.",
      parameters: { type: "object" },
      riskTier: "read",
      url: `http://${host}/echo`,
      method: "GET",
      send: "query",
      speech: { template: "Order {reference} is {state}.", fallback: "no" },
    })),
    mcp: [],
  });

  it("costs that tool and not the ones after it", async () => {
    const recorder = recordingLogger();
    const prepared = await prepareConnectors({
      organizationId: ORGANIZATION,
      config: document(),
      credentialKey: KEY,
      sealedCredentials: new Map(),
      log: recorder.log,
    });

    const registry = createToolRegistry();
    prepared.register(registry);

    expect(registry.resolve(ORGANIZATION, "first_tool")).not.toBeNull();
    expect(registry.resolve(ORGANIZATION, "third_tool")).not.toBeNull();
    expect(registry.resolve(ORGANIZATION, "Second Tool")).toBeNull();
    // And loudly, with the organisation, because the fix is a new configuration version.
    expect(recorder.lines.some((line) => line.message.includes("could not be registered"))).toBe(true);
  });

  it("is still refused whole at publication, which is where somebody is looking", () => {
    /* The tolerance above belongs to the call path and must not become the publisher's.
       `checkToolConfig` runs this same function against a throwaway registry and turns the
       throw into a 422 naming the tool — the difference between finding out on the screen
       you typed it on and finding out from a caller three weeks later. */
    expect(() =>
      registerHttpTools(createToolRegistry(), parseConnectorConfig(document()).http, {
        organizationId: ORGANIZATION,
        transport: createTransport({ guard }),
        vault: createInMemoryVault(KEY, new Map()),
        log: recordingLogger().log,
      }),
    ).toThrow(/Second Tool/);
  });
});
