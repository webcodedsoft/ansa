import { describe, expect, it } from "vitest";

import { endsMidThought, isBareGreeting } from "./completeness";

describe("endsMidThought", () => {
  it("catches the ending that cost a caller their name", () => {
    // 2026-08-08, 10:54:19. The detector committed here and the agent talked over the
    // name that came next.
    expect(endsMidThought("hi good morning my name is")).toBe(true);
  });

  it("catches the other common danglers", () => {
    for (const said of [
      "my policy number is",
      "i would like to speak to",
      "it expires on the",
      "can you check my",
      "i am calling about a",
    ]) {
      expect(endsMidThought(said), said).toBe(true);
    }
  });

  it("leaves complete turns alone", () => {
    for (const said of [
      "hi good morning my name is adebayo",
      "i want to renew my policy",
      "yes that is correct",
      "how are you doing",
      "what do you do",
      "yes i can",
      "i will",
    ]) {
      expect(endsMidThought(said), said).toBe(false);
    }
  });

  it("does not wait on a lone false start", () => {
    // Answering "and?" with silence would be its own bug.
    expect(endsMidThought("and")).toBe(false);
    expect(endsMidThought("i")).toBe(false);
  });
});

describe("isBareGreeting", () => {
  it("waits on the opening a caller says in one breath", () => {
    // 2026-08-08, 13:55:07. The detector cut after "afternoon", the agent greeted back —
    // having already opened the call with a greeting — and talked over the name.
    expect(isBareGreeting("hi good afternoon")).toBe(true);
    expect(isBareGreeting("hello good morning")).toBe(true);
    expect(isBareGreeting("yes hello")).toBe(true);
  });

  it("answers a single hello immediately", () => {
    // A caller checking the line is alive wants an answer, not a pause.
    expect(isBareGreeting("hello")).toBe(false);
  });

  it("does not wait once there is anything to answer", () => {
    for (const said of [
      "hi my name is sikiru",
      "good afternoon i want to renew",
      "hello can you hear me",
      "sorry what was that",
    ]) {
      expect(isBareGreeting(said), said).toBe(false);
    }
  });

  it("does not swallow a long turn made of small words", () => {
    expect(isBareGreeting("so how are you doing today then my friend")).toBe(false);
  });
});
