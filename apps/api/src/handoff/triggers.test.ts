import { describe, expect, it } from "vitest";

import { asksForAPerson, createEscalationWatch } from "./triggers";

describe("asksForAPerson", () => {
  it.each([
    "Can I speak to a human please",
    "I want to talk to a person",
    "Put me through to someone",
    "Transfer me to an agent",
    "Please connect me to customer service",
    "Let me speak to your manager",
    "I need to talk to a real person",
    "Abeg give me person",
    "I wan talk to somebody",
    "Make I talk to person",
    "Could I speak with a representative",
  ])("hears %j as a request for a person", (text) => {
    expect(asksForAPerson(text)).toBe(true);
  });

  it.each([
    "I spoke to someone yesterday and they said it was fine",
    "Is there someone who handles motor claims",
    "My agent number is four one seven",
    "Are you a person or a computer",
    "Can you tell me my renewal date",
    "The manager of my branch is called Ada",
    "I talked to a representative last week about this",
  ])("does not hear %j as one", (text) => {
    expect(asksForAPerson(text)).toBe(false);
  });

  it("hears the request inside a longer turn", () => {
    expect(
      asksForAPerson("This is not working at all. Can you put me through to a human being?"),
    ).toBe(true);
  });
});

describe("createEscalationWatch", () => {
  it("escalates the moment a person is asked for", () => {
    const watch = createEscalationWatch();
    expect(watch.callerSaid("What is my balance")).toBeNull();
    expect(watch.callerSaid("Just put me through to someone")?.kind).toBe("asked-for-a-person");
  });

  it("escalates on the third failed turn, not the first (R6.4)", () => {
    const watch = createEscalationWatch();
    expect(watch.misunderstood("no transcript")).toBeNull();
    expect(watch.misunderstood("recovery line")).toBeNull();
    const trigger = watch.misunderstood("caller asked us to repeat");
    expect(trigger?.kind).toBe("repeated-misunderstanding");
    expect(trigger?.detail).toContain("caller asked us to repeat");
  });

  it("forgets failures once a turn lands", () => {
    // R6.4 is three failures on the same intent, not three across a call that recovered.
    const watch = createEscalationWatch();
    watch.misunderstood("a");
    watch.misunderstood("b");
    watch.understood();
    expect(watch.misunderstood("c")).toBeNull();
    expect(watch.misunderstood("d")).toBeNull();
    expect(watch.misunderstood("e")?.kind).toBe("repeated-misunderstanding");
  });

  it("gives a tool one failure and not two", () => {
    const watch = createEscalationWatch();
    // Connectors time out. A caller transferred on the first blip would be transferred
    // constantly.
    expect(watch.toolFailed("lookup_policy", "timeout")).toBeNull();
    expect(watch.toolFailed("lookup_policy", "error")?.kind).toBe("tool-failed");
  });

  it("always escalates when capture has run out of ways to ask", () => {
    expect(createEscalationWatch().captureFailed()?.kind).toBe("capture-failed");
  });

  it("escalates once, whatever fires second", () => {
    // Two triggers on the same turn would otherwise start a second transfer over the
    // first mid-dial.
    const watch = createEscalationWatch();
    expect(watch.callerSaid("please transfer me to a person")).not.toBeNull();
    expect(watch.captureFailed()).toBeNull();
    expect(watch.misunderstood("x")).toBeNull();
    expect(watch.handedOver()).toBe(true);
  });
});
