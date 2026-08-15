import { HARD_TIMEOUT_MS, parseConnectorConfig, type ConnectorConfig } from "@ansa/tools";
import {
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Post,
  Put,
  UnprocessableEntityException,
} from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import { apiRoute, FromBody, FromPath } from "../http/request";
import {
  choice,
  flag,
  integer,
  list,
  map,
  nullable,
  object,
  optional,
  text,
  type Infer,
} from "../http/schema";
import { OrganizationContext } from "../tenancy/organization-context";

import { checkToolConfig, eventsOrNothing, orConflict, orRefuse } from "./refusals";
import { fetchSample } from "./sample";
import { runToolInSandbox } from "./sandbox";
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
 * is what `tools/organization/config.mjs publish` already does and for the same reason: a publish
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
 * `tools/organization/config.mjs` could, which is why the ceilings are far above anything a
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
 * a organization asking for thirty seconds is asking for thirty seconds of dead air on a phone
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
   * a organization can write today has to survive a read and a write here unchanged. Describing
   * it as a fixed set of fields would make `GET` then `PUT` quietly destroy a schema that
   * `tools/organization/config.mjs` wrote. All this layer checks is that it parses to a JSON
   * object, which is the same thing `parseConnectorConfig` checks.
   */
  parametersJson: text({ minLength: 2, maxLength: MAX_SCHEMA_JSON, format: "json" }),
  riskTier: choice(["read", "write", "irreversible"]),
  url: text({ minLength: 1, maxLength: MAX_URL, format: "uri" }),
  method: choice(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  /**
   * Where the model's arguments go — the ones the URL has not already taken.
   *
   * Path parameters are written into `url` as `{name}` and are orthogonal to this:
   * `POST /policies/{id}/claims` puts one argument in the path and the rest in the body.
   * `parseConnectorConfig` refuses a placeholder anywhere but the path, because one in the
   * host would let an argument choose which server is called.
   */
  send: choice(["query", "body"]),
  /**
   * Fixed headers sent with every request. Never authentication.
   *
   * `parseConnectorConfig` refuses `authorization`, `cookie`, `x-api-key` and the rest
   * outright, and the refusal is the point: this document is returned by `GET /tools`, so a
   * static credential header would make the secret readable by anyone who can read the
   * configuration. That is what `credentialRef` exists to prevent.
   */
  headers: optional(map(text({ maxLength: 1024 }), { maxProperties: 24 })),
  timeoutMs,
  /** A name in this organisation's credential vault. Never the credential itself. */
  credentialRef: optional(text({ maxLength: 64, pattern: CREDENTIAL_REF })),
  ...tierFields,
});

/**
 * One tool on a organization's MCP server.
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

const sampleRequest = object({
  url: text({ minLength: 1, maxLength: MAX_URL, format: "uri" }),
  headers: optional(map(text({ maxLength: 1024 }), { maxProperties: 24 })),
  credentialRef: optional(text({ maxLength: 64, pattern: CREDENTIAL_REF })),
});

const sampleResponse = object({
  ok: flag(),
  status: nullable(integer({ minimum: 100 })),
  /** The body as JSON text, so a response of any shape survives without a schema for it. */
  json: nullable(text({ maxLength: 65_536 })),
  detail: nullable(text({ maxLength: 400 })),
});

// ---------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------

/**
 * Generous, and the same reasoning as the schema bound above: this is a JSON document a
 * organization hand-writes to stand in for what the model would pass, and the ceiling exists so
 * an unbounded string cannot arrive at an endpoint rather than as a claim about arguments.
 */
const MAX_ARGS_JSON = 20_000;

/** Both bounded by what `identifier` above allows, because they name the same two things. */
const confirmedFact = object({
  /** The call fact, as `identifiers` names it. */
  fact: text({ minLength: 1, maxLength: 100 }),
  /** What the caller would have confirmed it as. The argument is checked against this. */
  value: text({ minLength: 1, maxLength: 200 }),
});

