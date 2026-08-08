import type { Logger, TenantId } from "@ansa/shared";

import type { ToolRegistry } from "../registry";
import type { ToolAdapter, ToolArgs, ToolDefinition } from "../types";

import type { McpServerConfig, McpToolPolicy } from "./config";
import { renderTemplate } from "./template";
import type { Transport } from "./transport";
import type { CredentialVault } from "./vault";

/**
 * Route B: the tenant already runs an MCP server, so we speak MCP to it.
 *
 * Secondary to the HTTP connector by design — most organisations have a REST API and have
 * never heard of MCP — and structurally identical to it where it counts: it is an adapter
 * over the same guarded transport, its tools land in the same registry, and the dispatcher
 * cannot tell which route a tool came from.
 *
 * The protocol is spoken directly. It is JSON-RPC 2.0 over HTTP POST with an optional
 * server-sent-events response, and that is a hundred lines; an SDK would be a new
 * dependency, a second HTTP client that does not know about the egress guard, and a second
 * place where a redirect is followed. Speaking it here keeps every request on the one
 * transport that is guarded.
 */

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "ansa";

/** Off the call path: discovery runs when a tenant's configuration is loaded. */
const DISCOVERY_TIMEOUT_MS = 10_000;

interface JsonRpcResponse {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

const isResponse = (value: unknown): value is JsonRpcResponse =>
  value !== null && typeof value === "object";

/**
 * A Streamable HTTP response is either one JSON object or an SSE stream carrying it.
 *
 * Both are legal for the same request, the server picks, and a client that only handles
 * the first works against half the servers in existence.
 */
const messageFor = (id: number, contentType: string, body: string): JsonRpcResponse => {
  if (!contentType.includes("text/event-stream")) {
    const parsed: unknown = JSON.parse(body);
    if (!isResponse(parsed)) throw new Error("mcp: response was not a JSON-RPC message");
    return parsed;
  }

  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (data === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (isResponse(parsed) && parsed.id === id) return parsed;
  }
  throw new Error(`mcp: no reply to request ${id} in the event stream`);
};

interface McpClientOptions {
  readonly tenantId: TenantId;
  readonly server: McpServerConfig;
  readonly transport: Transport;
  readonly vault: CredentialVault;
}

interface DiscoveredTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** What the adapter hands to `summarise`: the words, and the data behind them. */
interface McpResult {
  readonly text: string | null;
  readonly data: unknown;
}

const createMcpClient = (options: McpClientOptions) => {
  const { server } = options;
  let nextId = 1;
  let sessionId: string | null = null;
  let initialized: Promise<void> | null = null;

  const headers = async (): Promise<Record<string, string>> => {
    const base: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (sessionId !== null) base["mcp-session-id"] = sessionId;
    if (server.credentialRef !== undefined) {
      const credential = await options.vault.resolve(options.tenantId, server.credentialRef);
      if (credential === null) throw new Error(`no credential named ${server.credentialRef} for this tenant`);
      credential.applyTo(base);
    }
    return base;
  };

  const post = async (payload: Record<string, unknown>, signal: AbortSignal) => {
    const body = JSON.stringify(payload);
    const sent = await headers();
    sent["content-length"] = String(Buffer.byteLength(body));
    return options.transport.send({ url: server.url, method: "POST", headers: sent, body, signal });
  };

  const call = async (method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    const id = nextId;
    nextId += 1;
    const response = await post({ jsonrpc: "2.0", id, method, params }, signal);
    if (response.status >= 400) throw new Error(`mcp server returned ${response.status}`);

    const session = response.headers["mcp-session-id"];
    if (session !== undefined && session !== "") sessionId = session;

    const message = messageFor(id, response.headers["content-type"] ?? "", response.body);
    if (message.error !== undefined) {
      throw new Error(`mcp error: ${message.error.message ?? String(message.error.code ?? "unknown")}`);
    }
    return message.result;
  };

  const handshake = async (signal: AbortSignal): Promise<void> => {
    await call(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: "1" },
      },
      signal,
    );
    // Fire and forget by the protocol's own rules: a notification has no id and no reply,
    // and a server that answers it with an error must not stop the tool list loading.
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal).catch(() => undefined);
  };

  /**
   * The handshake happens once per server and is shared by every later request.
   *
   * Stored as the promise rather than a boolean so two tool calls arriving together do
   * not both initialize — which on a session-based server would leave one of them
   * quoting a session id the server has already replaced.
   */
  const ready = async (signal: AbortSignal): Promise<void> => {
    initialized ??= handshake(signal).catch((error: unknown) => {
      initialized = null;
      throw error;
    });
    return initialized;
  };

  return {
    async listTools(signal: AbortSignal): Promise<readonly DiscoveredTool[]> {
      await ready(signal);
      const result = await call("tools/list", {}, signal);
      const raw = (result as { tools?: unknown } | null)?.tools;
      if (!Array.isArray(raw)) throw new Error("mcp: tools/list did not return a tool list");

      const tools: DiscoveredTool[] = [];
      for (const entry of raw) {
        if (entry === null || typeof entry !== "object") continue;
        const tool = entry as Record<string, unknown>;
        const name = typeof tool.name === "string" ? tool.name : "";
        if (name === "") continue;
        const schema = tool.inputSchema;
        tools.push({
          name,
          description: typeof tool.description === "string" && tool.description.trim() !== ""
            ? tool.description
            : name,
          parameters:
            schema !== null && typeof schema === "object" && !Array.isArray(schema)
              ? (schema as Record<string, unknown>)
              : { type: "object" },
        });
      }
      return tools;
    },

    async callTool(name: string, args: ToolArgs, signal: AbortSignal): Promise<McpResult> {
      await ready(signal);
      const result = await call("tools/call", { name, arguments: args }, signal);
      const raw = (result ?? {}) as Record<string, unknown>;

      const content = Array.isArray(raw.content) ? raw.content : [];
      const text = content
        .map((block) =>
          block !== null && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
            ? (block as { text: string }).text
            : "",
        )
        .filter((part) => part !== "")
        .join(" ")
        .trim();

      // The server's own error channel. Not an HTTP status and not a JSON-RPC error: a
      // tool that failed reports it here, and treating it as success is exactly the
      // "narrated a success it never got" failure.
      if (raw.isError === true) throw new Error(text === "" ? "mcp tool reported an error" : text);

      let data: unknown = raw.structuredContent ?? null;
      if (data === null && text !== "") {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      return { text: text === "" ? null : text, data };
    },
  };
};

