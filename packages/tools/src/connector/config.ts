import type { RiskTier } from "../types";

import { isHostAllowed, type EgressPolicy } from "./egress";
import { templateFields } from "./template";

/**
 * What an organisation writes down to give the agent one of its own tools.
 *
 * The important thing about this file is that it describes *configuration*, not code. An
 * organisation hosts the API; we are the client. That is true of the HTTP route and it is
 * equally true of MCP — the two are transports, not categories, and nothing downstream of
 * registration can tell them apart. The real axis in this codebase is platform-owned
 * (`internal/`, tools that act on the call itself and have no endpoint behind them) versus
 * organization-supplied (here, tools that are somebody else's server).
 *
 * Everything on the way in is validated, because everything on the way in was typed by
 * somebody who does not work here.
 */

export interface SpeechConfig {
  /** A sentence with `{dotted.path}` holes, filled from the response. */
  readonly template: string;
  /** Spoken when a hole cannot be filled — most often "no such record". */
  readonly fallback: string;
}

interface ConnectorToolBase {
  readonly name: string;
  readonly description: string;
  /** JSON Schema, passed to the model untouched and never interpreted here. */
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly riskTier: RiskTier;
  readonly timeoutMs?: number;
  /** Required for read and write. Absent on irreversible, which never returns anything. */
  readonly speech?: SpeechConfig;
  /** R4.3.1, as a template over the arguments. Required for write. */
  readonly readback?: string;
  /** Required for irreversible: what the human who picks up is told. */
  readonly transferReason?: string;
  /**
   * Arguments that identify a person, mapped to the call fact each must match — for
   * example `{ "policyNumber": "policyNumber" }`.
   *
   * Optional, and a organization who omits it gets a tool that will look anybody up by whatever
   * the transcriber heard. That is the right default for a tool keyed on something that
   * is not a person (an order reference the caller reads out, a branch, a product) and
   * the wrong one for anything keyed on who is calling.
   */
  readonly identifiers?: Readonly<Record<string, string>>;
}

export interface HttpToolConfig extends ConnectorToolBase {
  readonly route: "http";
  readonly url: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Where the model's arguments go. */
  readonly send: "query" | "body";
  /** A name in the organization's credential vault. Never the credential itself. */
  readonly credentialRef?: string;
}

/**
 * One tool on a organization's MCP server.
 *
 * The name, description and schema come from discovery; the risk tier does not, and
 * cannot. A server telling us which of its own tools are safe to run without confirmation
 * is the server marking its own homework, and `cancel_policy` would arrive as `read` the
 * first time somebody got it wrong. A discovered tool with no tier configured here is not
 * registered at all.
 */
export interface McpToolPolicy {
  readonly name: string;
  readonly riskTier: RiskTier;
  readonly timeoutMs?: number;
  /** Optional: MCP results are text already, so the default summary is that text. */
  readonly speech?: SpeechConfig;
  readonly readback?: string;
  readonly transferReason?: string;
  /** Same meaning as on an HTTP tool: R5.2.0 does not admit a control on one route only. */
  readonly identifiers?: Readonly<Record<string, string>>;
}

export interface McpServerConfig {
  readonly route: "mcp";
  readonly url: string;
  readonly credentialRef?: string;
  readonly tools: readonly McpToolPolicy[];
}

export interface ConnectorConfig {
  /** R5.2.2. Hosts this organization may be pointed at, and nothing else. */
  readonly egress: EgressPolicy;
  readonly http: readonly HttpToolConfig[];
  readonly mcp: readonly McpServerConfig[];
}

const EMPTY_CONNECTOR_CONFIG: ConnectorConfig = { egress: { allowedHosts: [] }, http: [], mcp: [] };

const TIERS: ReadonlySet<string> = new Set<RiskTier>(["read", "write", "irreversible"]);
const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const asRecord = (value: unknown, where: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`tool config: ${where} must be an object`);
  }
  return value as Record<string, unknown>;
};

const asText = (value: unknown, where: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`tool config: ${where} must be a non-empty string`);
  }
  return value.trim();
};

