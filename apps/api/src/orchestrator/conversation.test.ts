import { describe, expect, it } from "vitest";

import { createConversation } from "./conversation";

describe("createConversation", () => {
  it("records caller and agent turns in order", () => {
    const c = createConversation();
    c.recordAgentTurn(1, "Thank you for calling Ansa.");
    c.addCaller("When does my policy renew?");
    c.recordAgentTurn(2, "It renews in May.");

    expect(c.messages).toEqual([
      { role: "assistant", content: "Thank you for calling Ansa." },
      { role: "user", content: "When does my policy renew?" },
      { role: "assistant", content: "It renews in May." },
    ]);
  });

  it("ignores empty caller turns", () => {
    const c = createConversation();
    c.addCaller("   ");

    expect(c.messages).toEqual([]);
  });

  // Playback progresses, so the same turn is recorded several times as more is heard.
  it("replaces rather than appends when the same turn reports more heard", () => {
    const c = createConversation();
    c.addCaller("hello");
    c.recordAgentTurn(2, "Your policy");
    c.recordAgentTurn(2, "Your policy renews in May");
    c.recordAgentTurn(2, "Your policy renews in May and the premium is unchanged.");

    expect(c.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Your policy renews in May and the premium is unchanged." },
    ]);
  });

  it("keeps only what the caller heard when interrupted mid-turn", () => {
    const c = createConversation();
    c.addCaller("hello");
    c.recordAgentTurn(2, "Your policy renews in May and the premium is unchanged.");

    c.recordAgentTurn(2, "Your policy renews in May");

    expect(c.messages[1]).toEqual({ role: "assistant", content: "Your policy renews in May" });
  });

  it("drops the turn entirely when nothing was heard", () => {
    const c = createConversation();
    c.addCaller("hello");
    c.recordAgentTurn(2, "Your policy renews in May.");

    c.recordAgentTurn(2, "");

    expect(c.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("never records an agent turn that was never heard at all", () => {
    const c = createConversation();
    c.addCaller("hello");

    c.recordAgentTurn(2, "");

    expect(c.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  // A greeting followed by a recovery line, with no caller turn between them. Without
  // keying on seq the second would overwrite the first.
  it("appends a second agent turn rather than overwriting the first", () => {
    const c = createConversation();
    c.recordAgentTurn(1, "Thank you for calling Ansa.");
    c.recordAgentTurn(2, "Sorry, I did not catch that.");

    expect(c.messages).toEqual([
      { role: "assistant", content: "Thank you for calling Ansa." },
      { role: "assistant", content: "Sorry, I did not catch that." },
    ]);
  });

  it("does not disturb a caller turn recorded after the agent's", () => {
    const c = createConversation();
    c.recordAgentTurn(1, "Thank you for calling Ansa.");
    c.addCaller("My policy number is AB417.");

    c.recordAgentTurn(1, "Thank you");

    expect(c.messages[1]).toEqual({ role: "user", content: "My policy number is AB417." });
    expect(c.messages).toHaveLength(3);
  });
});
