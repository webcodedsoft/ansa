import { HARD_TIMEOUT_MS, parseConnectorConfig, type ConnectorConfig } from "@ansa/tools";
import {
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Put,
  UnprocessableEntityException,
} from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import { apiRoute, FromBody } from "../http/request";
import { choice, flag, integer, list, object, optional, text, type Infer } from "../http/schema";
import { TenantContext } from "../tenancy/tenant-context";

import { checkToolConfig, eventsOrNothing, orConflict, orRefuse } from "./refusals";
import { publishConfiguration, readConfiguration, sealedCredentials } from "./store";
import { classifyCredentials, credentialUses, refuseUnusableReferences, vaultKey } from "./vault";

/**
 * An organisation pointing the agent at its own systems.
 *
 * This is the endpoint that can hurt a caller. Everything else in the dashboard changes
 * what somebody reads on a screen; this changes what the agent is willing to do in the
 * middle of a phone call, over a three-second budget, against a server we do not run. So
 * the shape of the file is: describe the document, hand it to `@ansa/tools`, and store what
 * comes back. There is no rule enforced here that the dispatch path does not enforce again
 * — see `refusals.ts` for why that is the whole design rather than a shortcut.
 *
 * **Whole document, never a patch.** `PUT` replaces the tool configuration entirely, which
 * is what `tools/tenant/config.mjs publish` already does and for the same reason: a publish
 * that silently inherited half its values from the last one would make the version history
 * unreadable, and `config_version` is recorded on every call precisely so a call from three
 * weeks ago can be explained (R7.5). `expectedVersion` is how two people editing at once
 * find out, rather than one of them losing their change.
 *
 * **`credentialRef` is a name, not a secret**, and it appears in every response here. The
 * value behind it is in `credentials.controller.ts` and comes back out of nothing.
 */

/** Lower snake case, as `registry.register` insists. Stated here so the spec says it too. */
const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;

/** The shape migration 0013's CHECK constraint puts on a credential name. */
const CREDENTIAL_REF = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Generous, and deliberately the same bounds on the way in and on the way out.
 *
 * The response is projected through this schema too, so a value already in the column that
 * exceeds one of these makes `GET` fail loudly rather than silently truncate. Nothing
 * written through this endpoint can get there; a document written by
 * `tools/tenant/config.mjs` could, which is why the ceilings are far above anything a
 * sentence, a URL or a tool schema needs.
 */
const MAX_DESCRIPTION = 2000;
const MAX_SENTENCE = 1000;
const MAX_URL = 2048;
const MAX_SCHEMA_JSON = 20_000;
const MAX_HOST = 253;

const identifier = object({
  /** The argument name the model uses. */
  argument: text({ minLength: 1, maxLength: 100 }),
  /** The call fact it must match before the tool may run. */
  fact: text({ minLength: 1, maxLength: 100 }),
});

const speech = object({
  /** A sentence with `{dotted.path}` holes, filled from the response. */
  template: text({ minLength: 1, maxLength: MAX_SENTENCE }),
  /** Spoken when a hole cannot be filled — most often "no such record". */
  fallback: text({ minLength: 1, maxLength: MAX_SENTENCE }),
});

/**
 * The fields whose requirement depends on the risk tier.
 *
 * All optional here, and that is not laxity. `speech` is required for a tool that can
 * return data, `readback` for a write tool and `transferReason` for an irreversible one —
 * three conditional rules that this schema language cannot express and that
 * `parseConnectorConfig` already expresses exactly once. Declaring them optional and
 * letting that function refuse is the difference between one source of truth and two that
 * will disagree within a month.
 */
const tierFields = {
  speech: optional(speech),
  readback: optional(text({ minLength: 1, maxLength: MAX_SENTENCE })),
  transferReason: optional(text({ minLength: 1, maxLength: MAX_SENTENCE })),
  identifiers: optional(list(identifier, { maxItems: 16 })),
} as const;

