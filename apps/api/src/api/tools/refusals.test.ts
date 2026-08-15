import { randomUUID } from "node:crypto";

import { asOrganizationId } from "@ansa/shared";
import { HARD_TIMEOUT_MS } from "@ansa/tools";
import { describe, expect, it } from "vitest";

import { checkEventConfig, checkToolConfig, eventsOrNothing, toolsOrNothing } from "./refusals";

/**
 * The dangerous configurations, and where each one is stopped.
 *
 * Every case below is refused by `@ansa/tools` rather than by this layer — that is the
 * point of the file under test, which owns no rules of its own. What these assertions pin
 * down is that the dashboard actually *reaches* those refusals: a `PUT` that quietly
 * bypassed `registry.register` would still store a document, the call path would still
 * reject it, and the organization would find out from a caller.
 *
 * No database and no network. A configuration is judged from the document alone, which is
 * also why a organization can register a receiver before it is running.
 */

const organization = asOrganizationId(randomUUID());

const HOST = "api.example.invalid";

const validTool = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "order_status",
  description: "Look up the state of an order the caller reads out.",
  parameters: { type: "object", properties: { reference: { type: "string" } } },
  riskTier: "read",
  url: `https://${HOST}/orders`,
  method: "GET",
  send: "query",
  speech: { template: "Order {reference} is {state}.", fallback: "I cannot find that order." },
  ...over,
});

const withTools = (
  tools: readonly Record<string, unknown>[],
  hosts: readonly string[] = [HOST],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  egress: { allowedHosts: hosts, ...extra },
  http: tools,
});

