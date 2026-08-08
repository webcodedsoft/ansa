import type { TenantId } from "@ansa/shared";

import { HARD_TIMEOUT_MS } from "./limits";
import type { ToolAdapter, ToolDefinition } from "./types";

/** A definition and the adapter that will run it. The dispatcher never sees them apart. */
export interface Registration {
  readonly definition: ToolDefinition;
  readonly adapter: ToolAdapter;
}

export interface ToolRegistry {
  /** Throws on anything the dispatcher could not safely execute later. */
  register(definition: ToolDefinition, adapter: ToolAdapter): void;
  /** Platform tools plus this tenant's own. What the model is told it can call. */
  listFor(tenantId: TenantId): readonly ToolDefinition[];
  /** Null when this tenant has no such tool, including when another tenant does. */
  resolve(tenantId: TenantId, name: string): Registration | null;
}

const NAME = /^[a-z][a-z0-9_]{2,63}$/;
const TIERS = new Set(["read", "write", "irreversible"]);

const isNonEmptyString = (value: unknown): boolean =>
  typeof value === "string" && value.trim() !== "";

/**
 * Validated against the runtime shape rather than the compile-time one.
 *
 * The type union already makes a tierless literal impossible, but the tools that matter
 * most arrive as tenant configuration — JSON from a database — where the type system was
 * never present. Registration is the last place a bad tool can be stopped cheaply.
 */
const validate = (definition: ToolDefinition): void => {
  const raw = definition as unknown as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name : "";

  if (!NAME.test(name)) {
    throw new Error(
      `tool registration: ${JSON.stringify(raw.name)} is not a valid tool name (lower snake case, 3-64 chars)`,
    );
  }
  if (!isNonEmptyString(raw.description)) {
    throw new Error(`tool registration: ${name} needs a description — the model chooses by it`);
  }
  if (raw.parameters === null || typeof raw.parameters !== "object" || Array.isArray(raw.parameters)) {
    throw new Error(`tool registration: ${name} needs a parameters schema, even if it takes none`);
  }

  const tier = raw.riskTier;
  if (typeof tier !== "string" || !TIERS.has(tier)) {
    throw new Error(
      `tool registration: ${name} has no risk tier. One of read, write, irreversible is required (R5.3)`,
    );
  }

  if (tier === "irreversible") {
    if (!isNonEmptyString(raw.transferReason)) {
      throw new Error(
        `tool registration: ${name} is irreversible and must say why a human is taking it`,
      );
    }
  } else if (typeof raw.summarise !== "function") {
    throw new Error(
      `tool registration: ${name} must supply summarise — raw JSON is never spoken (R5.4.3)`,
    );
  }

  if (tier === "write" && typeof raw.readback !== "function") {
    throw new Error(
      `tool registration: ${name} is write tier and must supply a readback (R4.3.1)`,
    );
  }

  const identifiers = raw.identifiers;
  if (identifiers !== undefined) {
    const bad =
      identifiers === null ||
      typeof identifiers !== "object" ||
      Array.isArray(identifiers) ||
      Object.entries(identifiers as Record<string, unknown>).some(
        ([argument, fact]) => argument.trim() === "" || !isNonEmptyString(fact),
      );
    if (bad) {
      throw new Error(
        `tool registration: ${name} identifiers must map an argument name to the call fact it must match`,
      );
    }
  }

  const timeout = raw.timeoutMs;
  if (timeout !== undefined) {
    const bad =
      typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > HARD_TIMEOUT_MS;
    if (bad) {
      throw new Error(
        `tool registration: ${name} timeoutMs must be between 1 and ${HARD_TIMEOUT_MS} (R5.4.1)`,
      );
    }
  }
};

/**
 * One registry. Internal tools, HTTP connectors and MCP servers all land here (R5.2.0),
 * which is what lets risk tiers, ceilings, holding speech and logging be written once.
 */
export const createToolRegistry = (): ToolRegistry => {
  const platform = new Map<string, Registration>();
  const tenants = new Map<TenantId, Map<string, Registration>>();

  return {
    register(definition, adapter) {
      validate(definition);
      const { name } = definition;
      const owner = definition.tenantId ?? null;

      // A tenant redefining `transfer_to_human` as a read-tier no-op would configure its
      // way out of a platform guarantee. Shadowing is refused rather than resolved.
      if (platform.has(name)) {
        throw new Error(`tool registration: ${name} is already a platform tool`);
      }

      if (owner === null) {
        platform.set(name, { definition, adapter });
        return;
      }

      const own = tenants.get(owner) ?? new Map<string, Registration>();
      if (own.has(name)) {
        throw new Error(`tool registration: ${name} is already registered for this tenant`);
      }
      own.set(name, { definition, adapter });
      tenants.set(owner, own);
    },

    listFor(tenantId) {
      const own = tenants.get(tenantId);
      return [
        ...[...platform.values()].map((r) => r.definition),
        ...(own === undefined ? [] : [...own.values()].map((r) => r.definition)),
      ];
    },

    resolve(tenantId, name) {
      return tenants.get(tenantId)?.get(name) ?? platform.get(name) ?? null;
    },
  };
};