/**
 * `timeoutMs` carries the hard ceiling from `@ansa/tools`, so the published spec states it.
 *
 * The bound is documentation. The enforcement is `registry.register`, which refuses
 * anything over `HARD_TIMEOUT_MS` whoever wrote it and whichever door it came through —
 * a tenant asking for thirty seconds is asking for thirty seconds of dead air on a phone
 * line, and the place to refuse that is registration, not a JSON schema.
 */
const timeoutMs = optional(integer({ minimum: 1, maximum: HARD_TIMEOUT_MS }));

const httpTool = object({
  name: text({ minLength: 3, maxLength: 64, pattern: TOOL_NAME }),
  /** The model chooses by this, so it is worth writing properly. */
  description: text({ minLength: 1, maxLength: MAX_DESCRIPTION }),
  /**
   * JSON Schema for the arguments, as a JSON document.
   *
   * A string rather than a nested object, and the reason is worth stating: this value is
   * handed to the model untouched and nothing in this product interprets it, so any shape
   * a tenant can write today has to survive a read and a write here unchanged. Describing
   * it as a fixed set of fields would make `GET` then `PUT` quietly destroy a schema that
   * `tools/tenant/config.mjs` wrote. All this layer checks is that it parses to a JSON
   * object, which is the same thing `parseConnectorConfig` checks.
   */
  parametersJson: text({ minLength: 2, maxLength: MAX_SCHEMA_JSON, format: "json" }),
  riskTier: choice(["read", "write", "irreversible"]),
  url: text({ minLength: 1, maxLength: MAX_URL, format: "uri" }),
  method: choice(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  /** Where the model's arguments go. */
  send: choice(["query", "body"]),
  timeoutMs,
  /** A name in this organisation's credential vault. Never the credential itself. */
  credentialRef: optional(text({ maxLength: 64, pattern: CREDENTIAL_REF })),
  ...tierFields,
});

/**
 * One tool on a tenant's MCP server.
 *
 * The name, description and schema come from discovery; the risk tier does not, and cannot
 * — a server telling us which of its own tools are safe to run without confirmation is the
 * server marking its own homework. A discovered tool with no entry here is never registered.
 */
const mcpTool = object({
  name: text({ minLength: 1, maxLength: 64 }),
  riskTier: choice(["read", "write", "irreversible"]),
  timeoutMs,
  ...tierFields,
});

const mcpServer = object({
  url: text({ minLength: 1, maxLength: MAX_URL, format: "uri" }),
  credentialRef: optional(text({ maxLength: 64, pattern: CREDENTIAL_REF })),
  tools: list(mcpTool, { maxItems: 100 }),
});

const egress = object({
  /** Exact hostnames, or `*.example.com` for a subdomain wildcard, which excludes the apex. */
  allowedHosts: list(text({ minLength: 1, maxLength: MAX_HOST }), { maxItems: 100 }),
  /**
   * Plaintext HTTP, off unless the organisation says otherwise in writing. A tool call
   * carries a credential and often a caller's own details.
   */
  allowPlaintextHttp: optional(flag()),
});

const configurationFields = {
  egress,
  http: list(httpTool, { maxItems: 100 }),
  mcp: list(mcpServer, { maxItems: 20 }),
} as const;

const toolConfiguration = object({
  /** The version in force. Send it back as `expectedVersion` to change anything. */
  configVersion: integer({ minimum: 0 }),
  ...configurationFields,
});

const replacement = object({
  /**
   * The `configVersion` this edit was made against.
   *
   * Required, not optional. Two admins with the same page open is the ordinary case, and
   * the loser of that race should hear about it rather than discover next week that their
   * tool disappeared. Every publish bumps the version, including one made by the agent
   * configuration or event endpoints, so a 409 means "re-read and try again".
   */
  expectedVersion: integer({ minimum: 0 }),
  /** Recorded on the version. A version with no reason explains nothing later. */
  note: optional(text({ minLength: 1, maxLength: 200 })),
  ...configurationFields,
});

const published = object({ configVersion: integer({ minimum: 1 }) });

type HttpToolInput = Infer<typeof httpTool>;
type McpToolInput = Infer<typeof mcpTool>;

const DEFAULT_NOTE = "dashboard: tool configuration replaced";

/** `[{argument, fact}]` on the wire, `{argument: fact}` in the column. */
const identifierRecord = (
  entries: readonly Infer<typeof identifier>[] | undefined,
): Record<string, unknown> => {
  if (entries === undefined || entries.length === 0) return {};
  return { identifiers: Object.fromEntries(entries.map((e) => [e.argument, e.fact])) };
};

/**
 * The inverse, sorted.
 *
 * Sorted so that reading the same stored document twice produces the same response, and a
 * `GET` followed by an unedited `PUT` is not recorded as a change.
 */
const identifierList = (
  record: Readonly<Record<string, string>> | undefined,
): { identifiers?: readonly Infer<typeof identifier>[] } => {
  const entries = Object.entries(record ?? {});
  if (entries.length === 0) return {};
  return {
    identifiers: entries
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([argument, fact]) => ({ argument, fact })),
  };
};

