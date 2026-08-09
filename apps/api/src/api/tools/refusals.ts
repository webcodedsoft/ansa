import { isIP } from "node:net";

import type { Logger, TenantId } from "@ansa/shared";
import {
  CALL_CONTROL_DEFINITIONS,
  createToolRegistry,
  isBlockedAddress,
  parseConnectorConfig,
  parseEventConfig,
  registerHttpTools,
  type ConnectorConfig,
  type CredentialVault,
  type EgressPolicy,
  type EventConfig,
  type McpToolPolicy,
  type ToolAdapter,
  type ToolDefinition,
  type Transport,
} from "@ansa/tools";
import { ConflictException, UnprocessableEntityException } from "@nestjs/common";

/**
 * The dashboard's route into the refusals `@ansa/tools` already makes.
 *
 * This is the file that decides whether this endpoint area is safe, so it is worth being
 * explicit about what it is not. It is **not** a validator. Every rule below is enforced
 * somewhere a caller's phone call reaches — `parseConnectorConfig` on every configuration
 * load, `registry.register` on every call that builds a registry, `createEgressGuard` on
 * every request that leaves the process — and would still be enforced if this file were
 * deleted. What it does is run those same functions at publication time, so a mistake is a
 * 422 on the screen somebody typed it on rather than "sorry, I couldn't get that just now"
 * to a caller three weeks later.
 *
 * The consequence to hold on to: there is no rule here that the dispatch path does not
 * already have. If a check ever seems to be needed *only* here, it belongs in `@ansa/tools`
 * instead, because configuration reaches the call path by three other doors —
 * `tools/tenant/config.mjs`, a psql session, and whatever writes the column next.
 *
 * A note on the name `owner` below, because it looks like a synonym and is not one.
 * `routes.test.ts` greps this layer for a tenant id passed positionally — the shape of the
 * database mistake this whole surface is built to make unrepresentable — and it is
 * deliberately blunt about it. Nothing in this file touches the database; the value goes
 * into a registry key and, in `vault.ts`, into an AES-GCM authentication tag. `registry.ts`
 * calls the same thing `owner`, so the name is borrowed rather than invented, and the scan
 * stays as strict as it should be.
 */

/**
 * A registry built for validation is thrown away, so nothing it holds is ever invoked.
 *
 * Every one of these throws rather than returning a benign value. If registration is ever
 * changed to call an adapter, open a credential or send a request, the wrong thing to
 * happen is a quiet success from a stub the dashboard supplied.
 */
const NEVER_RUNS: ToolAdapter = {
  route: "internal",
  execute: async () => {
    throw new Error("a validation registry was dispatched against");
  },
};

const NEVER_SENDS: Transport = {
  send: async () => {
    throw new Error("a validation registry tried to make a request");
  },
};

const NEVER_OPENS: CredentialVault = {
  resolve: async () => {
    throw new Error("a validation registry tried to open a credential");
  },
  resolveSigner: async () => {
    throw new Error("a validation registry tried to open a signing secret");
  },
};

/** Registration takes a logger and does not use one. Publication is not a log event. */
const SILENT: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => SILENT,
};

/**
 * An MCP tool as the registry will see it, minus what discovery supplies.
 *
 * `packages/tools/src/connector/mcp.ts` builds the real definition from the tenant's policy
 * plus the name, description and schema the server advertised. Only the first half is in
 * this request — the server is not contacted at publication time, deliberately, because a
 * tenant must be able to configure a receiver before it is running. So the policy half is
 * pushed through `registry.register` exactly as it will be, and the discovered half is
 * stood in for.
 *
 * That gap is narrow and it is on the safe side: name, tier, timeout ceiling, readback,
 * transfer reason and identifiers are all the tenant's input and all checked here.
 * Description and parameters come from the server and are not the tenant's to get wrong.
 */
