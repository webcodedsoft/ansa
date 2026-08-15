import type { Logger, OrganizationId } from "@ansa/shared";

import type { ToolRegistry } from "../registry";
import type { RiskTier } from "../types";

import { parseConnectorConfig, type HttpToolConfig } from "./config";
import { createEgressGuard } from "./egress";
import { registerHttpTools } from "./http";
import { prepareMcpServer } from "./mcp";
import { createTransport } from "./transport";
import { createInMemoryVault } from "./vault";

/**
 * Stored configuration in, registrations out.
 *
 * The split this file exists for is timing. A organization's configuration is loaded once and
 * cached; a registry is built per call because two platform tools close over that call's
 * own effects. Everything expensive — parsing, the egress guard, the vault, an MCP
 * handshake and its tool discovery — happens on the first side. What happens per call is
 * a handful of map writes.
 */

/** What the prompt is told the agent can reach. Names and tiers, never endpoints. */
export interface ToolBrief {
  readonly name: string;
  readonly description: string;
  readonly riskTier: RiskTier;
}

export interface PreparedConnectors {
  readonly tools: readonly ToolBrief[];
  /** Adds this organization's own tools to a per-call registry beside the platform ones. */
  register(registry: ToolRegistry): void;
}

export const NO_CONNECTORS: PreparedConnectors = { tools: [], register: () => undefined };

export interface PrepareOptions {
  readonly organizationId: OrganizationId;
  /** The `tool_config` column, exactly as stored. Validated here, not by the database. */
  readonly config: unknown;
  /**
   * 32 bytes, from the process environment. Null when it is not configured, which
   * disables every tool that needs a credential — see below.
   */
  readonly credentialKey: Buffer | null;
  readonly sealedCredentials: ReadonlyMap<string, string>;
  /**
   * Which of the registry's tools the answering agent may call (migration 0018).
   *
   * The registry belongs to the organisation and the selection belongs to the agent, so
   * two agents can share an endpoint's URL, risk tier and credential without sharing
   * permission to call it. An after-hours agent that only takes messages has no business
   * reaching the endpoint that cancels a policy, and that is a property of the agent
   * rather than of the endpoint.
   *
   * `undefined` means do not filter, and exists for the caller with no agent in hand: the
   * operator's tool-test sandbox, which is exercising a registry entry directly. It is not
   * the call path's default. The call path always passes a list, so an agent with an empty
   * selection gets no tools rather than all of them.
   *
   * Names match HTTP tool names and MCP tool-policy names. An MCP server with no
   * selected policies is skipped entirely, handshake and credential included.
   */
  readonly enabledTools?: readonly string[];
  readonly log: Logger;
}

const brief = (tools: readonly { name: string; description: string; riskTier: RiskTier }[]): ToolBrief[] =>
  tools.map(({ name, description, riskTier }) => ({ name, description, riskTier }));

/**
 * Prepare a organization's connectors, or none, and never throw.
 *
 * Every failure here degrades to fewer tools rather than to a failed call. A organization whose
 * MCP server is down still gets their HTTP connectors; a organization with a malformed config
 * gets the three platform tools and an agent that says it cannot check. The alternative —
 * a configuration problem becoming silence on the line — is the one outcome this product
 * is not allowed to have (R6.2).
 */
export const prepareConnectors = async (options: PrepareOptions): Promise<PreparedConnectors> => {
  const { organizationId, log } = options;
  if (options.config == null) return NO_CONNECTORS;

  let parsed;
  try {
    parsed = parseConnectorConfig(options.config);
  } catch (error) {
    // Loud, and with the organization, because the fix is a new configuration rather than a
    // code change and whoever published it is the only one who can make it.
    log.error("organization tool configuration is not usable; no organization tools on this call", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NO_CONNECTORS;
  }

  /*
   * The agent's selection, applied before anything is prepared.
   *
   * Here rather than at dispatch, and that ordering is the point. Filtering later would
   * still refuse the call, but the tool would already have been briefed to the model, and
   * an agent that offers to cancel a policy and then cannot is worse on the phone than one
   * that never offers. It also means no MCP handshake and no credential is opened for a
   * server this agent may not reach.
   */
  const selection = options.enabledTools;
  if (selection !== undefined) {
    const allowed = new Set(selection);
    parsed = {
      ...parsed,
      http: parsed.http.filter((tool) => allowed.has(tool.name)),
      // An MCP server has no name of its own — it is a URL and a list of tool policies —
      // so the selection is applied per policy. A server left with nothing this agent may
      // call is dropped whole, which skips its handshake and its credential rather than
      // connecting to discover there was nothing to offer.
      mcp: parsed.mcp
        .map((server) => ({
          ...server,
          tools: server.tools.filter((tool) => allowed.has(tool.name)),
        }))
        .filter((server) => server.tools.length > 0),
    };
  }

  if (parsed.http.length === 0 && parsed.mcp.length === 0) return NO_CONNECTORS;

  /**
   * No key means no credential can be opened, so anything that needs one is dropped here
   * rather than failing per call.
   *
   * Dropped, not sent unauthenticated: an anonymous request to somebody's customer API is
   * either rejected, which is a confusing failure, or accepted, which is worse.
   */
  const key = options.credentialKey;
  const needsCredential = (ref: string | undefined): boolean => ref !== undefined;
  const usableHttp: HttpToolConfig[] = [];
  for (const tool of parsed.http) {
    if (key === null && needsCredential(tool.credentialRef)) {
      log.error("tool needs a credential and no vault key is configured; not registered", {
        organizationId,
        tool: tool.name,
      });
      continue;
    }
    usableHttp.push(tool);
  }

  const transport = createTransport({ guard: createEgressGuard({ policy: parsed.egress }) });
  const vault = createInMemoryVault(
    key ?? Buffer.alloc(32),
    new Map([[organizationId, options.sealedCredentials]]),
  );

  const registrars: ((registry: ToolRegistry) => void)[] = [];
  const tools: ToolBrief[] = [];

  /*
   * One registrar per tool, not one for the list.
   *
   * `registerHttpTools` throws on a definition the registry will not take — a name that
   * shadows a platform tool, a duplicate, one the pattern refuses — and that throw has to
   * stay, because `checkToolConfig` is what turns it into a 422 on the screen somebody
   * typed it on. What could not stay is a single registrar holding every HTTP tool: the
   * catch below then fired once for the whole list, so the first refusal cost every tool
   * after it in the document while the prompt had already been told all of them existed.
   * The caller heard "that's not something I can do on this line" about a tool the
   * organisation had configured, and nothing on any screen said why.
   */
  for (const tool of usableHttp) {
    registrars.push((registry) =>
      registerHttpTools(registry, [tool], { organizationId, transport, vault, log }),
    );
  }
  tools.push(...brief(usableHttp));

  for (const server of parsed.mcp) {
    if (key === null && needsCredential(server.credentialRef)) {
      log.error("mcp server needs a credential and no vault key is configured; skipped", { organizationId });
      continue;
    }
    try {
      const prepared = await prepareMcpServer(server, { organizationId, transport, vault, log });
      registrars.push(prepared.register);
      tools.push(...brief(prepared.definitions));
    } catch (error) {
      // One unreachable MCP server must not cost the organization their HTTP connectors.
      log.error("could not discover tools from the organization's mcp server", {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (tools.length === 0) return NO_CONNECTORS;

  return {
    tools,
    register: (registry) => {
      for (const registrar of registrars) {
        try {
          registrar(registry);
        } catch (error) {
          // Registration validates, and a definition that fails validation must cost that
          // tool rather than the call.
          log.error("a organization tool could not be registered", {
            organizationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  };
};
