import { asCallId, asOrganizationId } from "@ansa/shared";
import { describe, expect, it } from "vitest";

import { createCallFacts, type CallIdentity } from "../conversation/call-facts";

import { capturedIdentifierValues } from "./payloads";

/**
 * What leaves the call, and what gets masked before it does.
 *
 * `capturedIdentifierValues` had no test, which is how it kept enumerating three built-in
 * fields for a year after the fact store learned to hold any number of configured ones.
 * The consequence was not a missing feature — it was a organisation with redaction switched
 * on and their callers' national identity numbers still in the transcript.
 */
const IDENTITY: CallIdentity = {
  organizationId: asOrganizationId("11111111-2222-3333-4444-555555555555"),
  callId: asCallId("CA-test"),
  callDirection: "inbound",
};

describe("capturedIdentifierValues", () => {
  it("offers a configured field's value to the redactor", () => {
    const store = createCallFacts(IDENTITY);
    store.observe({ captured: "nin", value: "12345678901", source: "dtmf", atMs: 0 });

    expect(capturedIdentifierValues(store.facts)).toContain("12345678901");
  });

  it("offers every way it was heard, not just the value that settled", () => {
    const store = createCallFacts(IDENTITY);
    store.observe({ captured: "nin", value: "12345678901", source: "stt", atMs: 0 });
    store.observe({ captured: "nin", value: "12345678901", source: "caller-confirmation", atMs: 1 });
    store.observe({ captured: "nin", value: "12345678907", source: "caller-confirmation", atMs: 2 });

    /* A caller reads a number out twice and the transcriber writes it down two ways. Both
       are sitting in the transcript, so masking only the settled one leaves the other in
       full — which is the failure mode this list exists to close. */
    const values = capturedIdentifierValues(store.facts);
    expect(values).toContain("12345678901");
    expect(values).toContain("12345678907");
  });

  it("still covers the built-in fields", () => {
    const store = createCallFacts(IDENTITY);
    store.observe({ field: "policyNumber", value: "PM8592625", source: "dtmf", atMs: 0 });

    expect(capturedIdentifierValues(store.facts)).toContain("PM8592625");
  });

  it("is empty on a call that captured nothing", () => {
    expect(capturedIdentifierValues(createCallFacts(IDENTITY).facts)).toEqual([]);
  });

  it("returns nothing when there are no facts at all", () => {
    // A call that ended before the orchestrator started has no store, and the redactor must
    // not be handed undefined to iterate.
    expect(capturedIdentifierValues(null)).toEqual([]);
  });
});

describe("what the type system refuses", () => {
  it("will not let the model author a configured identifier", () => {
    const store = createCallFacts(IDENTITY);
    // @ts-expect-error the captured arm takes EvidenceSource, which has no "model" member.
    // The model may summarise a call; it may not decide what somebody's NIN is. Enforced
    // by the union rather than by a runtime check, so the mistake cannot be shipped.
    store.observe({ captured: "nin", value: "12345678901", source: "model", atMs: 0 });
  });
});
