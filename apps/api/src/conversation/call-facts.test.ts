import { asCallId, asTenantId } from "@ansa/shared";
import { describe, expect, it } from "vitest";

import {
  confirmedFact,
  createCallFacts,
  type CallIdentity,
  type Observation,
} from "./call-facts";

const IDENTITY: CallIdentity = {
  tenantId: asTenantId("11111111-2222-3333-4444-555555555555"),
  callId: asCallId("CA-test"),
  callDirection: "inbound",
};

const facts = () => createCallFacts(IDENTITY);

const heard = (value: string, atMs = 0): Observation => ({
  field: "callerName",
  value,
  source: "stt",
  atMs,
});

describe("createCallFacts", () => {
  it("carries the tenant and the call on every snapshot", () => {
    const store = facts();
    expect(store.facts.tenantId).toBe(IDENTITY.tenantId);
    expect(store.facts.callId).toBe(IDENTITY.callId);
    expect(store.facts.callDirection).toBe("inbound");
  });

  it("starts with nothing known and nothing usable", () => {
    const store = facts();
    expect(store.facts.callerName.status).toBe("UNKNOWN");
    expect(store.facts.callerNameConfirmed).toBe(false);
    expect(confirmedFact(store.facts.callerName)).toBeNull();
  });
});

describe("evidence for an identifier", () => {
  // A single STT result is not evidence. This is the same reasoning capture.ts uses when
  // it offers the most-repeated candidate rather than the most recent one.
  it("treats one transcription result as uncertain and unusable", () => {
    const store = facts();
    const change = store.observe(heard("Ada Obi"));

    expect(change.reason).toBe("set");
    expect(store.facts.callerName.status).toBe("UNCERTAIN");
    expect(confirmedFact(store.facts.callerName)).toBeNull();
  });

  it("promotes to known when a second result agrees, and still refuses to hand it out", () => {
    const store = facts();
    store.observe(heard("Ada Obi"));
    const change = store.observe(heard("ada obi", 10));

    expect(change.reason).toBe("agreed");
    expect(store.facts.callerName.status).toBe("KNOWN");
    expect(store.facts.callerNameConfirmed).toBe(false);
    expect(confirmedFact(store.facts.callerName)).toBeNull();
  });

  // Spelling is deliberate and letter by letter, so it beats one pass of an 8kHz
  // transcriber — but it is still speech and R4.3.1 does not exempt speech from readback.
  it("takes a spelling as known, never as confirmed", () => {
    const store = facts();
    const change = store.observe({
      field: "callerName",
      value: "Ada Obi",
      source: "spelling",
      atMs: 0,
    });

    expect(change.status).toBe("KNOWN");
    expect(confirmedFact(store.facts.callerName)).toBeNull();
  });

  it("confirms on the caller agreeing, and only then hands the value out", () => {
    const store = facts();
    store.observe(heard("Ada Obi"));
    const change = store.observe({
      field: "callerName",
      value: "Ada Obi",
      source: "caller-confirmation",
      atMs: 20,
    });

    expect(change.reason).toBe("confirmed");
    expect(store.facts.callerNameConfirmed).toBe(true);
    expect(confirmedFact(store.facts.callerName)).toBe("Ada Obi");
  });

  // Keypad tones are unambiguous in a way speech is not, so there is nothing for a
  // readback to catch — capture.ts makes the same call.
  it("confirms keypad digits without a readback", () => {
    const store = facts();
    store.observe({ field: "policyNumber", value: "04172", source: "dtmf", atMs: 0 });

    expect(store.facts.policyNumberConfirmed).toBe(true);
    expect(confirmedFact(store.facts.policyNumber)).toBe("04172");
  });

  it("confirms a value that came from a system of record", () => {
    const store = facts();
    store.observe({ field: "customerId", value: "C-9931", source: "business-rule", atMs: 0 });

    expect(confirmedFact(store.facts.customerId)).toBe("C-9931");
  });

  it("refuses an empty value rather than blanking what it holds", () => {
    const store = facts();
    store.observe(heard("Ada Obi"));
    const change = store.observe(heard("   ", 5));

    expect(change.reason).toBe("refused");
    expect(store.facts.callerName.value).toBe("Ada Obi");
  });
});