const speak = (policy: McpToolPolicy, result: unknown): string => {
  const { text, data } = (result ?? { text: null, data: null }) as McpResult;
  const speech = policy.speech;
  if (speech !== undefined) return renderTemplate(speech.template, data ?? {}) ?? speech.fallback;
  // No template configured, which is the common case: an MCP tool returns text meant to
  // be read. If that text is actually JSON the dispatcher refuses it (R5.4.3) and the
  // caller hears an apology rather than a brace.
  if (text !== null) return text;
  throw new Error("mcp tool returned nothing sayable");
};

const definitionFor = (
  policy: McpToolPolicy,
  discovered: DiscoveredTool,
  tenantId: TenantId,
): ToolDefinition => {
  const base = {
    name: discovered.name,
    description: discovered.description,
    parameters: discovered.parameters,
    tenantId,
    timeoutMs: policy.timeoutMs,
    identifiers: policy.identifiers,
  };

  if (policy.riskTier === "irreversible") {
    return { ...base, riskTier: "irreversible", transferReason: policy.transferReason ?? "not permitted" };
  }
  if (policy.riskTier === "write") {
    const template = policy.readback ?? "";
    return {
      ...base,
      riskTier: "write",
      readback: (args) => {
        const spoken = renderTemplate(template, args);
        if (spoken === null) throw new Error("readback could not be rendered from these arguments");
        return spoken;
      },
      summarise: (result) => speak(policy, result),
    };
  }
  return { ...base, riskTier: "read", summarise: (result) => speak(policy, result) };
};

export interface McpConnectorOptions {
  readonly tenantId: TenantId;
  readonly transport: Transport;
  readonly vault: CredentialVault;
  readonly log: Logger;
  readonly discoveryTimeoutMs?: number;
}

export interface PreparedServer {
  /** What the model will be offered. Read by the prompt as well as by registration. */
  readonly definitions: readonly ToolDefinition[];
  register(registry: ToolRegistry): void;
}

/**
 * Discover a tenant's MCP tools and prepare the ones they assigned a tier to.
 *
 * Discovery and registration are split because they happen at different times: discovery
 * runs once, when the tenant's configuration is loaded, and registration runs per call
 * into that call's own registry. An MCP handshake on the answer path would be paid for by
 * the caller, in silence.
 *
 * The client is shared across calls along with the discovery, which is what it is for —
 * one handshake, one session, a warm socket.
 *
 * A discovered tool with no configured tier is skipped and logged. Registering it with a
 * default would be the platform deciding, on the tenant's behalf, that an unknown tool is
 * safe to run without confirmation — and the first time that guess is wrong it is a
 * cancellation nobody agreed to.
 */
export const prepareMcpServer = async (
  server: McpServerConfig,
  options: McpConnectorOptions,
): Promise<PreparedServer> => {
  const client = createMcpClient({
    tenantId: options.tenantId,
    server,
    transport: options.transport,
    vault: options.vault,
  });

  const discovered = await client.listTools(
    AbortSignal.timeout(options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS),
  );
  const byName = new Map(discovered.map((tool) => [tool.name, tool]));

  const adapter: ToolAdapter = {
    route: "mcp",
    execute: async (call) => {
      if (call.tenantId !== options.tenantId) throw new Error("tool dispatched for the wrong tenant");
      return client.callTool(call.name, call.args, call.signal);
    },
  };

  const definitions: ToolDefinition[] = [];
  for (const policy of server.tools) {
    const tool = byName.get(policy.name);
    if (tool === undefined) {
      options.log.warn("configured mcp tool is not offered by the server", {
        tenantId: options.tenantId,
        tool: policy.name,
      });
      continue;
    }
    definitions.push(definitionFor(policy, tool, options.tenantId));
  }

  const configured = new Set(server.tools.map((policy) => policy.name));
  for (const tool of discovered) {
    if (!configured.has(tool.name)) {
      options.log.info("mcp tool offered but not registered — no risk tier configured", {
        tenantId: options.tenantId,
        tool: tool.name,
      });
    }
  }

  return {
    definitions,
    register: (registry) => {
      for (const definition of definitions) registry.register(definition, adapter);
    },
  };
};
