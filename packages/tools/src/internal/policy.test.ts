import { describe, expect, it } from "vitest";

import { asCallId, asTenantId, type LogFields, type Logger } from "@ansa/shared";

import { createToolDispatcher, modelMessage } from "../dispatch";
import { createToolRegistry } from "../registry";
import { registerInternalTools } from "./adapter";
import { createInMemoryPolicyBook, policyTools, type PolicyRecord } from "./policy";

const TENANT_A = asTenantId("11111111-1111-4111-8111-111111111111");
const TENANT_B = asTenantId("22222222-2222-4222-8222-222222222222");
const CALL = asCallId("call-1");

const silent = (): Logger => {
  const noop = (_message: string, _fields?: LogFields): void => undefined;
  const log: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => log };
  return log;
};

const RECORDS: readonly PolicyRecord[] = [
  {
    tenantId: TENANT_A,
    policyNumber: "AXA4421",
    holder: "Chidinma Okeke",
    status: "active",
    premiumNaira: 45_000,
    renewsOn: "12 September",
    contactNumber: "08031112222",
  },
  {
    tenantId: TENANT_B,
    policyNumber: "LEAD9001",
    holder: "Musa Bello",
    status: "lapsed",
    premiumNaira: 120_000,
    renewsOn: "3 March",
    contactNumber: "08099998888",
  },
];

const harness = () => {
  const book = createInMemoryPolicyBook(RECORDS);
  const registry = createToolRegistry();
  registerInternalTools(registry, policyTools(book));
  return { book, dispatcher: createToolDispatcher({ registry, log: silent() }) };
};

describe("the worked internal tool set", () => {
  it("answers a real question about a real record, in a sentence", async () => {
    const { dispatcher } = harness();

    const outcome = await dispatcher.dispatch({
      tenantId: TENANT_A,
      callId: CALL,
      name: "policy_lookup",
      args: { policyNumber: "axa 4421" },
    });

    expect(outcome.kind).toBe("ok");
    // Currency and dates are left in the written forms the normalizer expands. Tool
    // output goes through it exactly like model output does (R4.2).
    expect(outcome.speech).toBe(
      "Policy AXA4421 is in Chidinma Okeke's name and it is active. The premium is ₦45,000 and it renews on 12 September.",
    );
  });

  it("cannot be asked for another tenant's policy by guessing the number", async () => {
    const { dispatcher } = harness();

    const outcome = await dispatcher.dispatch({
      tenantId: TENANT_A,
      callId: CALL,
      name: "policy_lookup",
      args: { policyNumber: "LEAD9001" },
    });

    expect(outcome.kind).toBe("ok");
    expect(outcome.speech).toContain("can't find a policy");
    expect(outcome.speech).not.toContain("Musa");
  });

  it("turns a missing argument into speech rather than a crash", async () => {
    const { dispatcher } = harness();

    const outcome = await dispatcher.dispatch({
      tenantId: TENANT_A,
      callId: CALL,
      name: "policy_lookup",
      args: {},
    });

    expect(outcome).toMatchObject({ kind: "failed", reason: "adapter-error" });
    expect(outcome.speech).not.toBe("");
  });

  it("reads the change back before it writes, then writes once agreed", async () => {
    const { book, dispatcher } = harness();
    const call = {
      tenantId: TENANT_A,
      callId: CALL,
      name: "update_contact_number",
      args: { policyNumber: "AXA4421", contactNumber: "07061234567" },
    };

    const asked = await dispatcher.dispatch(call);
    expect(asked.kind).toBe("confirm");
    expect(asked.speech).toContain("07061234567");
    expect((await book.find(TENANT_A, "AXA4421"))?.contactNumber).toBe("08031112222");

    if (asked.kind !== "confirm") throw new Error("expected a confirmation");
    const done = await dispatcher.dispatch({ ...call, confirmationId: asked.confirmationId });

    expect(done.kind).toBe("ok");
    expect((await book.find(TENANT_A, "AXA4421"))?.contactNumber).toBe("07061234567");
  });

  it("hands a cancellation to a human and never runs it", async () => {
    const { dispatcher } = harness();

    const outcome = await dispatcher.dispatch({
      tenantId: TENANT_A,
      callId: CALL,
      name: "cancel_policy",
      args: { policyNumber: "AXA4421" },
    });

    // The handler throws if it is ever reached, so an ok here would be a thrown error
    // rather than a quiet cancellation.
    expect(outcome).toMatchObject({ kind: "transfer", reason: "policy cancellation" });
    expect(modelMessage(outcome)).toMatch(/has NOT run and will not run/);
  });
});