const asOptionalText = (value: unknown, where: string): string | undefined =>
  value === undefined || value === null ? undefined : asText(value, where);

const asSpeech = (value: unknown, where: string): SpeechConfig => {
  const raw = asRecord(value, where);
  const template = asText(raw.template, `${where}.template`);
  const fallback = asText(raw.fallback, `${where}.fallback`);
  if (templateFields(template).length === 0) {
    // A template with no holes is a constant, which means the agent says the same
    // sentence whatever the endpoint returned — a confident answer to a question nobody
    // looked up. That is the failure this whole slice exists to end.
    throw new Error(`tool config: ${where}.template has no {placeholders}; it would say the same thing every time`);
  }
  return { template, fallback };
};

const asIdentifiers = (value: unknown, where: string): Readonly<Record<string, string>> | undefined => {
  if (value === undefined || value === null) return undefined;
  const raw = asRecord(value, `${where}.identifiers`);
  return Object.fromEntries(
    Object.entries(raw).map(([argument, fact]) => [
      asText(argument, `${where}.identifiers key`),
      asText(fact, `${where}.identifiers.${argument}`),
    ]),
  );
};

const asTier = (value: unknown, where: string): RiskTier => {
  if (typeof value !== "string" || !TIERS.has(value)) {
    throw new Error(`tool config: ${where}.riskTier must be read, write or irreversible (R5.3)`);
  }
  return value as RiskTier;
};

const asTimeout = (value: unknown, where: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`tool config: ${where}.timeoutMs must be a positive number`);
  }
  return value;
};

/**
 * The tier-shaped requirements, applied identically to both routes.
 *
 * This is R5.2.0 at the configuration layer: if the HTTP route demanded a readback and the
 * MCP route did not, the abstraction would already be broken before either adapter ran.
 */
const tierFields = (
  raw: Record<string, unknown>,
  tier: RiskTier,
  where: string,
  speechRequired: boolean,
): { speech?: SpeechConfig; readback?: string; transferReason?: string } => {
  if (tier === "irreversible") {
    return { transferReason: asText(raw.transferReason, `${where}.transferReason`) };
  }

  const speech =
    raw.speech === undefined || raw.speech === null
      ? undefined
      : asSpeech(raw.speech, `${where}.speech`);
  if (speechRequired && speech === undefined) {
    throw new Error(`tool config: ${where}.speech is required — raw JSON is never spoken (R5.4.3)`);
  }

  if (tier === "write") {
    const readback = asText(raw.readback, `${where}.readback`);
    if (templateFields(readback).length === 0) {
      throw new Error(
        `tool config: ${where}.readback must quote the caller's own values back with {placeholders} (R4.3.1)`,
      );
    }
    return { speech, readback };
  }
  return { speech };
};

const parseHttpTool = (value: unknown, index: number): HttpToolConfig => {
  const where = `http[${index}]`;
  const raw = asRecord(value, where);
  const name = asText(raw.name, `${where}.name`);
  const tier = asTier(raw.riskTier, where);

  const method = asText(raw.method, `${where}.method`).toUpperCase();
  if (!METHODS.has(method)) throw new Error(`tool config: ${where}.method ${method} is not supported`);

  const send = asText(raw.send, `${where}.send`);
  if (send !== "query" && send !== "body") {
    throw new Error(`tool config: ${where}.send must be query or body`);
  }
  if (send === "body" && method === "GET") {
    throw new Error(`tool config: ${where} cannot send a body on a GET`);
  }

  return {
    route: "http",
    name,
    description: asText(raw.description, `${where}.description`),
    parameters: asRecord(raw.parameters, `${where}.parameters`),
    riskTier: tier,
    timeoutMs: asTimeout(raw.timeoutMs, where),
    url: asText(raw.url, `${where}.url`),
    method: method as HttpToolConfig["method"],
    send,
    credentialRef: asOptionalText(raw.credentialRef, `${where}.credentialRef`),
    identifiers: asIdentifiers(raw.identifiers, where),
    ...tierFields(raw, tier, where, true),
  };
};

