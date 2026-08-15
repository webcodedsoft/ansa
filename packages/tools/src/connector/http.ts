import type { Logger, OrganizationId } from "@ansa/shared";

import type { ToolRegistry } from "../registry";
import type { AdapterCall, ToolAdapter, ToolArgs, ToolDefinition } from "../types";

import type { HttpToolConfig } from "./config";
import { renderTemplate } from "./template";
import type { Transport } from "./transport";
import type { CredentialVault } from "./vault";

/**
 * Route A, and the route that matters: the organisation hosts an API and we are the
 * client.
 *
 * This file is an adapter and nothing else. It does not enforce a risk tier, does not
 * time itself out, does not start holding speech, does not decide when to retry and does
 * not log the invocation — all of that is in `dispatch.ts` and is already true of every
 * other route. What is here is the part that is genuinely specific to speaking HTTP to a
 * server we did not write: where the arguments go, which header carries the credential,
 * and what a status code means.
 */

export interface HttpConnectorOptions {
  readonly organizationId: OrganizationId;
  readonly transport: Transport;
  readonly vault: CredentialVault;
  readonly log: Logger;
}

/** Scalars only. An object in a query string is somebody's `[object Object]` bug. */
const queryValue = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
};

const withQuery = (url: string, args: ToolArgs): string => {
  const target = new URL(url);
  for (const [key, value] of Object.entries(args)) {
    const text = queryValue(value);
    if (text !== null) target.searchParams.set(key, text);
  }
  return target.toString();
};

/**
 * What the response means.
 *
 * 404 is null rather than an error on purpose: "we looked and there is no such record" is
 * an answer, and the organization already wrote the sentence for it as `speech.fallback`. An
 * error would instead produce "sorry, I couldn't get that just now", which tells the
 * caller the system is broken when in fact it worked.
 */
const parseBody = (body: string, status: number): unknown => {
  if (status === 404) return null;
  const text = body.trim();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`endpoint returned ${status} with a body that is not JSON`);
  }
};

const execute = async (
  config: HttpToolConfig,
  options: HttpConnectorOptions,
  call: AdapterCall,
): Promise<unknown> => {
  const headers: Record<string, string> = { accept: "application/json" };
  let body: string | undefined;
  let url = config.url;

  if (config.send === "query") {
    url = withQuery(url, call.args);
  } else {
    body = JSON.stringify(call.args);
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(body));
  }

  if (config.credentialRef !== undefined) {
    const credential = await options.vault.resolve(call.organizationId, config.credentialRef);
    if (credential === null) {
      // Refused rather than sent unauthenticated. An anonymous request to somebody's
      // customer API is either rejected — a confusing failure — or, far worse, accepted.
      throw new Error(`no credential named ${config.credentialRef} for this organization`);
    }
    credential.applyTo(headers);
  }

  const response = await options.transport.send({
    url,
    method: config.method,
    headers,
    body,
    signal: call.signal,
  });

  // Host and path only. The query string carries the model's arguments, which are the
  // caller's own details, and this line is written on every successful call.
  const target = new URL(url);
  options.log.debug("connector responded", {
    organizationId: call.organizationId,
    callId: call.callId,
    tool: call.name,
    endpoint: `${target.host}${target.pathname}`,
    status: response.status,
  });

  if (response.status >= 400 && response.status !== 404) {
    // The status and nothing else. A organization's error body routinely quotes the request
    // back, credential header included, and this string ends up in a log line.
    throw new Error(`endpoint returned ${response.status}`);
  }

  return parseBody(response.body, response.status);
};

const speak = (config: HttpToolConfig, result: unknown): string => {
  const speech = config.speech;
  // Registration refuses a read or write tool without speech, so this is defence rather
  // than a branch anybody reaches.
  if (speech === undefined) throw new Error(`${config.name} has no speech template`);
  return renderTemplate(speech.template, result) ?? speech.fallback;
};

const definitionFor = (config: HttpToolConfig, organizationId: OrganizationId): ToolDefinition => {
  const base = {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    organizationId,
    timeoutMs: config.timeoutMs,
    identifiers: config.identifiers,
  };

  if (config.riskTier === "irreversible") {
    return { ...base, riskTier: "irreversible", transferReason: config.transferReason ?? "not permitted" };
  }
  if (config.riskTier === "write") {
    const template = config.readback ?? "";
    return {
      ...base,
      riskTier: "write",
      readback: (args) => {
        const spoken = renderTemplate(template, args);
        // Throwing is right. The dispatcher turns it into an apology and the write does
        // not fire — a write whose readback could not be rendered is a write the caller
        // was never actually read, and firing it would be the R4.3.1 violation.
        if (spoken === null) throw new Error("readback could not be rendered from these arguments");
        return spoken;
      },
      summarise: (result) => speak(config, result),
    };
  }
  return { ...base, riskTier: "read", summarise: (result) => speak(config, result) };
};

/**
 * One adapter for all of a organization's HTTP tools, into the same registry the platform tools
 * use (R5.2.0).
 *
 * The organization check inside `execute` is not decoration. The registry already scopes
 * resolution by organization, so a mismatch here should be impossible; CLAUDE.md rule 3 is about
 * the query that *could* return another organization's row, and this is the last place before
 * the request leaves the building.
 */
export const registerHttpTools = (
  registry: ToolRegistry,
  tools: readonly HttpToolConfig[],
  options: HttpConnectorOptions,
): void => {
  if (tools.length === 0) return;
  const byName = new Map(tools.map((config) => [config.name, config]));

  const adapter: ToolAdapter = {
    route: "http",
    execute: async (call) => {
      if (call.organizationId !== options.organizationId) {
        throw new Error("tool dispatched for the wrong organization");
      }
      const config = byName.get(call.name);
      if (config === undefined) throw new Error(`no http connector named ${call.name}`);
      return execute(config, options, call);
    },
  };

  for (const config of tools) registry.register(definitionFor(config, options.organizationId), adapter);
};
