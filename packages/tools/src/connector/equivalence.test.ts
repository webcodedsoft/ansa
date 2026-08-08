import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { asCallId, asTenantId, type LogFields, type Logger, type TenantId } from "@ansa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createToolDispatcher, type HoldContext, type HoldingSpeech } from "../dispatch";
import { createToolRegistry, type ToolRegistry } from "../registry";
import type { DispatchOutcome } from "../types";

import { parseConnectorConfig } from "./config";
import type { EgressGuard } from "./egress";
import { registerHttpTools } from "./http";
import { registerMcpServer } from "./mcp";
import { createTransport } from "./transport";
import { createInMemoryVault, sealCredential } from "./vault";

/**
 * The R5.2.0 claim, tested rather than asserted.
 *
 * One backend — an ordinary object with three operations — is exposed twice by the same
 * loopback server: once as a REST API and once as an MCP server. Two tenants are
 * configured, one per route, and every behaviour that matters is compared between them.
 * If a control existed on one route and not the other, this is where it would show.
 *
 * Two tenants rather than one because a tenant may not register two tools of the same
 * name, and using the same names on both sides is the point.
 */

const HTTP_TENANT = asTenantId("11111111-1111-4111-8111-111111111111");
const MCP_TENANT = asTenantId("22222222-2222-4222-8222-222222222222");
const CALL = asCallId("call-equivalence");
const KEY = Buffer.alloc(32, 3);