/**
 * The argument schema, as JSON.
 *
 * Refused rather than coerced: an array or a bare string here would reach the model as its
 * tool schema, and a model given a malformed schema does not fail — it guesses.
 */
const toParameters = (raw: string, where: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UnprocessableEntityException(`${where}.parametersJson is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UnprocessableEntityException(
      `${where}.parametersJson must be a JSON object — a JSON Schema for the arguments`,
    );
  }
  return parsed as Record<string, unknown>;
};

/** Tier-shaped fields, carried through untouched for `parseConnectorConfig` to judge. */
const tierPart = (tool: HttpToolInput | McpToolInput): Record<string, unknown> => ({
  ...(tool.speech === undefined ? {} : { speech: tool.speech }),
  ...(tool.readback === undefined ? {} : { readback: tool.readback }),
  ...(tool.transferReason === undefined ? {} : { transferReason: tool.transferReason }),
  ...identifierRecord(tool.identifiers),
  ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
});

/** The request body, as the document that goes in the column. */
export const toToolDocument = (body: Infer<typeof replacement>): Record<string, unknown> => ({
  egress: {
    allowedHosts: body.egress.allowedHosts,
    ...(body.egress.allowPlaintextHttp === undefined
      ? {}
      : { allowPlaintextHttp: body.egress.allowPlaintextHttp }),
  },
  http: body.http.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toParameters(tool.parametersJson, `http[${tool.name}]`),
    riskTier: tool.riskTier,
    url: tool.url,
    method: tool.method,
    send: tool.send,
    ...(tool.credentialRef === undefined ? {} : { credentialRef: tool.credentialRef }),
    ...tierPart(tool),
  })),
  mcp: body.mcp.map((server) => ({
    url: server.url,
    ...(server.credentialRef === undefined ? {} : { credentialRef: server.credentialRef }),
    tools: server.tools.map((tool) => ({
      name: tool.name,
      riskTier: tool.riskTier,
      ...tierPart(tool),
    })),
  })),
});

/** The parsed document, as the response. The inverse of the above, and tested as one. */
export const toToolResponseBody = (
  parsed: ConnectorConfig,
): Omit<Infer<typeof toolConfiguration>, "configVersion"> => ({
  egress: {
    allowedHosts: parsed.egress.allowedHosts,
    ...(parsed.egress.allowPlaintextHttp === true ? { allowPlaintextHttp: true } : {}),
  },
  http: parsed.http.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJson: JSON.stringify(tool.parameters),
    riskTier: tool.riskTier,
    url: tool.url,
    method: tool.method,
    send: tool.send,
    ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
    ...(tool.credentialRef === undefined ? {} : { credentialRef: tool.credentialRef }),
    ...(tool.speech === undefined ? {} : { speech: tool.speech }),
    ...(tool.readback === undefined ? {} : { readback: tool.readback }),
    ...(tool.transferReason === undefined ? {} : { transferReason: tool.transferReason }),
    ...identifierList(tool.identifiers),
  })),
  mcp: parsed.mcp.map((server) => ({
    url: server.url,
    ...(server.credentialRef === undefined ? {} : { credentialRef: server.credentialRef }),
    tools: server.tools.map((tool) => ({
      name: tool.name,
      riskTier: tool.riskTier,
      ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
      ...(tool.speech === undefined ? {} : { speech: tool.speech }),
      ...(tool.readback === undefined ? {} : { readback: tool.readback }),
      ...(tool.transferReason === undefined ? {} : { transferReason: tool.transferReason }),
      ...identifierList(tool.identifiers),
    })),
  })),
});

@Controller(apiRoute("tools"))
export class ToolsController {
  constructor(@Inject(TenantContext) private readonly db: TenantContext) {}

  @Get()
  @Endpoint({
    summary: "The tools this organisation has given its agent",
    description:
      "Credential names are shown; credential values are not stored in this document and are never returned. Answers 409 if the stored configuration is one the agent is refusing to load, with the reason.",
    capability: "config:read",
    response: toolConfiguration,
  })
  async read(): Promise<Infer<typeof toolConfiguration>> {
    return this.db.tx(async (scope) => {
      const current = await readConfiguration(scope);
      if (current === null) throw new NotFoundException();

      /**
       * `parseConnectorConfig` alone, not the full `checkToolConfig`.
       *
       * A document that parses but whose tools fail registration is *partly* live —
       * `prepareConnectors` registers what it can and logs the rest — so returning it is
       * the truth. A document that does not parse costs the tenant every tool, which the
       * call path logs as an error and this reports as a 409.
       */
      const parsed = orConflict(() => parseConnectorConfig(current.toolConfig));
      return { configVersion: current.configVersion, ...toToolResponseBody(parsed) };
    });
  }

  @Put()
  @Endpoint({
    summary: "Replace the tools this organisation has given its agent",
    description:
      "Whole document, never a patch, and it publishes a new configuration version. Refused with 422 if any tool would not register — no risk tier, a write tool with no readback, a timeout over the ceiling, a name that shadows a platform tool, a URL outside egress.allowedHosts, or a credential reference this organisation has not stored.",
    capability: "config:write",
    body: replacement,
    response: published,
  })
  async replace(@FromBody() body: Infer<typeof replacement>): Promise<Infer<typeof published>> {
    const document = toToolDocument(body);
    // Everything `@ansa/tools` will judge on the call path, judged now. Outside the
    // transaction because it touches nothing: a refusal should not have opened one.
    const tools = orRefuse(() => checkToolConfig(document, this.db.caller.tenantId));

    return this.db.tx(async (scope) => {
      const current = await readConfiguration(scope);
      if (current === null) throw new NotFoundException();
      if (current.configVersion !== body.expectedVersion) {
        throw new ConflictException(
          `this organisation's configuration is at version ${current.configVersion} and the edit was made against ${body.expectedVersion}; re-read it and try again`,
        );
      }

      const sealed = await sealedCredentials(scope);
      const key = vaultKey();
      const kinds = key === null ? null : await classifyCredentials(key, scope.tenantId, sealed);
      const uses = credentialUses(tools, eventsOrNothing(current.eventConfig));
      orRefuse(() => refuseUnusableReferences(uses, new Set(sealed.keys()), kinds));

      const version = await publishConfiguration(scope, current, {
        toolConfig: document,
        // Carried over untouched. A publish rewrites every column it takes, so leaving this
        // out would stop every delivery this organisation is expecting.
        eventConfig: current.eventConfig,
        note: body.note ?? DEFAULT_NOTE,
      });
      return { configVersion: version };
    });
  }
}
