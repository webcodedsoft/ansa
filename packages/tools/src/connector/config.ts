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
  /**
   * Where the model's arguments go — the ones the URL has not already taken.
   *
   * Orthogonal to path parameters, because REST is: `POST /policies/{id}/claims` puts one
   * argument in the path and the rest in the body, and a model that made those exclusive
   * would not be able to describe half the endpoints organisations actually have.
   */
  readonly send: "query" | "body";
  /**
   * Arguments the URL consumes, in order, from `{placeholders}` anywhere after the host.
   *
   * Named for the URL rather than the path because both work: `/policies/{id}` and
   * `?regNo={id}` are each filled from an argument and each consumed, so neither is sent
   * again in the query or body. Only the origin is off limits — see `parseUrlParams`.
   *
   * Derived at parse time rather than configured, so the URL is the single statement of
   * what it looks like. Held here so the adapter does not re-scan the string on every call.
   */
  readonly urlParams: readonly string[];
  /**
   * Static headers sent with every request. Never a credential — see `parseHeaders`.
   *
   * Values are fixed strings, not templates. A header carrying the caller's own details is
   * a different feature with a different threat model, and inventing it here would mean
   * caller data leaving in a place nothing audits.
   */
  readonly headers?: Readonly<Record<string, string>>;
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

/**
 * Headers a organization may not set, because the vault owns them.
 *
 * Not a style rule. A static `Authorization: Bearer sk-live-…` would put a plaintext
 * credential in the tool document, and `GET /tools` returns that document — so the secret
 * would be readable by anyone who can read the configuration, which is the exact thing
 * `credentialRef` exists to prevent. Refused rather than warned about: a warning next to a
 * text box that still accepts the value is not a control.
 */
/** Same shape `templateFields` matches, as a fresh regex because that one is stateful. */
const PATH_PLACEHOLDER = /\{[A-Za-z0-9_.[\]-]+\}/g;

const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
]);

/**
 * Headers the transport owns, refused for a different reason than the credential ones.
 *
 * Nothing an operator writes here can improve the request and one of them can stop it: a
 * `Content-Length` on a tool that sends no body leaves the organisation's server waiting
 * for bytes that never arrive, which spends the caller's whole three seconds and ends in
 * the timeout apology. `Host` is overwritten by the transport anyway, so accepting it only
 * teaches somebody that it works.
 */
const TRANSPORT_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "expect",
  "upgrade",
]);

/** RFC 7230 token characters, minus the exotica nobody needs and proxies mangle. */
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

const parseHeaders = (
  raw: unknown,
  where: string,
): Readonly<Record<string, string>> | undefined => {
  if (raw === undefined || raw === null) return undefined;
  const record = asRecord(raw, `${where}.headers`);
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(record)) {
    if (!HEADER_NAME.test(name)) {
      throw new Error(`tool config: ${where}.headers has an unusable name ${JSON.stringify(name)}`);
    }
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new Error(
        `tool config: ${where}.headers cannot set ${name} — authentication belongs in the ` +
          "credential vault, and a header here would store the secret in the configuration",
      );
    }
    if (TRANSPORT_HEADERS.has(name.toLowerCase())) {
      throw new Error(
        `tool config: ${where}.headers cannot set ${name} — the transport decides how the ` +
          "request is framed, and a value here can only break it",
      );
    }
    if (typeof value !== "string") {
      throw new Error(`tool config: ${where}.headers.${name} must be a string`);
    }
    // A newline in a value splits one header into two at the socket, which is how a
    // response gets forged. The transport would likely refuse it; refusing here means it
    // never reaches a call in the first place.
    if (/[\r\n]/.test(value)) {
      throw new Error(`tool config: ${where}.headers.${name} cannot contain a line break`);
    }
    if (value.length > 1024) {
      throw new Error(`tool config: ${where}.headers.${name} is too long`);
    }
    out[name] = value;
  }

  return Object.keys(out).length === 0 ? undefined : out;
};

/**
 * Where the origin stops: the first `/`, `?` or `#` after the scheme.
 *
 * Measured on the URL as written, because a copy with the placeholders blanked out cannot be
 * indexed back. Comparing the first blank's position against `origin.length` looked
 * equivalent and was not: `https://api_test.partner.test/x/{id}` blanks to a string whose
 * first `_` sits inside the *host*, so an ordinary tool was refused — and a refusal here
 * throws the whole parse, which costs the organisation every other tool in the document.
 */
const originEnd = (url: string): number => {
  const scheme = url.indexOf("://");
  if (scheme === -1) return url.length;
  const stop = url.slice(scheme + 3).search(/[/?#]/);
  return stop === -1 ? url.length : scheme + 3 + stop;
};

/**
 * The `{placeholders}` a URL will consume, refusing any that could move the request.
 *
 * The rule that matters: a placeholder may appear anywhere after the origin, and nowhere
 * inside it. The path and the query string both qualify — `/policies/{id}` and `?regNo={id}`
 * are equally ordinary in the APIs organisations actually have.
 *
 * `https://{host}/x` would let an argument chosen by the model — from words a caller said —
 * decide which server we talk to, while the egress allowlist went on checking the host that
 * was configured. That is an SSRF with extra steps, and it is refused at parse time rather
 * than guarded at send time.
 */
const parseUrlParams = (url: string, where: string): readonly string[] => {
  const names = templateFields(url);
  if (names.length === 0) return [];

  // Blanked only to answer "is this a URL at all". A placeholder in the scheme or the port
  // fails here rather than below, because neither `_://host` nor `host:_` parses.
  try {
    new URL(url.replace(PATH_PLACEHOLDER, "_"));
  } catch {
    throw new Error(`tool config: ${where}.url is not a URL`);
  }

  const host = originEnd(url);
  const fragment = url.indexOf("#");
  for (const match of url.matchAll(PATH_PLACEHOLDER)) {
    const at = match.index ?? 0;
    if (at < host) {
      throw new Error(
        `tool config: ${where}.url may only use {placeholders} after the host — one in the ` +
          "scheme, host or port would let an argument choose which server is called",
      );
    }
    // The fragment never leaves the client, so a placeholder there is filled, consumed, and
    // then dropped by the transport — the endpoint is called without the argument at all
    // and answers about the wrong thing rather than failing.
    if (fragment !== -1 && at > fragment) {
      throw new Error(
        `tool config: ${where}.url has a {placeholder} after the #, which is never sent to ` +
          "the server — the argument would be used up and then disappear",
      );
    }
  }

  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`tool config: ${where}.url has an unusable placeholder {${name}}`);
    }
  }
  return names;
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

  const url = asText(raw.url, `${where}.url`);
  const urlParams = parseUrlParams(url, where);

  return {
    route: "http",
    name,
    description: asText(raw.description, `${where}.description`),
    parameters: asRecord(raw.parameters, `${where}.parameters`),
    urlParams,
    riskTier: tier,
    timeoutMs: asTimeout(raw.timeoutMs, where),
    url,
    method: method as HttpToolConfig["method"],
    send,
    headers: parseHeaders(raw.headers, where),
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
