import { describe, expect, it } from "vitest";

import { asOrganizationId } from "@ansa/shared";

import { createToolRegistry } from "./registry";
import type { ToolAdapter, ToolDefinition } from "./types";

const ORGANIZATION_A = asOrganizationId("11111111-1111-4111-8111-111111111111");
const ORGANIZATION_B = asOrganizationId("22222222-2222-4222-8222-222222222222");

const adapter: ToolAdapter = { route: "test", execute: async () => ({ ok: true }) };

const read = (over: Partial<Record<string, unknown>> = {}): ToolDefinition =>
  ({
    name: "check_balance",
    description: "Reads a balance.",
    parameters: { type: "object" },
    riskTier: "read",
    summarise: () => "one thousand naira",
    ...over,
  }) as unknown as ToolDefinition;

describe("registration", () => {
  it("refuses a tool with no risk tier", () => {
    const registry = createToolRegistry();
    expect(() => registry.register(read({ riskTier: undefined }), adapter)).toThrow(
      /has no risk tier/,
    );
  });

  it("refuses a tier it does not recognise", () => {
    const registry = createToolRegistry();
    expect(() => registry.register(read({ riskTier: "readonly" }), adapter)).toThrow(
      /has no risk tier/,
    );
  });

  it("refuses a write tool with no readback", () => {
    const registry = createToolRegistry();
    expect(() => registry.register(read({ riskTier: "write" }), adapter)).toThrow(/readback/);
  });

  it("refuses a tool that cannot turn its result into a sentence", () => {
    const registry = createToolRegistry();
    expect(() => registry.register(read({ summarise: undefined }), adapter)).toThrow(/summarise/);
  });

  it("refuses an irreversible tool that does not say why a human is needed", () => {
    const registry = createToolRegistry();
    expect(() =>
      registry.register(read({ riskTier: "irreversible", summarise: undefined }), adapter),
    ).toThrow(/why a human/);
  });

  it("refuses a tool that never says what arguments it takes", () => {
    const registry = createToolRegistry();
    expect(() => registry.register(read({ parameters: undefined }), adapter)).toThrow(
      /parameters schema/,
    );
  });

  it("refuses a name the model would struggle to ask for", () => {
    const registry = createToolRegistry();
    expect(() => registry.register(read({ name: "Check Balance" }), adapter)).toThrow(/valid tool name/);
  });

  it("refuses a timeout longer than a caller will hold the line for", () => {
    const registry = createToolRegistry();
    expect(() => registry.register(read({ timeoutMs: 30_000 }), adapter)).toThrow(/timeoutMs/);
  });

  it("refuses the same name twice for one organization", () => {
    const registry = createToolRegistry();
    registry.register(read({ organizationId: ORGANIZATION_A }), adapter);
    expect(() => registry.register(read({ organizationId: ORGANIZATION_A }), adapter)).toThrow(/already registered/);
  });

  it("refuses a organization tool that shadows a platform tool", () => {
    const registry = createToolRegistry();
    registry.register(read(), adapter);
    // Otherwise a organization redefines transfer_to_human as read tier and the guarantee is
    // configuration rather than code.
    expect(() => registry.register(read({ organizationId: ORGANIZATION_A }), adapter)).toThrow(
      /already a platform tool/,
    );
  });

  it("accepts the same name for two different organizations", () => {
    const registry = createToolRegistry();
    registry.register(read({ organizationId: ORGANIZATION_A }), adapter);
    expect(() => registry.register(read({ organizationId: ORGANIZATION_B }), adapter)).not.toThrow();
  });
});

describe("organization scoping", () => {
  it("does not resolve another organization's tool", () => {
    const registry = createToolRegistry();
    registry.register(read({ name: "organization_a_only", organizationId: ORGANIZATION_A }), adapter);

    expect(registry.resolve(ORGANIZATION_A, "organization_a_only")).not.toBeNull();
    expect(registry.resolve(ORGANIZATION_B, "organization_a_only")).toBeNull();
  });

  it("lists platform tools plus the organization's own, and nobody else's", () => {
    const registry = createToolRegistry();
    registry.register(read({ name: "everyones_tool" }), adapter);
    registry.register(read({ name: "a_tool", organizationId: ORGANIZATION_A }), adapter);
    registry.register(read({ name: "b_tool", organizationId: ORGANIZATION_B }), adapter);

    expect(registry.listFor(ORGANIZATION_A).map((d) => d.name).sort()).toEqual(["a_tool", "everyones_tool"]);
    expect(registry.listFor(ORGANIZATION_B).map((d) => d.name).sort()).toEqual(["b_tool", "everyones_tool"]);
  });
});
