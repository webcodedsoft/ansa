import type { Logger, TenantId } from "@ansa/shared";

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
 * The split this file exists for is timing. A tenant's configuration is loaded once and
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
  /** Adds this tenant's own tools to a per-call registry beside the platform ones. */
  register(registry: ToolRegistry): void;
}

export const NO_CONNECTORS: PreparedConnectors = { tools: [], register: () => undefined };

export interface PrepareOptions {
  readonly tenantId: TenantId;
  /** The `tool_config` column, exactly as stored. Validated here, not by the database. */
  readonly config: unknown;
  /**
   * 32 bytes, from the process environment. Null when it is not configured, which
   * disables every tool that needs a credential — see below.
   */
  readonly credentialKey: Buffer | null;
  readonly sealedCredentials: ReadonlyMap<string, string>;
  readonly log: Logger;
}

const brief = (tools: readonly { name: string; description: string; riskTier: RiskTier }[]): ToolBrief[] =>
  tools.map(({ name, description, riskTier }) => ({ name, description, riskTier }));

/**
 * Prepare a tenant's connectors, or none, and never throw.
 *
 * Every failure here degrades to fewer tools rather than to a failed call. A tenant whose
 * MCP server is down still gets their HTTP connectors; a tenant with a malformed config
 * gets the three platform tools and an agent that says it cannot check. The alternative —
 * a configuration problem becoming silence on the line — is the one outcome this product
 * is not allowed to have (R6.2).
 */
export const prepareConnectors = async (options: PrepareOptions): Promise<PreparedConnectors> => {
  const { tenantId, log } = options;
  if (options.config == null) return NO_CONNECTORS;

  let parsed;
  try {
    parsed = parseConnectorConfig(options.config);
  } catch (error) {
    // Loud, and with the tenant, because the fix is a new configuration rather than a
    // code change and whoever published it is the only one who can make it.
    log.error("tenant tool configuration is not usable; no tenant tools on this call", {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NO_CONNECTORS;
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
        tenantId,
        tool: tool.name,
      });
      continue;
    }
    usableHttp.push(tool);
  }

  const transport = createTransport({ guard: createEgressGuard({ policy: parsed.egress }) });
  const vault = createInMemoryVault(
    key ?? Buffer.alloc(32),
    new Map([[tenantId, options.sealedCredentials]]),
  );

  const registrars: ((registry: ToolRegistry) => void)[] = [];
  const tools: ToolBrief[] = [];

  if (usableHttp.length > 0) {
    registrars.push((registry) =>
      registerHttpTools(registry, usableHttp, { tenantId, transport, vault, log }),
    );
    tools.push(...brief(usableHttp));
  }

  for (const server of parsed.mcp) {
    if (key === null && needsCredential(server.credentialRef)) {
      log.error("mcp server needs a credential and no vault key is configured; skipped", { tenantId });
      continue;
    }
    try {
      const prepared = await prepareMcpServer(server, { tenantId, transport, vault, log });
      registrars.push(prepared.register);
      tools.push(...brief(prepared.definitions));
    } catch (error) {
      // One unreachable MCP server must not cost the tenant their HTTP connectors.
      log.error("could not discover tools from the tenant's mcp server", {
        tenantId,
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
          log.error("a tenant tool could not be registered", {
            tenantId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  };
};