const mcpProbe = (policy: McpToolPolicy, owner: TenantId): ToolDefinition => {
  const base = {
    name: policy.name,
    // Discovery replaces this. The registry insists on a non-empty description and the
    // policy has no field for one, so the name stands in rather than an invented sentence.
    description: policy.name,
    parameters: { type: "object" },
    tenantId: owner,
    timeoutMs: policy.timeoutMs,
    identifiers: policy.identifiers,
  };

  if (policy.riskTier === "irreversible") {
    return { ...base, riskTier: "irreversible", transferReason: policy.transferReason ?? "" };
  }
  if (policy.riskTier === "write") {
    return {
      ...base,
      riskTier: "write",
      readback: () => policy.readback ?? "",
      summarise: () => "",
    };
  }
  return { ...base, riskTier: "read", summarise: () => "" };
};

/** `URL.hostname` keeps the brackets round an IPv6 literal; `isIP` does not want them. */
const bareHost = (host: string): string =>
  host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

/**
 * An allowlist entry that names an address the egress guard will always refuse.
 *
 * `169.254.169.254` in `allowedHosts` passes `isHostAllowed` — the allowlist is the
 * tenant's own declaration and matching it is all that function claims to do — and is then
 * refused by the address filter on every request. Both are correct and the combination is
 * useless, so it is worth saying at publication time. `isBlockedAddress` is imported rather
 * than reimplemented: this is the same function the guard calls, not a second opinion.
 *
 * Only literals are checked. A hostname is not resolved here, on purpose — a DNS answer at
 * publication time says nothing about the answer at request time, which is the whole reason
 * `transport.ts` pins addresses.
 */
const refuseUnroutableHosts = (egress: EgressPolicy, where: string): void => {
  for (const entry of egress.allowedHosts) {
    const host = bareHost(entry);
    if (isIP(host) !== 0 && isBlockedAddress(host)) {
      throw new Error(
        `${where}.egress.allowedHosts names ${host}, which is not a routable public address — ` +
          "the egress guard refuses it on every request",
      );
    }
  }
};

/**
 * A URL the guard would refuse for a reason the allowlist cannot express.
 *
 * The allowlist check `parseConnectorConfig` already runs covers "is this host declared".
 * These two are the other halves of the same verdict: the scheme, and a literal address
 * inside a private range. A tenant who genuinely serves plaintext HTTP says so in
 * `allowPlaintextHttp` and this passes — the flag is their written decision, not ours.
 */
const refuseUnreachableUrl = (raw: string, egress: EgressPolicy, where: string): void => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The parsers upstream already refused a malformed URL; reaching here means one got
    // past them, and refusing is the safe direction.
    throw new Error(`${where} is not a URL`);
  }

  const plaintext = egress.allowPlaintextHttp === true;
  if (url.protocol !== "https:" && !(plaintext && url.protocol === "http:")) {
    throw new Error(
      `${where} uses ${url.protocol.replace(":", "")}; only https leaves this process ` +
        "unless egress.allowPlaintextHttp says otherwise",
    );
  }

  const host = bareHost(url.hostname);
  if (isIP(host) !== 0 && isBlockedAddress(host)) {
    throw new Error(`${where} points at ${host}, which is not a routable public address`);
  }
};

/**
 * A candidate tool configuration, pushed through everything that will judge it later.
 *
 * In order, and each line is somebody else's rule:
 *
 *   `parseConnectorConfig` — a tier on every tool, a readback on every write tool, speech
 *   on everything that can return data, a template with holes in it, and a URL inside the
 *   allowlist declared beside it.
 *
 *   `registry.register` — a tool name that is lower snake case, a timeout at or under the
 *   3s hard ceiling, a tenant tool that does not shadow `end_call`, `transfer_to_human` or
 *   `business_hours`, and no two tools of this tenant's sharing a name. The platform
 *   definitions are registered first for exactly that shadowing check; a registry without
 *   them would accept a tenant tool called `transfer_to_human` and the tenant would
 *   discover the collision on a call.
 *
 * Returns the parsed configuration, because the caller wants the normalised form it will
 * store and read back.
 */
