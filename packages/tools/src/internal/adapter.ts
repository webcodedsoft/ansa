import type { ToolRegistry } from "../registry";
import type { AdapterCall, ToolAdapter, ToolDefinition } from "../types";

export type InternalHandler = (call: AdapterCall) => Promise<unknown>;

/** A platform-owned tool: what it is, and the code that runs it. */
export interface InternalTool {
  readonly definition: ToolDefinition;
  readonly handler: InternalHandler;
}

/**
 * Route A of R5.2.0, and the smallest possible adapter: it looks a handler up by name
 * and calls it.
 *
 * Everything a tool needs beyond that — tier enforcement, ceilings, holding speech,
 * redacted logging, summary checking — is in the dispatcher and is therefore already
 * true of the HTTP and MCP routes before either is written. That is the entire claim
 * R5.2.0 makes, and this file is how small an adapter has to be for it to hold.
 */
export const registerInternalTools = (registry: ToolRegistry, tools: readonly InternalTool[]): void => {
  const handlers = new Map(tools.map((tool) => [tool.definition.name, tool.handler]));

  const adapter: ToolAdapter = {
    route: "internal",
    execute: async (call) => {
      const handler = handlers.get(call.name);
      if (handler === undefined) throw new Error(`internal tool not implemented: ${call.name}`);
      return handler(call);
    },
  };

  for (const tool of tools) registry.register(tool.definition, adapter);
};