const refusal = (document: unknown): string => {
  try {
    checkToolConfig(document, organization);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("that configuration was accepted, and it should not have been");
};

describe("a tool configuration the dashboard would publish", () => {
  it("is accepted when every tool would register", () => {
    const parsed = checkToolConfig(withTools([validTool()]), organization);
    expect(parsed.http.map((tool) => tool.name)).toEqual(["order_status"]);
  });

  /** R5.3, and the first thing `registry.register` looks for. */
  it("is refused without a risk tier", () => {
    expect(refusal(withTools([validTool({ riskTier: undefined })]))).toContain("riskTier");
  });

  /** R4.3.1. There is no confidence threshold that skips the readback. */
  it("is refused when a write tool has no readback", () => {
    const message = refusal(
      withTools([validTool({ riskTier: "write", method: "POST", send: "body" })]),
    );
    expect(message).toContain("readback");
  });

  it("is refused when a readback quotes nothing back to the caller", () => {
    const message = refusal(
      withTools([
        validTool({
          riskTier: "write",
          method: "POST",
          send: "body",
          readback: "I will make that change now.",
        }),
      ]),
    );
    expect(message).toContain("{placeholders}");
  });

  /** R5.4.3: raw JSON is never spoken, so a tool that returns data must say how it sounds. */
  it("is refused when a tool that can return data has no speech", () => {
    expect(refusal(withTools([validTool({ speech: undefined })]))).toContain("speech");
  });

  it("is refused when the speech template would say the same thing every time", () => {
    const message = refusal(
      withTools([
        validTool({ speech: { template: "That is all sorted.", fallback: "I cannot check." } }),
      ]),
    );
    expect(message).toContain("{placeholders}");
  });

  /**
   * The one that would let a organization configure its way out of a platform guarantee: a
   * `transfer_to_human` of their own, at read tier, that quietly does nothing.
   */
  it("is refused when a organization tool shadows a platform tool", () => {
    expect(refusal(withTools([validTool({ name: "transfer_to_human" })]))).toContain(
      "already a platform tool",
    );
  });

  it("is refused when two of the organisation's own tools share a name", () => {
    const message = refusal(withTools([validTool(), validTool({ url: `https://${HOST}/x` })]));
    expect(message).toContain("already registered for this organization");
  });

  /** R5.4.1. A organization asking for thirty seconds is asking for thirty seconds of dead air. */
  it("is refused when a timeout exceeds the hard ceiling", () => {
    const message = refusal(withTools([validTool({ timeoutMs: HARD_TIMEOUT_MS + 1 })]));
    expect(message).toContain("timeoutMs");
    expect(checkToolConfig(withTools([validTool({ timeoutMs: HARD_TIMEOUT_MS })]), organization).http[0]
      ?.timeoutMs).toBe(HARD_TIMEOUT_MS);
  });

  /** R5.2.2. The URL is hostile input, and the allowlist is the organization's own declaration. */
  it("is refused when a tool points outside the organisation's own allowlist", () => {
    const message = refusal(withTools([validTool()], ["somewhere.else.invalid"]));
    expect(message).toContain("allowedHosts");
  });

  it("is refused when the allowlist names an address the egress guard always blocks", () => {
    const message = refusal(
      withTools([validTool({ url: "https://169.254.169.254/latest/meta-data" })], [
        "169.254.169.254",
      ]),
    );
    expect(message).toContain("routable public address");
  });

  it("is refused when a tool would leave the process in plaintext", () => {
    expect(refusal(withTools([validTool({ url: `http://${HOST}/orders` })]))).toContain("https");

    // …unless the organisation has said so, in writing, in its own configuration.
    const allowed = checkToolConfig(
      withTools([validTool({ url: `http://${HOST}/orders` })], [HOST], {
        allowPlaintextHttp: true,
      }),
      organization,
    );
    expect(allowed.http).toHaveLength(1);
  });

  it("is refused when a tool name is not one the model can ask for", () => {
    expect(refusal(withTools([validTool({ name: "Order Status" })]))).toContain("valid tool name");
  });

  it("is refused when a tool sends a body on a GET", () => {
    expect(refusal(withTools([validTool({ send: "body" })]))).toContain("body on a GET");
  });

  it("is refused when an identifier maps to nothing", () => {
    expect(refusal(withTools([validTool({ identifiers: { reference: "" } })]))).toContain(
      "identifiers",
    );
  });
});

describe("an MCP server, which is a transport and not a category", () => {
  const server = (tools: readonly Record<string, unknown>[]): Record<string, unknown> => ({
    egress: { allowedHosts: [HOST] },
    mcp: [{ url: `https://${HOST}/mcp`, tools }],
  });

  it("is accepted when every configured tool carries a tier", () => {
    const parsed = checkToolConfig(server([{ name: "lookup", riskTier: "read" }]), organization);
    expect(parsed.mcp[0]?.tools).toHaveLength(1);
  });

  /** A server marking its own homework is exactly what is not allowed to happen. */
  it("is refused when a configured tool has no tier", () => {
    expect(refusal(server([{ name: "cancel_policy" }]))).toContain("riskTier");
  });

  it("holds the same ceiling and the same shadowing rule as the HTTP route", () => {
    expect(
      refusal(server([{ name: "lookup", riskTier: "read", timeoutMs: HARD_TIMEOUT_MS + 1 }])),
    ).toContain("timeoutMs");
    expect(refusal(server([{ name: "end_call", riskTier: "read" }]))).toContain(
      "already a platform tool",
    );
  });

  it("is refused when a write tool on it has no readback", () => {
    expect(refusal(server([{ name: "change_address", riskTier: "write" }]))).toContain("readback");
  });
});

describe("an event configuration", () => {
  const RECEIVER = "hooks.example.invalid";

  const subscription = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: "crm",
    url: `https://${RECEIVER}/ansa`,
    events: ["call.ended"],
    signingSecretRef: "crm_hook",
    ...over,
  });

  const withEvents = (
    subscriptions: readonly Record<string, unknown>[],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    egress: { allowedHosts: [RECEIVER] },
    subscriptions,
    ...extra,
  });

  const eventRefusal = (document: unknown): string => {
    try {
      checkEventConfig(document);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("that event configuration was accepted, and it should not have been");
  };

  /**
   * The rule this whole area defends, and since 2026-08-15 it is absolute rather than a
   * default. The organisation is the data controller and the payload records a conversation
   * their own agent had.
   */
  it("masks nothing, and offers no way to ask for masking", () => {
    const parsed = checkEventConfig(withEvents([subscription()]));
    expect(parsed.subscriptions[0]).not.toHaveProperty("redaction");
  });

  it("is refused without a signing secret, because an unsigned POST is anybody's", () => {
    expect(eventRefusal(withEvents([subscription({ signingSecretRef: undefined })]))).toContain(
      "signingSecretRef",
    );
  });

  it("is refused for an event type that does not exist", () => {
    expect(eventRefusal(withEvents([subscription({ events: ["call.started"] })]))).toContain(
      "unknown type",
    );
  });

  it("is refused for a receiver outside the organisation's own allowlist", () => {
    expect(
      eventRefusal({
        egress: { allowedHosts: ["elsewhere.invalid"] },
        subscriptions: [subscription()],
      }),
    ).toContain("allowedHosts");
  });

  /** `event_deliveries.subscription` records this name; two of them make the log unreadable. */
  it("is refused when two receivers share a name", () => {
    const message = eventRefusal(
      withEvents([subscription(), subscription({ url: `https://${RECEIVER}/second` })]),
    );
    expect(message).toContain("both named crm");
  });

  it("keeps every receiver when a stored document still carries redaction rules", () => {
    /* Documents saved before R5.2.4 was withdrawn are still in the column. Refusing one
       would stop that organisation's events being delivered at all, which is far worse
       than ignoring a block that no longer means anything. */
    const parsed = checkEventConfig(
      withEvents(
        [
          subscription(),
          subscription({
            name: "analytics",
            redaction: { categories: ["captured-identifier", "digit-sequence"] },
          }),
        ],
        { redaction: { categories: ["card-number"] } },
      ),
    );
    expect(parsed.subscriptions.map((entry) => entry.name)).toEqual(["crm", "analytics"]);
    expect(parsed.subscriptions[0]).not.toHaveProperty("redaction");
    expect(parsed.subscriptions[1]).not.toHaveProperty("redaction");
  });
});

describe("reading the other document while publishing one", () => {
  /**
   * A malformed tool configuration must not block an event publish, and must not make the
   * credentials it names look unreferenced either. The tolerant readers answer the first
   * question; `referencedCredentials` answers the second off the raw JSON.
   */
  it("degrades to nothing rather than throwing", () => {
    expect(toolsOrNothing({ http: "not an array" }).http).toEqual([]);
    expect(eventsOrNothing({ subscriptions: 7 }).subscriptions).toEqual([]);
    expect(toolsOrNothing(null).http).toEqual([]);
  });
});