const sandboxRun = object({
  /**
   * The arguments, as a JSON object.
   *
   * A string for the same reason `parametersJson` is one: nothing in this product
   * interprets a tool's arguments, so any shape the model could produce has to survive
   * this endpoint unchanged rather than being flattened into whatever this schema language
   * can express.
   */
  argumentsJson: text({ minLength: 2, maxLength: MAX_ARGS_JSON, format: "json" }),
  /**
   * What the caller is being taken to have confirmed, for a tool that identifies a person.
   *
   * Omit it and such a tool answers `unconfirmed-identity`, which is the honest result and
   * a useful one — it is what a caller would get if the agent tried the lookup before
   * reading the detail back.
   */
  confirmed: optional(list(confirmedFact, { maxItems: 16 })),
});

const sandboxResult = object({
  tool: text({ maxLength: 64 }),
  riskTier: nullable(choice(["read", "write", "irreversible"])),
  /**
   * `ok` ran and produced a sentence. `confirm` is a write tool that has *not* run and is
   * waiting on the caller's yes. `transfer` is an irreversible tool that will never run.
   * `failed` is everything else, with `reason` saying which.
   */
  outcome: choice(["ok", "confirm", "transfer", "failed"]),
  /**
   * What the endpoint returned, as JSON, or null when nothing ran (R5.4.3).
   *
   * No `maxLength`: the connector transport already caps a response body, and a bound here
   * would turn a large but legitimate answer into a 500 on the way out.
   */
  raw: nullable(text()),
  /** The sentence the tool's own template produced, before the normalizer. */
  summary: text(),
  /** The same sentence as the caller would hear it. */
  speech: text(),
  reason: nullable(text()),
  route: nullable(text({ maxLength: 32 })),
  latencyMs: integer({ minimum: 0 }),
});

const toolPath = object({ name: text({ minLength: 1, maxLength: 64 }) });

/**
 * The test arguments, as the model would have passed them.
 *
 * An array or a bare string is refused rather than wrapped: the dispatcher hands `args` to
 * the connector as a record, and a caller who sent something else wants to know now.
 */
const toArguments = (raw: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UnprocessableEntityException("argumentsJson is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UnprocessableEntityException(
      "argumentsJson must be a JSON object — the arguments the model would pass, by name",
    );
  }
  return parsed as Record<string, unknown>;
};

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

/**
 * One HTTP tool, as it is stored.
 *
 * Shared by `PUT /tools` and by `POST /tools/try`, which builds an ephemeral document from
 * a single tool. Extracted when `headers` was added to the schema and not to the mapping,
 * so every header an operator typed was accepted, validated, and then silently dropped on
 * the way into the column. Two copies of this list is how that happens.
 */
const toStoredTool = (tool: HttpToolInput): Record<string, unknown> => ({
  name: tool.name,
  description: tool.description,
  parameters: toParameters(tool.parametersJson, `http[${tool.name}]`),
  riskTier: tool.riskTier,
  url: tool.url,
  method: tool.method,
  send: tool.send,
  ...(tool.headers === undefined || Object.keys(tool.headers).length === 0
    ? {}
    : { headers: tool.headers }),
  ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
  ...(tool.credentialRef === undefined ? {} : { credentialRef: tool.credentialRef }),
  ...tierPart(tool),
});

