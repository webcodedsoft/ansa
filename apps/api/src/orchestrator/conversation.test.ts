import { describe, expect, it } from "vitest";

import { createConversation } from "./conversation";

describe("createConversation", () => {
  it("records caller and agent turns in order", () => {
    const c = createConversation();
    c.addAgent("Thank you for calling Ansa.");
    c.addCaller("When does my policy renew?");
    c.addAgent("It renews in May.");

    expect(c.messages).toEqual([
      { role: "assistant", content: "Thank you for calling Ansa." },
      { role: "user", content: "When does my policy renew?" },
      { role: "assistant", content: "It renews in May." },
    ]);
  });

  it("ignores empty turns", () => {
    const c = createConversation();
    c.addCaller("   ");
    c.addAgent("");

    expect(c.messages).toEqual([]);
  });

  // The property barge-in exists to protect. If the unheard remainder stays, the agent
  // refers back to things the caller never heard: "as I mentioned, it renews in May".
  it("keeps only what the caller heard when interrupted mid-sentence", () => {
    const c = createConversation();
    c.addCaller("hello");
    c.addAgent("Your policy renews in May and your premium has not changed.");

    c.truncateLastAgent(26);

    expect(c.messages[1]).toEqual({ role: "assistant", content: "Your policy renews in May" });
  });

  it("drops the turn entirely when interrupted before anything was heard", () => {
    const c = createConversation();
    c.addCaller("hello");
    c.addAgent("Your policy renews in May.");

    c.truncateLastAgent(0);

    expect(c.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("leaves the turn intact when everything was heard", () => {
    const c = createConversation();
    c.addAgent("It renews in May.");

    c.truncateLastAgent(500);

    expect(c.messages[0]?.content).toBe("It renews in May.");
  });

  it("never truncates a caller turn", () => {
    const c = createConversation();
    c.addAgent("Hello.");
    c.addCaller("My policy number is AB417.");

    c.truncateLastAgent(3);

    expect(c.messages[1]?.content).toBe("My policy number is AB417.");
  });

  it("does nothing on an empty conversation", () => {
    const c = createConversation();
    expect(() => c.truncateLastAgent(5)).not.toThrow();
    expect(c.messages).toEqual([]);
  });
});