describe("the model may not mutate an identifier", () => {
  // The union has no arm pairing an identifier with source "model", so this call does not
  // compile. The cast reproduces the one way it can happen in production: an observation
  // built from a model tool call, which is parsed JSON and was never type-checked.
  it("refuses a model-sourced name outright", () => {
    const store = facts();
    const fromModel = {
      field: "callerName",
      value: "Adeyemo",
      source: "model",
      atMs: 0,
    } as unknown as Observation;

    const change = store.observe(fromModel);

    expect(change.reason).toBe("refused");
    expect(store.facts.callerName.status).toBe("UNKNOWN");
    expect(store.facts.callerName.value).toBeNull();
  });

  it("will not let the model overwrite a confirmed policy number", () => {
    const store = facts();
    store.observe({ field: "policyNumber", value: "04172", source: "dtmf", atMs: 0 });
    store.observe({
      field: "policyNumber",
      value: "04173",
      source: "model",
      atMs: 5,
    } as unknown as Observation);

    expect(confirmedFact(store.facts.policyNumber)).toBe("04172");
  });

  it("does let the model say what the caller wants", () => {
    const store = facts();
    const change = store.observe({
      field: "intent",
      value: "make a claim",
      source: "model",
      atMs: 0,
    });

    expect(change.reason).toBe("set");
    expect(store.facts.intent.status).toBe("KNOWN");
    expect(store.facts.intent.value).toBe("make a claim");
  });
});

describe("corrections", () => {
  it("replaces an unconfirmed value with a new one and remembers that it changed", () => {
    const store = facts();
    store.observe(heard("Adeyemi"));
    const change = store.observe(heard("Adeyemo", 10));

    expect(change.reason).toBe("corrected");
    expect(store.facts.callerName.value).toBe("Adeyemo");
    expect(store.facts.previousCorrections).toEqual([
      { field: "callerName", from: "Adeyemi", to: "Adeyemo", source: "stt", atMs: 10 },
    ]);
  });

  // The failure this exists to prevent: the caller heard the number back and agreed, then
  // the transcriber slipped one digit on an unrelated turn and the tool call went to a
  // different account with nothing on the call to show for it.
  it("does not let a transcription result overwrite a confirmed value", () => {
    const store = facts();
    store.observe({
      field: "policyNumber",
      value: "04172",
      source: "caller-confirmation",
      atMs: 0,
    });
    const change = store.observe({
      field: "policyNumber",
      value: "04173",
      source: "stt",
      atMs: 10,
    });

    expect(change.reason).toBe("contested");
    expect(change.applied).toBe(false);
    expect(confirmedFact(store.facts.policyNumber)).toBe("04172");
    expect(store.facts.previousCorrections).toHaveLength(0);
  });

  it("lets the caller correct a value they had already confirmed", () => {
    const store = facts();
    store.observe({
      field: "policyNumber",
      value: "04172",
      source: "caller-confirmation",
      atMs: 0,
    });
    store.observe({
      field: "policyNumber",
      value: "04173",
      source: "caller-confirmation",
      atMs: 10,
    });

    expect(confirmedFact(store.facts.policyNumber)).toBe("04173");
    expect(store.facts.previousCorrections).toHaveLength(1);
  });

  it("hands out a copy of the corrections, not the list it keeps", () => {
    const store = facts();
    store.observe(heard("Adeyemi"));
    store.observe(heard("Adeyemo", 10));

    const taken = store.facts.previousCorrections as unknown as { field: string }[];
    taken.push({ field: "customerId" });

    expect(store.facts.previousCorrections).toHaveLength(1);
  });
});

describe("interpretive fields", () => {
  it("forgets a pending question once it has been answered", () => {
    const store = facts();
    store.observe({
      field: "pendingQuestion",
      value: "Is that the policy ending seven two?",
      source: "model",
      atMs: 0,
    });
    expect(store.facts.pendingQuestion.value).not.toBeNull();

    store.clear("pendingQuestion");
    expect(store.facts.pendingQuestion.status).toBe("UNKNOWN");
    expect(store.facts.pendingQuestion.value).toBeNull();
  });

  it("confirms what the caller wants when the caller says so themselves", () => {
    const store = facts();
    const change = store.observe({
      field: "intent",
      value: "make a claim",
      source: "caller-confirmation",
      atMs: 0,
    });

    expect(change.reason).toBe("confirmed");
    expect(store.facts.intent.status).toBe("CONFIRMED");
  });
});

// The charter's done-when, stated as a test: told once, usable for the rest of the call.
describe("do not ask for what the caller already gave", () => {
  it("still holds a confirmed name many turns later", () => {
    const store = facts();
    store.observe(heard("Ada Obi"));
    store.observe({
      field: "callerName",
      value: "Ada Obi",
      source: "caller-confirmation",
      atMs: 10,
    });

    for (let turn = 0; turn < 20; turn += 1) {
      store.observe({ field: "currentTask", value: `turn ${turn}`, source: "model", atMs: turn });
    }

    expect(confirmedFact(store.facts.callerName)).toBe("Ada Obi");
    expect(store.facts.callerNameConfirmed).toBe(true);
  });
});