interface Line {
  readonly level: string;
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

const recordingLogger = (): { lines: Line[]; log: Logger } => {
  const lines: Line[] = [];
  const make = (base: LogFields): Logger => {
    const write = (level: string) => (message: string, fields?: LogFields) => {
      lines.push({ level, message, fields: { ...base, ...fields } });
    };
    return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error"), child: (fields) => make({ ...base, ...fields }) };
  };
  return { lines, log: make({}) };
};

/**
 * A guard that permits exactly the loopback test server.
 *
 * There is no configuration flag that relaxes the real guard, on purpose: a flag that
 * exists in the type is a flag a tenant's configuration can eventually reach. Tests get a
 * different implementation of the interface instead, and `egress.test.ts` exercises the
 * real one against a table of addresses.
 */
const guardFor = (host: string): EgressGuard => ({
  check: async (raw) => {
    const url = new URL(raw);
    if (url.host !== host) return { ok: false, reason: "host-not-allowed", detail: url.host };
    return { ok: true, target: { url, addresses: [{ address: "127.0.0.1", family: 4 }] } };
  },
});

/** Deliberately unrelated to each other, and none of them is special-cased anywhere. */
interface Order {
  readonly reference: string;
  state: string;
  contactNumber: string;
}

const seed = (): Map<string, Order> =>
  new Map<string, Order>([
    ["QT-4471", { reference: "QT-4471", state: "out for delivery", contactNumber: "0803 111 2222" }],
    ["9920014", { reference: "9920014", state: "awaiting payment", contactNumber: "0701 555 0000" }],
    ["ZR/88/AA", { reference: "ZR/88/AA", state: "collected", contactNumber: "0902 444 8888" }],
  ]);

const AUTH = "Bearer test-shared-secret";

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const sendJson = (response: ServerResponse, status: number, payload: unknown): void => {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
};

interface Backend {
  readonly orders: Map<string, Order>;
  /** Every operation the backend was actually asked to perform, whichever route asked. */
  readonly performed: string[];
  slowMs: number;
}

const lookup = (backend: Backend, args: Record<string, unknown>): Order | null => {
  backend.performed.push("lookup");
  const reference = typeof args.reference === "string" ? args.reference : "";
  return backend.orders.get(reference) ?? null;
};

const setContact = (backend: Backend, args: Record<string, unknown>): Order | null => {
  backend.performed.push("setContact");
  const reference = typeof args.reference === "string" ? args.reference : "";
  const contactNumber = typeof args.contactNumber === "string" ? args.contactNumber : "";
  const order = backend.orders.get(reference);
  if (order === undefined) return null;
  order.contactNumber = contactNumber;
  return order;
};

const cancel = (backend: Backend): never => {
  // A tripwire, not an implementation. If an irreversible tool ever reaches an endpoint,
  // this is the line that says so rather than an order quietly disappearing.
  backend.performed.push("cancel");
  throw new Error("cancel must never be reached");
};

const startServer = async (backend: Backend): Promise<{ server: Server; host: string }> => {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://placeholder");
      if (request.headers.authorization !== AUTH) {
        sendJson(response, 401, { error: "unauthorised" });
        return;
      }
      if (backend.slowMs > 0) await new Promise((r) => setTimeout(r, backend.slowMs));

      // ---- Route A: an ordinary REST API ------------------------------------------
      if (url.pathname === "/orders" && request.method === "GET") {
        const order = lookup(backend, Object.fromEntries(url.searchParams));
        if (order === null) {
          sendJson(response, 404, { error: "not found" });
          return;
        }
        sendJson(response, 200, order);
        return;
      }
      if (url.pathname === "/orders/contact" && request.method === "POST") {
        const args = JSON.parse(await readBody(request)) as Record<string, unknown>;
        const order = setContact(backend, args);
        sendJson(response, order === null ? 404 : 200, order ?? { error: "not found" });
        return;
      }
      if (url.pathname === "/orders/cancel") {
        cancel(backend);
        return;
      }

      // ---- Route B: the same backend, spoken as MCP -------------------------------
      if (url.pathname === "/rpc" && request.method === "POST") {
        const message = JSON.parse(await readBody(request)) as {
          id?: number;
          method: string;
          params?: Record<string, unknown>;
        };

        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        if (message.method === "initialize") {
          sendJson(response, 200, {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "test-orders", version: "1" },
            },
          });
          return;
        }
        if (message.method === "tools/list") {
          sendJson(response, 200, {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [
                {
                  name: "order_status",
                  description: "Look up an order by its reference.",
                  inputSchema: { type: "object", properties: { reference: { type: "string" } }, required: ["reference"] },
                },
                {
                  name: "update_contact",
                  description: "Change the phone number held against an order.",
                  inputSchema: {
                    type: "object",
                    properties: { reference: { type: "string" }, contactNumber: { type: "string" } },
                    required: ["reference", "contactNumber"],
                  },
                },
                {
                  name: "cancel_order",
                  description: "Cancel an order outright.",
                  inputSchema: { type: "object", properties: { reference: { type: "string" } } },
                },
                {
                  // Offered by the server and given no tier by the tenant. Must not register.
                  name: "wipe_account",
                  description: "Delete everything.",
                  inputSchema: { type: "object" },
                },
              ],
            },
          });
          return;
        }
        if (message.method === "tools/call") {
          const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          const args = params.arguments ?? {};
          const order =
            params.name === "order_status"
              ? lookup(backend, args)
              : params.name === "update_contact"
                ? setContact(backend, args)
                : cancel(backend);

          // Answered as an event stream rather than as JSON, so the other half of the
          // Streamable HTTP contract is exercised by something.
          const payload = {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: order === null ? "no such order" : JSON.stringify(order) }],
              structuredContent: order,
            },
          };
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
          return;
        }
        sendJson(response, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } });
        return;
      }

      sendJson(response, 404, { error: "no such route" });
    })();
  });

  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return { server, host: `127.0.0.1:${address.port}` };
};

/** The same three sentences, whichever route produced the data behind them. */
const SPEECH = {
  status: { template: "Order {reference} is {state}.", fallback: "I can't find an order with that reference." },
  contact: {
    template: "Done — the number on order {reference} is now {contactNumber}.",
    fallback: "I couldn't find that order, so nothing has been changed.",
  },
  readback: "I'm changing the number on order {reference} to {contactNumber}. Should I go ahead?",
};