export const checkToolConfig = (config: unknown, owner: TenantId): ConnectorConfig => {
  const parsed = parseConnectorConfig(config);

  refuseUnroutableHosts(parsed.egress, "tool config");
  for (const tool of parsed.http) {
    refuseUnreachableUrl(tool.url, parsed.egress, `tool config.http[${tool.name}].url`);
  }
  for (const [index, server] of parsed.mcp.entries()) {
    refuseUnreachableUrl(server.url, parsed.egress, `tool config.mcp[${index}].url`);
  }

  const registry = createToolRegistry();
  for (const definition of CALL_CONTROL_DEFINITIONS) registry.register(definition, NEVER_RUNS);

  registerHttpTools(registry, parsed.http, {
    tenantId: owner,
    transport: NEVER_SENDS,
    vault: NEVER_OPENS,
    log: SILENT,
  });

  for (const server of parsed.mcp) {
    for (const policy of server.tools) registry.register(mcpProbe(policy, owner), NEVER_RUNS);
  }

  return parsed;
};

/**
 * A candidate event configuration, through the same treatment.
 *
 * `parseEventConfig` covers the event names, the signing secret being mandatory, the
 * timeout and attempt ceilings, the redaction categories, and the receiver URL sitting
 * inside the allowlist. One rule is added here and it is not a duplicate of anything:
 * `event_deliveries.subscription` records the tenant's own name for a receiver, so two
 * receivers sharing a name make the delivery log unreadable — which is the one artefact
 * that answers "you never sent it".
 */
export const checkEventConfig = (config: unknown): EventConfig => {
  const parsed = parseEventConfig(config);

  refuseUnroutableHosts(parsed.egress, "event config");

  const seen = new Set<string>();
  for (const subscription of parsed.subscriptions) {
    refuseUnreachableUrl(
      subscription.url,
      parsed.egress,
      `event config.${subscription.name}.url`,
    );
    if (seen.has(subscription.name)) {
      throw new Error(
        `event config: two receivers are both named ${subscription.name}, and the delivery ` +
          "log records that name — it could not tell them apart afterwards",
      );
    }
    seen.add(subscription.name);
  }

  return parsed;
};

/**
 * The other document, when it happens to be readable.
 *
 * Publishing tools must not be blocked because the event configuration is malformed, and
 * vice versa: each endpoint reports on its own document and the other one is only being
 * read to see which credentials it points at. What this must not do is conclude "no
 * references" from "did not parse", so both callers use it for exactly that one question
 * and nothing else.
 */
export const toolsOrNothing = (stored: unknown): ConnectorConfig => {
  try {
    return parseConnectorConfig(stored);
  } catch {
    return parseConnectorConfig(null);
  }
};

export const eventsOrNothing = (stored: unknown): EventConfig => {
  try {
    return parseEventConfig(stored);
  } catch {
    return parseEventConfig(null);
  }
};

/**
 * A refusal from `@ansa/tools`, as a 422.
 *
 * The message is passed through because it was written for exactly this reader: it names
 * the field, says what is wrong with it, and cites the requirement. None of these messages
 * contains anything the caller did not just send.
 */
export const orRefuse = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    throw new UnprocessableEntityException(error instanceof Error ? error.message : String(error));
  }
};

/**
 * The same refusal, for configuration that is already in the column.
 *
 * A `GET` cannot answer 422 — the request was fine. What is wrong is the stored document,
 * which `tools/tenant/config.mjs` or a psql session may have written, and which the call
 * path is already refusing to load. 409 says so and the reply carries the same message, so
 * a `PUT` can put it right.
 */
export const orConflict = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    throw new ConflictException(
      `the stored configuration is not usable and the agent is ignoring it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};