/** The request body, as the document that goes in the column. */
export const toToolDocument = (body: Infer<typeof replacement>): Record<string, unknown> => ({
  egress: {
    allowedHosts: body.egress.allowedHosts,
    ...(body.egress.allowPlaintextHttp === undefined
      ? {}
      : { allowPlaintextHttp: body.egress.allowPlaintextHttp }),
  },
  http: body.http.map(toStoredTool),
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
    ...(tool.headers === undefined ? {} : { headers: tool.headers }),
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

const draftRun = object({
  /** The tool as it stands on screen, in the same shape `PUT /tools` takes. */
  tool: httpTool,
  argumentsJson: text({ minLength: 2, maxLength: MAX_ARGS_JSON, format: "json" }),
  confirmed: optional(list(confirmedFact, { maxItems: 16 })),
});

@Controller(apiRoute("tools"))
export class ToolsController {
  constructor(@Inject(OrganizationContext) private readonly db: OrganizationContext) {}

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
       * the truth. A document that does not parse costs the organization every tool, which the
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
    const tools = orRefuse(() => checkToolConfig(document, this.db.caller.organizationId));

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
      const kinds = key === null ? null : await classifyCredentials(key, scope.organizationId, sealed);
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

  /**
   * R5.4.3, from the organization's side: what the endpoint returned, what it was summarised to,
   * and what a caller would hear.
   *
   * `sandbox.ts` has the reasoning. The two properties worth having in front of you while
   * reading this handler are that it goes through `packages/tools`' one dispatch path — so
   * a `write` tool answers with its readback instead of firing and an `irreversible` one
   * answers with the transfer — and that the run happens outside the transaction, because
   * it makes a request to somebody else's server on a three-second ceiling and a database
   * transaction held open across that is a connection spent on waiting.
   *
   * `config:write` rather than `config:read`, and the distinction is the point: this is the
   * only endpoint in the dashboard that causes something to happen at the organisation's own
   * systems. A `member` who may look at the configuration must not be able to fire a lookup
   * of a real customer's record at it.
   */
  @Post("try")
  @Endpoint({
    summary: "Run a tool that has not been saved yet",
    description:
      "Takes the tool as it stands on screen and runs it through the same dispatch path a " +
      "call uses, without storing anything. The risk tiers still apply, because they are the " +
      "dispatcher's and not this endpoint's: a `write` answers `confirm` with the readback " +
      "and does not fire, an `irreversible` answers `transfer` and never runs. Nothing is " +
      "persisted and no configuration version is created. The egress allowlist for the run " +
      "is the tool's own host — the guard's address checks are unchanged, so a private or " +
      "link-local target is refused exactly as it would be on a call.",
    capability: "config:write",
    body: draftRun,
    response: sandboxResult,
    rateLimit: { limit: 30, windowMs: 60_000, by: "ip" },
  })
  async try(@FromBody() body: Infer<typeof draftRun>): Promise<Infer<typeof sandboxResult>> {
    const args = toArguments(body.argumentsJson);
    const sealed = await this.db.tx((scope) => sealedCredentials(scope));

    /* An ephemeral document rather than the stored one, run through `runToolInSandbox`
       unchanged. That is the whole design: there is one execution route in this repository
       and a test enforces it, so "try before saving" has to be a different *document*, never
       a different path. The tiers, the identity gate, the timeout ceiling and the R5.4.3
       check on the spoken sentence are therefore the real ones rather than a copy.

       The allowlist is the tool's own host for the same reason the sample fetch's is: the
       operator is looking at a URL they are about to save into it. Every address check the
       guard makes is untouched. */
    const host = (() => {
      try {
        return new URL(body.tool.url.replace(/\{[^}]+\}/g, "_")).hostname;
      } catch {
        return null;
      }
    })();
    if (host === null) throw new UnprocessableEntityException("The tool's URL is not a URL.");

    const toolConfig = {
      egress: { allowedHosts: [host], allowPlaintextHttp: body.tool.url.startsWith("http:") },
      http: [toStoredTool(body.tool)],
      mcp: [],
    };

    // Refused here rather than inside the sandbox, so a draft that could never register
    // comes back as a 422 naming the field instead of as a failed run.
    orRefuse(() => checkToolConfig(toolConfig, this.db.caller.organizationId));

    const result = await runToolInSandbox({
      owner: this.db.caller.organizationId,
      toolConfig,
      sealedCredentials: sealed,
      credentialKey: vaultKey(),
      name: body.tool.name,
      args,
      confirmed: new Map((body.confirmed ?? []).map((fact) => [fact.fact, fact.value])),
    });

    if (result === null) throw new UnprocessableEntityException("That tool could not be registered.");
    return result;
  }

  @Post("sample")
  @Endpoint({
    summary: "Fetch one response from an endpoint, to see what shape it has",
    description:
      "A GET, run through the same egress guard a call uses: https only unless plaintext is " +
      "enabled, no credentials in the URL, and no host that resolves to a private or " +
      "link-local address, checked on every redirect hop and every resolved address. The " +
      "host does not need to be in the allowlist yet — this is for a URL you are about to " +
      "save into it. GET only, because a sample of a POST would perform whatever that POST " +
      "does. Returns the body and nothing else: never a request header, and never the " +
      "credential it was sent with.",
    capability: "config:write",
    body: sampleRequest,
    response: sampleResponse,
    // A real outbound request to somebody else's server, from a button. The brake is on the
    // held-down button rather than on a quota, same as the sandbox.
    rateLimit: { limit: 30, windowMs: 60_000, by: "ip" },
  })
  async sample(@FromBody() body: Infer<typeof sampleRequest>): Promise<Infer<typeof sampleResponse>> {
    const stored = await this.db.tx(async (scope) => {
      const current = await readConfiguration(scope);
      return {
        allowPlaintextHttp:
          parseConnectorConfig(current?.toolConfig).egress.allowPlaintextHttp === true,
        sealed: await sealedCredentials(scope),
      };
    });

    const result = await fetchSample({
      owner: this.db.caller.organizationId,
      url: body.url,
      allowPlaintextHttp: stored.allowPlaintextHttp,
      headers: body.headers ?? {},
      credentialRef: body.credentialRef ?? null,
      sealedCredentials: stored.sealed,
      credentialKey: vaultKey(),
    });

    return {
      ok: result.ok,
      status: result.status,
      // Re-serialised rather than passed through as an object: the response shape belongs to
      // somebody else's API and cannot be described by a schema here.
      json: result.json === null ? null : JSON.stringify(result.json).slice(0, 65_536),
      detail: result.detail,
    };
  }

  @Post(":name/test")
  @Endpoint({
    summary: "Run one of this organisation's tools with test arguments",
    description:
      "Through the same dispatch path a call uses, so the risk tiers apply: a `write` tool " +
      "answers `confirm` with the readback the caller would hear and does not fire, and an " +
      "`irreversible` tool answers `transfer` and never runs. Returns the raw response beside " +
      "the summary and the normalized speech, which is where a template that silently renders " +
      "its fallback becomes visible. 404 if this organisation has no tool by that name — " +
      "including the platform's own call-control tools, which need a call.",
    capability: "config:write",
    params: toolPath,
    body: sandboxRun,
    response: sandboxResult,
    // Every run is a real request to the organisation's endpoint on a three-second budget.
    // Keyed by address rather than by organisation, which is all `rateLimit` can express;
    // it is a brake on a held-down button, not a quota.
    rateLimit: { limit: 30, windowMs: 60_000, by: "ip" },
  })
  async test(
    @FromPath() path: Infer<typeof toolPath>,
    @FromBody() body: Infer<typeof sandboxRun>,
  ): Promise<Infer<typeof sandboxResult>> {
    const args = toArguments(body.argumentsJson);

    const stored = await this.db.tx(async (scope) => {
      const current = await readConfiguration(scope);
      if (current === null) throw new NotFoundException();
      return { toolConfig: current.toolConfig, sealed: await sealedCredentials(scope) };
    });

    const result = await runToolInSandbox({
      owner: this.db.caller.organizationId,
      toolConfig: stored.toolConfig,
      sealedCredentials: stored.sealed,
      credentialKey: vaultKey(),
      name: path.name,
      args,
      confirmed: new Map((body.confirmed ?? []).map((fact) => [fact.fact, fact.value])),
    });

    // The name is not quoted back. It came from the URL, it is on its way to a browser, and
    // there is nothing this message needs it for.
    if (result === null) {
      throw new NotFoundException(
        "this organisation has no tool registered under that name. A tool that needs a " +
          "credential this deployment cannot open is not registered either, and the " +
          "platform's own call-control tools cannot be exercised without a call.",
      );
    }
    return result;
  }
}