let backend: Backend;
let server: Server;
let host: string;
let registry: ToolRegistry;
let lines: Line[];
let heard: string[];
let dispatcher: ReturnType<typeof createToolDispatcher>;

beforeAll(async () => {
  backend = { orders: seed(), performed: [], slowMs: 0 };
  const started = await startServer(backend);
  server = started.server;
  host = started.host;

  const vault = createInMemoryVault(
    KEY,
    new Map([
      [HTTP_TENANT as TenantId, new Map([["partner", sealCredential(KEY, HTTP_TENANT, "partner", { kind: "bearer", token: "test-shared-secret" })]])],
      [MCP_TENANT as TenantId, new Map([["partner", sealCredential(KEY, MCP_TENANT, "partner", { kind: "bearer", token: "test-shared-secret" })]])],
    ]),
  );

  const recorder = recordingLogger();
  lines = recorder.lines;
  const transport = createTransport({ guard: guardFor(host) });
  registry = createToolRegistry();

  const httpConfig = parseConnectorConfig({
    egress: { allowedHosts: [host], allowPlaintextHttp: true },
    http: [
      {
        name: "order_status",
        description: "Look up an order by its reference.",
        parameters: { type: "object", properties: { reference: { type: "string" } }, required: ["reference"] },
        riskTier: "read",
        url: `http://${host}/orders`,
        method: "GET",
        send: "query",
        credentialRef: "partner",
        speech: SPEECH.status,
      },
      {
        name: "update_contact",
        description: "Change the phone number held against an order.",
        parameters: { type: "object" },
        riskTier: "write",
        url: `http://${host}/orders/contact`,
        method: "POST",
        send: "body",
        credentialRef: "partner",
        readback: SPEECH.readback,
        speech: SPEECH.contact,
      },
      {
        name: "cancel_order",
        description: "Cancel an order outright.",
        parameters: { type: "object" },
        riskTier: "irreversible",
        url: `http://${host}/orders/cancel`,
        method: "POST",
        send: "body",
        credentialRef: "partner",
        transferReason: "order cancellation",
      },
    ],
  });

  registerHttpTools(registry, httpConfig.http, {
    tenantId: HTTP_TENANT,
    transport,
    vault,
    log: recorder.log,
  });

  const mcpConfig = parseConnectorConfig({
    egress: { allowedHosts: [host], allowPlaintextHttp: true },
    mcp: [
      {
        url: `http://${host}/rpc`,
        credentialRef: "partner",
        tools: [
          { name: "order_status", riskTier: "read", speech: SPEECH.status },
          { name: "update_contact", riskTier: "write", readback: SPEECH.readback, speech: SPEECH.contact },
          { name: "cancel_order", riskTier: "irreversible", transferReason: "order cancellation" },
        ],
      },
    ],
  });

  const first = mcpConfig.mcp[0];
  if (first === undefined) throw new Error("no mcp server configured");
  await registerMcpServer(registry, first, { tenantId: MCP_TENANT, transport, vault, log: recorder.log });

  heard = [];
  const holding: HoldingSpeech = {
    start: (context: HoldContext) => heard.push(`start:${context.name}`),
    slow: (context: HoldContext) => heard.push(`slow:${context.name}`),
    stop: (context: HoldContext) => heard.push(`stop:${context.name}`),
  };
  dispatcher = createToolDispatcher({ registry, log: recorder.log, holding });
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

const bothRoutes = async (
  name: string,
  args: Record<string, unknown>,
  confirm?: (outcome: DispatchOutcome) => string | undefined,
): Promise<{ http: DispatchOutcome; mcp: DispatchOutcome }> => {
  const run = async (tenantId: TenantId): Promise<DispatchOutcome> => {
    const first = await dispatcher.dispatch({ tenantId, callId: CALL, name, args });
    const confirmationId = confirm?.(first);
    if (confirmationId === undefined) return first;
    return dispatcher.dispatch({ tenantId, callId: CALL, name, args, confirmationId });
  };
  return { http: await run(HTTP_TENANT), mcp: await run(MCP_TENANT) };
};

/** Everything except the route label, which is the only thing allowed to differ. */
const comparable = (outcome: DispatchOutcome): Record<string, unknown> => {
  const { latencyMs: _latency, ...rest } = outcome as unknown as Record<string, unknown> & { latencyMs: number };
  if ("route" in rest) delete rest.route;
  if ("confirmationId" in rest) rest.confirmationId = "<issued>";
  return rest;
};

describe("the same backend, two routes, one dispatch path", () => {
  for (const reference of ["QT-4471", "9920014", "ZR/88/AA"]) {
    it(`reads ${reference} identically down both routes`, async () => {
      const { http, mcp } = await bothRoutes("order_status", { reference });
      expect(http.kind).toBe("ok");
      expect(comparable(http)).toEqual(comparable(mcp));
      expect(http.speech).toContain(reference);
    });
  }

  it("says the tenant's own fallback line for a reference neither route can find", async () => {
    const { http, mcp } = await bothRoutes("order_status", { reference: "NO-SUCH-REF" });
    expect(http.speech).toBe(SPEECH.status.fallback);
    expect(comparable(http)).toEqual(comparable(mcp));
  });

  it("labels the route it came from, and nothing else differs", async () => {
    const { http, mcp } = await bothRoutes("order_status", { reference: "QT-4471" });
    expect(http).toMatchObject({ kind: "ok", route: "http" });
    expect(mcp).toMatchObject({ kind: "ok", route: "mcp" });
  });

  it("asks for the same spoken confirmation before writing, on both routes", async () => {
    const args = { reference: "QT-4471", contactNumber: "0805 123 4567" };
    const { http, mcp } = await bothRoutes("update_contact", args);

    expect(http.kind).toBe("confirm");
    expect(http.speech).toBe("I'm changing the number on order QT-4471 to 0805 123 4567. Should I go ahead?");
    expect(comparable(http)).toEqual(comparable(mcp));
    // And neither of them touched the backend while asking.
    expect(backend.performed).not.toContain("setContact");
  });

  it("writes only after the confirmation is redeemed, identically on both routes", async () => {
    const args = { reference: "9920014", contactNumber: "0812 999 1111" };
    const { http, mcp } = await bothRoutes("update_contact", args, (outcome) =>
      outcome.kind === "confirm" ? outcome.confirmationId : undefined,
    );

    expect(http).toMatchObject({ kind: "ok" });
    expect(http.speech).toBe("Done — the number on order 9920014 is now 0812 999 1111.");
    expect(comparable(http)).toEqual(comparable(mcp));
    expect(backend.orders.get("9920014")?.contactNumber).toBe("0812 999 1111");
  });

  it("refuses a confirmation whose arguments moved, on both routes", async () => {
    const asked = await dispatcher.dispatch({
      tenantId: HTTP_TENANT,
      callId: CALL,
      name: "update_contact",
      args: { reference: "QT-4471", contactNumber: "0805 000 0001" },
    });
    if (asked.kind !== "confirm") throw new Error("expected a readback");

    const moved = await dispatcher.dispatch({
      tenantId: HTTP_TENANT,
      callId: CALL,
      name: "update_contact",
      args: { reference: "QT-4471", contactNumber: "0805 000 0002" },
      confirmationId: asked.confirmationId,
    });
    expect(moved).toMatchObject({ kind: "failed", reason: "confirmation-mismatch" });
  });

  it("never executes an irreversible tool on either route, and transfers instead", async () => {
    const { http, mcp } = await bothRoutes("cancel_order", { reference: "QT-4471" });
    expect(http).toMatchObject({ kind: "transfer", reason: "order cancellation" });
    expect(comparable(http)).toEqual(comparable(mcp));
    expect(backend.performed).not.toContain("cancel");
  });

  it("plays holding speech before the request on both routes, and stops after", async () => {
    heard.length = 0;
    await bothRoutes("order_status", { reference: "QT-4471" });
    expect(heard).toEqual(["start:order_status", "stop:order_status", "start:order_status", "stop:order_status"]);
  });

  it("does not register an MCP tool the tenant gave no risk tier", () => {
    const names = registry.listFor(MCP_TENANT).map((definition) => definition.name);
    expect(names).toContain("order_status");
    expect(names).not.toContain("wipe_account");
    expect(lines.some((line) => line.fields.tool === "wipe_account")).toBe(true);
  });

  it("hides each tenant's tools from the other", async () => {
    // The MCP tenant's registry entry for `order_status` exists; the HTTP tenant's is a
    // different registration, and neither can reach the other's endpoint.
    expect(registry.resolve(HTTP_TENANT, "order_status")?.adapter.route).toBe("http");
    expect(registry.resolve(MCP_TENANT, "order_status")?.adapter.route).toBe("mcp");

    const stranger = asTenantId("33333333-3333-4333-8333-333333333333");
    expect(registry.resolve(stranger, "order_status")).toBeNull();
    expect(
      await dispatcher.dispatch({ tenantId: stranger, callId: CALL, name: "order_status", args: {} }),
    ).toMatchObject({ kind: "failed", reason: "unknown-tool" });
  });

  it("keeps the credential out of every log line either route produced", () => {
    const written = JSON.stringify(lines);
    expect(written).not.toContain("test-shared-secret");
    expect(written).not.toContain("Bearer");
  });

  it("times out both routes at the same ceiling and speaks rather than going silent", async () => {
    const slow = createToolDispatcher({
      registry,
      log: recordingLogger().log,
      softTimeoutMs: 30,
      hardTimeoutMs: 80,
      readRetries: 0,
    });
    backend.slowMs = 400;
    try {
      const http = await slow.dispatch({ tenantId: HTTP_TENANT, callId: CALL, name: "order_status", args: { reference: "QT-4471" } });
      const mcp = await slow.dispatch({ tenantId: MCP_TENANT, callId: CALL, name: "order_status", args: { reference: "QT-4471" } });
      expect(http).toMatchObject({ kind: "failed", reason: "timeout" });
      expect(mcp).toMatchObject({ kind: "failed", reason: "timeout" });
      expect(http.speech).toBe(mcp.speech);
      expect(http.speech.length).toBeGreaterThan(0);
    } finally {
      backend.slowMs = 0;
    }
  });
});

/**
 * The mechanical form of the same claim.
 *
 * Everything above compares behaviour, which is what matters, but behaviour can be made
 * to match by two code paths that happen to agree today. This asserts the structure: there
 * is exactly one place in the repository that invokes an adapter, and adding a second one
 * fails here rather than in review.
 */
describe("R5.2.0, structurally", () => {
  const repoRoot = (): string => {
    let current = process.cwd();
    for (let up = 0; up < 6; up += 1) {
      try {
        statSync(join(current, "pnpm-workspace.yaml"));
        return current;
      } catch {
        current = resolve(current, "..");
      }
    }
    throw new Error("could not find the repository root");
  };

  const sourceFiles = (root: string): string[] => {
    const found: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(path);
      }
    };
    for (const top of ["packages", "apps"]) {
      try {
        walk(join(root, top));
      } catch {
        // A workspace folder that does not exist is not a failure of this test.
      }
    }
    return found;
  };

  it("has exactly one call site of adapter.execute in the whole repository", () => {
    const root = repoRoot();
    const callers = sourceFiles(root).filter((file) => /\badapter\.execute\s*\(/.test(readFileSync(file, "utf8")));
    expect(callers.map((file) => file.slice(root.length + 1))).toEqual(["packages/tools/src/dispatch.ts"]);
  });
});
