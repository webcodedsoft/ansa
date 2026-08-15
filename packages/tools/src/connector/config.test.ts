import { describe, expect, it } from "vitest";

import { parseConnectorConfig } from "./config";
import { renderTemplate, templateFields } from "./template";

/**
 * Configuration written by somebody who does not work here, and speech built from a
 * response we did not design. Both are parameterised: a rule that only holds for the one
 * example in the brief is not a rule.
 */

describe("rendering a organization's sentence", () => {
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

describe("parsing a organization's tool configuration", () => {
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
      egress: { allowedHosts: ["api.partner.test"] },
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

  it("requires a tier for every MCP tool the organization wants registered", () => {
    expect(() =>
      parseConnectorConfig({ mcp: [{ url: "https://mcp.partner.test/rpc", tools: [{ name: "lookup" }] }] }),
    ).toThrow(/riskTier/);

    const config = parseConnectorConfig({
      egress: { allowedHosts: ["mcp.partner.test"] },
      mcp: [{ url: "https://mcp.partner.test/rpc", tools: [{ name: "lookup", riskTier: "read" }] }],
    });
    expect(config.mcp[0]?.tools[0]).toMatchObject({ name: "lookup", riskTier: "read" });
  });

  /**
   * The guard refuses this at request time and always will. What it cannot do is say so
   * before a caller hits it: the tool registers, the model is told it can look the thing
   * up, and every attempt comes back as an apology. Two lines of the same organization's
   * configuration disagreeing is a publication error.
   */
  it("refuses a tool whose host the same organization's allowlist does not cover", () => {
    expect(() =>
      parseConnectorConfig({
        egress: { allowedHosts: ["api.partner.test"] },
        http: [httpTool({ url: "https://somewhere.else.test/orders" })],
      }),
    ).toThrow(/somewhere\.else\.test/);

    expect(() =>
      parseConnectorConfig({
        egress: { allowedHosts: ["api.partner.test"] },
        mcp: [{ url: "https://mcp.elsewhere.test/rpc", tools: [{ name: "x", riskTier: "read" }] }],
      }),
    ).toThrow(/mcp\.elsewhere\.test/);
  });

  it("accepts a subdomain a wildcard covers, and still refuses the apex", () => {
    // Same rule as the guard's, because it is literally the guard's function.
    expect(() =>
      parseConnectorConfig({
        egress: { allowedHosts: ["*.partner.test"] },
        http: [httpTool({ url: "https://api.partner.test/orders" })],
      }),
    ).not.toThrow();

    expect(() =>
      parseConnectorConfig({
        egress: { allowedHosts: ["*.partner.test"] },
        http: [httpTool({ url: "https://partner.test/orders" })],
      }),
    ).toThrow(/partner\.test/);
  });

  /**
   * The allowlist matches `URL.hostname`, which carries no port. An entry written with one
   * therefore matches nothing, and used to do so in silence — including in this repo's own
   * fixtures, which is how it was found.
   */
  it("says so when an allowlist entry carries a port the matcher will never see", () => {
    expect(() =>
      parseConnectorConfig({
        egress: { allowedHosts: ["api.partner.test:8443"] },
        http: [httpTool({ url: "https://api.partner.test:8443/orders" })],
      }),
    ).toThrow(/api\.partner\.test/);
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

/**
 * Path parameters and static headers, added 2026-08-15 so the console can describe the
 * endpoints organisations actually have. Both are places where a configuration mistake
 * turns into something worse than a broken tool, so most of what is here is refusals.
 */
describe("a URL with {placeholders}", () => {
  const withUrl = (url: string) =>
    parseConnectorConfig({
      egress: { allowedHosts: ["api.partner.test"] },
      http: [httpTool({ url })],
    }).http[0];

  it("records which arguments the path will consume", () => {
    expect(withUrl("https://api.partner.test/orders/{orderId}")?.urlParams).toEqual(["orderId"]);
  });

  it("takes more than one, in the order they appear", () => {
    expect(withUrl("https://api.partner.test/c/{customerId}/orders/{orderId}")?.urlParams).toEqual([
      "customerId",
      "orderId",
    ]);
  });

  it("takes one from the query string too, which is just as ordinary", () => {
    /* `?regNo={id}` is how a great many real endpoints are shaped, and it is filled the
       same way: replaced in the URL, and not sent again in the query or body. The only
       part that is off limits is the origin. */
    expect(withUrl("https://api.partner.test/orders?regNo={orderId}")?.urlParams).toEqual([
      "orderId",
    ]);
  });

  it("leaves a plain URL with none", () => {
    expect(withUrl("https://api.partner.test/orders")?.urlParams).toEqual([]);
  });

  it("refuses a placeholder in the host, which would let an argument pick the server", () => {
    /* The egress allowlist is checked against the configured host. If the host could be
       filled from an argument the check would pass and the request would go somewhere
       else — an SSRF with extra steps, and the argument comes from words a caller said. */
    expect(() => withUrl("https://{region}.partner.test/orders")).toThrow(
      /only use \{placeholders\} after the host/,
    );
  });

  /* The scheme and the port are refused a step earlier, by URL parsing: neither `_://host`
     nor `host:_` is a URL once the placeholder is blanked out. Different message, same
     outcome. Pinned so a later refactor cannot quietly let one through on the assumption
     the origin check above covers every part of the origin — it only covers the host. */
  for (const [part, url] of [
    ["scheme", "{scheme}://api.partner.test/orders"],
    ["port", "https://api.partner.test:{port}/orders"],
  ] as const) {
    it(`refuses one in the ${part}`, () => {
      expect(() => withUrl(url)).toThrow(/is not a URL/);
    });
  }
});

describe("static headers", () => {
  const withHeaders = (headers: unknown) =>
    parseConnectorConfig({
      egress: { allowedHosts: ["api.partner.test"] },
      http: [httpTool({ headers })],
    }).http[0];

  it("keeps an ordinary one", () => {
    expect(withHeaders({ "X-Tenant": "acme" })?.headers).toEqual({ "X-Tenant": "acme" });
  });

  it("treats none and empty the same, so nothing downstream branches on it", () => {
    expect(withHeaders(undefined)?.headers).toBeUndefined();
    expect(withHeaders({})?.headers).toBeUndefined();
  });

  for (const name of ["Authorization", "authorization", "Cookie", "X-API-Key"]) {
    it(`refuses ${name}, because that secret would then live in the tool document`, () => {
      /* `GET /tools` returns the document. A static credential header would make the
         secret readable by anyone who can read the configuration, which is exactly what
         credentialRef exists to prevent. A warning beside a box that still accepts the
         value is not a control. */
      expect(() => withHeaders({ [name]: "Bearer sk-live-abc" })).toThrow(/credential vault/);
    });
  }

  it("refuses a line break, which would split one header into two at the socket", () => {
    expect(() => withHeaders({ "X-Trace": "a\r\nX-Admin: true" })).toThrow(/line break/);
  });

  it("refuses a name that is not a header name", () => {
    expect(() => withHeaders({ "bad name": "x" })).toThrow(/unusable name/);
  });

  it("refuses a value that is not a string", () => {
    expect(() => withHeaders({ "X-Count": 7 })).toThrow(/must be a string/);
  });
});