const parseMcpServer = (value: unknown, index: number): McpServerConfig => {
  const where = `mcp[${index}]`;
  const raw = asRecord(value, where);
  const tools = raw.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(`tool config: ${where}.tools must list the tools to register, with a tier for each`);
  }

  return {
    route: "mcp",
    url: asText(raw.url, `${where}.url`),
    credentialRef: asOptionalText(raw.credentialRef, `${where}.credentialRef`),
    tools: tools.map((entry, toolIndex): McpToolPolicy => {
      const toolWhere = `${where}.tools[${toolIndex}]`;
      const toolRaw = asRecord(entry, toolWhere);
      const tier = asTier(toolRaw.riskTier, toolWhere);
      return {
        name: asText(toolRaw.name, `${toolWhere}.name`),
        riskTier: tier,
        timeoutMs: asTimeout(toolRaw.timeoutMs, toolWhere),
        identifiers: asIdentifiers(toolRaw.identifiers, toolWhere),
        ...tierFields(toolRaw, tier, toolWhere, false),
      };
    }),
  };
};

/**
 * A declared URL has to sit inside the allowlist declared beside it.
 *
 * Shared by tool configuration and event configuration, which have the same shape and the
 * same mistake available to them.
 */
export const requireAllowed = (url: string, egress: EgressPolicy, where: string): void => {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // The parsers above already rejected a malformed URL; reaching here means one got past
    // them, and refusing is the safe direction.
    throw new Error(`${where} is not a URL`);
  }
  if (!isHostAllowed(host, egress.allowedHosts)) {
    throw new Error(
      `${where} points at ${host}, which egress.allowedHosts does not cover — ` +
        "the request would be refused on every call",
    );
  }
};

/**
 * Configuration as stored, turned into configuration this package will act on.
 *
 * Throws rather than dropping the bad entry. A tool that silently fails to register is a
 * organization wondering why the agent says it cannot check something they configured last week,
 * and the error belongs at publication time where somebody is looking at a screen.
 */
export const parseConnectorConfig = (value: unknown): ConnectorConfig => {
  if (value === undefined || value === null) return EMPTY_CONNECTOR_CONFIG;
  const raw = asRecord(value, "tool config");

  const egressRaw = raw.egress === undefined ? {} : asRecord(raw.egress, "tool config.egress");
  const hosts = egressRaw.allowedHosts;
  if (hosts !== undefined && !Array.isArray(hosts)) {
    throw new Error("tool config: egress.allowedHosts must be an array of hostnames");
  }

  const http = raw.http === undefined ? [] : raw.http;
  const mcp = raw.mcp === undefined ? [] : raw.mcp;
  if (!Array.isArray(http)) throw new Error("tool config: http must be an array");
  if (!Array.isArray(mcp)) throw new Error("tool config: mcp must be an array");

  const egress: EgressPolicy = {
    allowedHosts: (hosts ?? []).map((host, index) => asText(host, `egress.allowedHosts[${index}]`)),
    allowPlaintextHttp: egressRaw.allowPlaintextHttp === true,
  };

  const parsed: ConnectorConfig = {
    egress,
    http: http.map(parseHttpTool),
    mcp: mcp.map(parseMcpServer),
  };

  /**
   * A URL the same organization's allowlist does not cover.
   *
   * The guard already refuses this at request time and always will — it is the boundary and
   * this is not. What it cannot do is tell anybody *before* a caller hits it: the tool
   * registers, the model is told it can look the thing up, and every attempt comes back as
   * "sorry, I couldn't get that just now". Two lines of configuration disagreeing with each
   * other is a publication-time error, and this is the only place both are in scope.
   */
  for (const tool of parsed.http) {
    requireAllowed(tool.url, egress, `tool config.http[${tool.name}].url`);
  }
  for (const [index, server] of parsed.mcp.entries()) {
    requireAllowed(server.url, egress, `tool config.mcp[${index}].url`);
  }

  return parsed;
};
