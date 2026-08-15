import { asCallId, asOrganizationId } from "@ansa/shared";
import { describe, expect, it } from "vitest";

import { createCallFacts, type CallIdentity } from "./call-facts";
import { renderFacts } from "./facts-prompt";

const IDENTITY: CallIdentity = {
  organizationId: asOrganizationId("11111111-2222-3333-4444-555555555555"),
  callId: asCallId("CA-test"),
  callDirection: "inbound",
};

const facts = () => createCallFacts(IDENTITY);

describe("renderFacts", () => {
  it("renders nothing on a call where nothing is known yet", () => {
    expect(renderFacts(facts().facts)).toBe("");
  });

  it("gives the model a confirmed name to use", () => {
    const store = facts();
    store.observe({
      field: "callerName",
      value: "Ada Obi",
      source: "caller-confirmation",
      atMs: 0,
    });

    const block = renderFacts(store.facts);
    expect(block).toContain("Ada Obi");
    expect(block).toContain("You may use it.");
    expect(block).toContain("Do not ask for any of it again.");
  });

  // The one that matters. A model that can see the candidate will say it back — "thanks,
  // Adeyemi" — and the caller hears a wrong name asserted as fact by the same agent that
  // is supposedly still checking it.
  it("never shows the value of an identifier the caller has not confirmed", () => {
    const store = facts();
    store.observe({ field: "callerName", value: "Adeyemi", source: "stt", atMs: 0 });
    store.observe({ field: "policyNumber", value: "04172", source: "stt", atMs: 5 });

    const block = renderFacts(store.facts);
    expect(block).not.toContain("Adeyemi");
    expect(block).not.toContain("04172");
    expect(block).toContain("still checking it");
    // And it must still stop the agent asking again, which is the whole point of showing
    // the line at all.
    expect(block).toContain("do not ask for it again");
  });

  it("says nothing at all about an identifier it has never heard", () => {
    const store = facts();
    store.observe({ field: "intent", value: "make a claim", source: "model", atMs: 0 });

    const block = renderFacts(store.facts);
    expect(block).not.toContain("customer id");
    expect(block).not.toContain("policy number");
  });

  it("marks the model's own reading as unconfirmed", () => {
    const store = facts();
    store.observe({ field: "intent", value: "make a claim", source: "model", atMs: 0 });

    expect(renderFacts(store.facts)).toContain("make a claim (your reading, not confirmed)");
  });

  it("names the records when a value came from a system of record", () => {
    const store = facts();
    store.observe({ field: "customerId", value: "C-9931", source: "business-rule", atMs: 0 });

    expect(renderFacts(store.facts)).toContain("It came from our records.");
  });

  it("shows an unanswered question as still open", () => {
    const store = facts();
    store.observe({
      field: "pendingQuestion",
      value: "Is that the policy ending seven two?",
      source: "model",
      atMs: 0,
    });

    expect(renderFacts(store.facts)).toContain("They have not answered yet.");
  });

  // Telling the model what the caller corrected away is the surest way to put that value
  // back in its mouth, so a correction renders as a count and never as the old value.
  it("reports a correction without repeating the value that was corrected", () => {
    const store = facts();
    store.observe({ field: "callerName", value: "Adeyemi", source: "stt", atMs: 0 });
    store.observe({ field: "callerName", value: "Adeyemo", source: "stt", atMs: 10 });
    store.observe({
      field: "callerName",
      value: "Adeyemo",
      source: "caller-confirmation",
      atMs: 20,
    });

    const block = renderFacts(store.facts);
    expect(block).toContain("already corrected their name once");
    expect(block).not.toContain("Adeyemi");
    expect(block).toContain("Adeyemo");
  });

  it("always states the rule that the model may not change an identifier itself", () => {
    const store = facts();
    store.observe({ field: "currentTask", value: "taking their policy number", source: "model", atMs: 0 });

    expect(renderFacts(store.facts)).toContain("Never change a name or a number yourself.");
  });
});

/**
 * The operator's own fields, in the block the model reads.
 *
 * These were missing, and the symptom was the one thing capture exists to prevent: the
 * caller gives their claim number, agrees to the readback, and is asked for it again a turn
 * later — because the only place it had been written down was the fact store's `captured`
 * map, and nothing rendered it.
 */
describe("renderFacts with configured fields", () => {
  const withClaim = () => {
    const store = facts();
    store.observe({
      captured: "claimNumber",
      value: "CL8421",
      source: "caller-confirmation",
      atMs: 0,
    });
    return store;
  };

  it("gives the model a confirmed value it can actually use", () => {
    const block = renderFacts(withClaim().facts);
    expect(block).toContain("CL8421");
    // By the key, because the task layer asks for it by the key. The model has to see the
    // instruction and the value as the same subject.
    expect(block).toContain("claimNumber");
  });

  it("withholds the value while it is still being checked", () => {
    const store = facts();
    store.observe({ captured: "claimNumber", value: "CL8421", source: "stt", atMs: 0 });

    // Same rule as an identifier: unconfirmed means the model is told it exists and not
    // what it is, so it cannot answer around a value nobody has agreed to.
    const block = renderFacts(store.facts);
    expect(block).not.toContain("CL8421");
    expect(block).toContain("do not ask for it again");
  });

  it("tells the model a configured field was corrected", () => {
    const store = withClaim();
    store.observe({
      captured: "claimNumber",
      value: "CL8422",
      source: "caller-confirmation",
      atMs: 1,
    });

    // A correction the model is not told about is the one it undoes, going back to the
    // value the caller has already rejected once.
    expect(renderFacts(store.facts)).toContain("already corrected");
  });
});
