import { describe, expect, it } from "vitest";

import { parseConnectorConfig } from "./config";
import { renderTemplate, templateFields } from "./template";

/**
 * Configuration written by somebody who does not work here, and speech built from a
 * response we did not design. Both are parameterised: a rule that only holds for the one
 * example in the brief is not a rule.
 */

describe("rendering a tenant's sentence", () => {
  const cases: readonly [string, unknown, string | null][] = [
    ["Order {id} is {state}.", { id: "A-99", state: "on its way" }, "Order A-99 is on its way."],
    ["Balance is {account.balance} naira.", { account: { balance: 12_500 } }, "Balance is 12500 naira."],
    ["First item: {items.0.label}.", { items: [{ label: "helmet" }] }, "First item: helmet."],
    ["Renewal on {renewsOn}.", { renewsOn: "12 September" }, "Renewal on 12 September."],
    ["Cover is active: {active}.", { active: true }, "Cover is active: yes."],
    ["Cover is active: {active}.", { active: false }, "Cover is active: no."],
    // Every failure mode collapses to null, which is what makes the fallback line reachable.
    ["Order {id} is {state}.", { id: "A-99" }, null],
    ["Order {id} is {state}.", null, null],
    ["Order {id}.", { id: "" }, null],
    ["Order {id}.", { id: { nested: true } }, null],
    ["Order {id}.", { id: [1, 2] }, null],
    ["Order {id}.", { id: null }, null],
    ["Deep {a.b.c.d}.", { a: { b: { c: { d: "found" } } } }, "Deep found."],
    ["Missing {a.b.c.d}.", { a: { b: {} } }, null],
  ];

  for (const [template, data, expected] of cases) {
    it(`${JSON.stringify(template)} over ${JSON.stringify(data)}`, () => {
      expect(renderTemplate(template, data)).toBe(expected);
    });
  }

  it("lists the fields a template needs, so a typo is caught before a call", () => {
    expect(templateFields("Policy {policyNumber} for {holder.firstName} — {policyNumber}")).toEqual([
      "policyNumber",
      "holder.firstName",
    ]);
  });
});

const httpTool = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "order_status",
  description: "Look up an order.",
  parameters: { type: "object", properties: { orderId: { type: "string" } } },
  riskTier: "read",
  url: "https://api.partner.test/orders",
  method: "GET",
  send: "query",
  speech: { template: "Order {id} is {state}.", fallback: "I can't find an order with that number." },
  ...over,
});

describe("parsing a tenant's tool configuration", () => {
  it("accepts a complete read tool", () => {
    const config = parseConnectorConfig({
      egress: { allowedHosts: ["api.partner.test"] },
      http: [httpTool()],
    });
    expect(config.http).toHaveLength(1);
    expect(config.http[0]?.riskTier).toBe("read");
    expect(config.egress.allowedHosts).toEqual(["api.partner.test"]);
  });

  it("treats an absent configuration as no tools at all, rather than as an error", () => {
    expect(parseConnectorConfig(undefined).http).toEqual([]);
    expect(parseConnectorConfig(null).mcp).toEqual([]);
  });

  const refusals: readonly [string, Record<string, unknown>, RegExp][] = [
    ["no risk tier", { riskTier: undefined }, /riskTier/],
    ["an invented risk tier", { riskTier: "readonly" }, /riskTier/],
    ["no name", { name: "" }, /name/],
    ["no description", { description: undefined }, /description/],
    ["no parameters schema", { parameters: "a string" }, /parameters/],
    ["no url", { url: undefined }, /url/],
    ["a method nobody supports", { method: "TRACE" }, /method/],
    ["a body on a GET", { send: "body" }, /body on a GET/],
    ["no speech for a read", { speech: undefined }, /speech is required/],
    ["a speech template with no placeholders", { speech: { template: "All good.", fallback: "x" } }, /placeholders/],
    ["a write with no readback", { riskTier: "write", method: "POST", send: "body" }, /readback/],
    [
      "a write whose readback quotes nothing back",
      { riskTier: "write", method: "POST", send: "body", readback: "Shall I go ahead?" },
      /placeholders/,
    ],
    ["an irreversible tool with no reason for the human", { riskTier: "irreversible" }, /transferReason/],
    ["a negative timeout", { timeoutMs: -1 }, /timeoutMs/],
  ];

  for (const [why, over, message] of refusals) {
    it(`refuses ${why}`, () => {
      expect(() => parseConnectorConfig({ http: [httpTool(over)] })).toThrow(message);
    });
  }

  it("accepts a write tool that reads the caller's own values back", () => {
    const config = parseConnectorConfig({
      http: [
        httpTool({
          name: "update_contact",
          riskTier: "write",
          method: "POST",
          send: "body",
          readback: "I'm changing the number on {orderId} to {contactNumber}. Should I go ahead?",
        }),
      ],
    });
    expect(config.http[0]?.readback).toContain("{contactNumber}");
  });

  it("requires a tier for every MCP tool the tenant wants registered", () => {
    expect(() =>
      parseConnectorConfig({ mcp: [{ url: "https://mcp.partner.test/rpc", tools: [{ name: "lookup" }] }] }),
    ).toThrow(/riskTier/);

    const config = parseConnectorConfig({
      mcp: [{ url: "https://mcp.partner.test/rpc", tools: [{ name: "lookup", riskTier: "read" }] }],
    });
    expect(config.mcp[0]?.tools[0]).toMatchObject({ name: "lookup", riskTier: "read" });
  });

  it("refuses an MCP server with no tools listed — discovery does not assign tiers", () => {
    expect(() => parseConnectorConfig({ mcp: [{ url: "https://mcp.partner.test/rpc", tools: [] }] })).toThrow(
      /tools/,
    );
  });

  it("does not turn plaintext http on by accident", () => {
    expect(parseConnectorConfig({ egress: { allowedHosts: ["a.test"] } }).egress.allowPlaintextHttp).toBe(false);
    expect(
      parseConnectorConfig({ egress: { allowedHosts: ["a.test"], allowPlaintextHttp: true } }).egress
        .allowPlaintextHttp,
    ).toBe(true);
  });
});
