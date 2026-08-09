import { Buffer } from "node:buffer";

import type { Db } from "@ansa/db";
import { asTenantId } from "@ansa/shared";
import {
  createToolDispatcher,
  createToolRegistry,
  registerInternalTools,
  HARD_TIMEOUT_MS,
  type InternalTool,
} from "@ansa/tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { silentLog } from "../orchestrator/fakes";
import { createCallRecorder } from "../telephony/event-log";
import { fillerSetup, scenario, type Scenario } from "./harness";

/**
 * The failure drills (Slice 8).
 *
 * CLAUDE.md's rule is one sentence: **every failure must degrade into speech, never into
 * silence.** Most of the handling below already existed — a watchdog, recovery lines, the
 * dispatcher's ceilings — and none of it was ever driven end to end. These drills exist to
 * prove it rather than assume it, and two of them found that the honest answer was silence.
 *
 * They break things at the seams a real outage breaks them at: the listen socket dies, the
 * model hangs, the voice fails halfway through a word, a tenant's endpoint never answers,
 * the database rejects every write, the carrier drops the line. Nothing here is polite
 * about it — a drill that passes because the fake was kind is worse than no drill, so the
 * fakes fail exactly as the real thing does and the assertions are on what the caller
 * would have heard.
 *
 * What they cannot prove: that any of this sounds right on a phone. Only a call does that.
 */

/** Anything longer than this without a sound reads as a dropped call (R6.2). */
const SILENCE_LIMIT_MS = 2_000;

/** The one thing every drill has to establish: the caller heard something. */
const heardSomething = (s: Scenario, sinceBytes: number): boolean =>
  s.stream.bytesSent() > sinceBytes;

/** A tenant's endpoint that accepts the request and never answers it. */
const HANGING_ENDPOINT: InternalTool = {
  definition: {
    name: "check_policy",
    description: "Looks a policy up in the organisation's own system.",
    parameters: { type: "object", properties: {} },
    riskTier: "read",
    summarise: () => "unreachable",
  },
  // Never resolves and never rejects, which is what a hung TCP connection looks like from
  // here. Only the dispatcher's hard ceiling ends it.
  handler: async () => new Promise<never>(() => undefined),
};

/**
 * A tool set built the way the media gateway builds one: the real registry, the real
 * dispatcher, the real ceilings, and the orchestrator's own holding hook.
 *
 * Nothing is shortened. `HARD_TIMEOUT_MS` is three seconds and the drill waits all three,
 * because the number under test is whether the caller is covered for the whole of it.
 */
const withTools = (tools: readonly InternalTool[]): NonNullable<Parameters<typeof scenario>[0]>["makeTools"] =>
  (hooks) => {
    const registry = createToolRegistry();
    registerInternalTools(registry, tools);
    return {
      registry,
      dispatcher: createToolDispatcher({ registry, log: silentLog, holding: hooks.holding }),
    };
  };

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
describe("the listen provider dies mid-call", () => {
  it("apologises before hanging up, and only hangs up once that was heard", () => {
    const s = scenario();
    s.greetingPlays();
    s.says("When does my policy renew?");
    s.agentAnswers("It renews in May.");

    const before = s.stream.bytesSent();
    s.listen.failWith("socket closed with code 1006");

    // An open line the agent cannot hear is worse than a clean ending; ending with no
    // explanation is worse than either.
    expect(s.lastSpoken()).toContain("Sorry");
    expect(s.stream.hungUp).toBe(false);

    s.playsOut();
    expect(heardSomething(s, before)).toBe(true);
    expect(s.stream.hungUp).toBe(true);
    // Countable, not just greppable. Going deaf is the most expensive thing that can
    // happen to a call and it used to leave no trace in the event log at all.
    expect(s.kinds()).toContain("listen_failed");
  });

  it("cuts the agent off mid-sentence rather than talking over a dead connection", () => {
    const s = scenario();
    s.greetingPlays();
    s.says("How do I make a claim?");
    const reply = s.llm.last();
    reply.emit("You call us first. ");
    reply.emit("Then you send the form. ");
    s.tts.last().audio(1600);

    s.listen.failWith("socket closed with code 1006");

    // The in-flight synthesis is cancelled and the LLM with it: neither is producing
    // anything a caller will ever hear.
    expect(s.tts.syntheses.some((x) => x.cancelled)).toBe(true);
    expect(reply.cancelled).toBe(true);
    expect(s.lastSpoken()).toContain("Sorry");
  });

  /**
   * Found by this drill, and fixed in the orchestrator.
   *
   * A turn held back for a continuation kept its 1.1 second timer through the failure, so
   * about a second after the goodbye the call started an LLM request and opened a new turn
   * — on a line it had already asked the carrier to hang up.
   */
  it("does not start a model turn after it has gone deaf", async () => {
    vi.useFakeTimers();
    const s = scenario();
    s.greetingPlays();
    // Deliberately unfinished, so the continuation hold is armed.
    s.says("Hi. Good morning. My name is.");
    expect(s.llm.completions).toHaveLength(0);

    s.listen.failWith("socket closed with code 1006");
    s.playsOut();
    const spokenAtFailure = s.spoken().length;

    await vi.advanceTimersByTimeAsync(5_000);

    expect(s.llm.completions).toHaveLength(0);
    expect(s.spoken()).toHaveLength(spokenAtFailure);
  });

  it("carries on through a recoverable vendor complaint", () => {
    const s = scenario();
    s.greetingPlays();

    s.listen.vendorError("rate limited, retrying");
    s.says("Is my cover still active?");
    s.agentAnswers("Yes, it is active.");

    expect(s.lastSpoken()).toBe("Yes, it is active.");
    expect(s.stream.hungUp).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("the model", () => {
  it("covers a model that never answers at all", async () => {
    vi.useFakeTimers();
    const s = scenario({ ...fillerSetup() });
    s.greetingPlays();

    const before = s.stream.bytesSent();
    s.listen.endOfTurn(1_000);
    s.says("When does my policy renew?");
    // The completion exists and produces nothing, forever. This is a hung request, not an
    // error: nothing will ever call back, which is why only a timer can rescue it.
    expect(s.llm.completions).toHaveLength(1);

    // Sound well inside the two-second rule, from the thinking-gap acknowledgement.
    await vi.advanceTimersByTimeAsync(SILENCE_LIMIT_MS);
    expect(heardSomething(s, before)).toBe(true);

    // And then a real turn, apologising, rather than an indefinite wait.
    await vi.advanceTimersByTimeAsync(3_000);
    s.playsOut();
    expect(s.lastSpoken()).toContain("Sorry");
    expect(s.stream.hungUp).toBe(false);
    expect(s.eventsOf("recovery_line").at(-1)?.detail["reason"]).toBe("turn watchdog");
  });

  it("apologises when the model fails before a single token", () => {
    const s = scenario();
    s.greetingPlays();

    s.says("When does my policy renew?");
    s.llm.last().fail("openai returned 429");
    s.playsOut();

    expect(s.lastSpoken()).toContain("Sorry");
    expect(s.stream.hungUp).toBe(false);
    expect(s.eventsOf("recovery_line").at(-1)?.detail["reason"]).toBe("llm failed");
  });

  it("apologises when the model fails halfway through a sentence, and forgets the rest", () => {
    const s = scenario();
    s.greetingPlays();

    s.says("How do I make a claim?");
    const reply = s.llm.last();
    reply.emit("You call us first. ");
    s.tts.last().audio(1600);
    s.tts.last().done();
    s.stream.ackAll();

    reply.fail("upstream closed the stream");
    s.playsOut();

    expect(s.lastSpoken()).toContain("Sorry");
    // The half-produced turn must not be left in history as though it were said in full:
    // the model would reference a second half the caller never heard.
    const assistant = [...s.llm.lastMessages()].reverse().find((m) => m.role === "assistant");
    expect(assistant?.content ?? "").not.toContain("send the form");
  });

  it("still recovers when the model asks for a tool on a call that has none", () => {
    // An unregistered number: tool calling is disabled outright for the whole call, and a
    // model that asks anyway must not leave the turn open with nothing coming.
    const s = scenario({ tenantId: null });
    s.greetingPlays();

    s.says("Is my policy active?");
    s.llm.last().callTools([{ name: "check_policy", args: {} }]);
    s.playsOut();

    expect(s.lastSpoken()).toContain("Sorry");
    expect(s.stream.hungUp).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("the voice", () => {
  it("ends the call rather than holding an open line it cannot speak on", () => {
    const s = scenario();

    // The greeting itself. Nothing has been said and nothing can be.
    s.tts.last().fail("elevenlabs returned 500");
    expect(s.tts.texts()).toHaveLength(2); // one retry, because transient is common here
    s.tts.last().fail("elevenlabs returned 500");

    expect(s.stream.hungUp).toBe(true);
    expect(s.kinds().filter((k) => k === "tts_failed")).toHaveLength(2);
  });

  it("re-says a sentence that failed halfway, so the answer survives", () => {
    const s = scenario();
    s.greetingPlays();
    s.says("When does my policy renew?");
    const reply = s.llm.last();
    reply.emit("It renews in May. ");
    reply.finish();

    s.tts.last().audio(1600);
    s.tts.last().fail("the stream dropped");

    // The whole sentence again rather than the remainder: the caller hears a few syllables
    // twice, which is cheaper than losing the answer.
    expect(s.tts.texts().at(-1)).toBe("It renews in May.");
    s.playsOut();
    expect(s.stream.hungUp).toBe(false);
  });

  it("says the rest of the turn when one sentence cannot be synthesised at all", () => {
    const s = scenario();
    s.greetingPlays();
    s.says("How do I make a claim?");
    const reply = s.llm.last();
    reply.emit("You call us first. ");
    reply.emit("Then you send the form. ");
    reply.finish();

    s.tts.last().audio(1600);
    s.tts.last().fail("the stream dropped");
    s.tts.last().audio(1600);
    s.tts.last().fail("the stream dropped again");

    // Two attempts at the first sentence, then on to the second rather than abandoning
    // the turn.
    expect(s.tts.texts().at(-1)).toBe("Then you send the form.");
    s.playsOut();
    expect(s.stream.hungUp).toBe(false);
    expect(s.eventsOf("tts_sentence_dropped")).toHaveLength(1);
  });

  /**
   * The honest answer here is a truncated sentence, not a recovery line, and that is a
   * deliberate choice rather than an oversight: the only provider available to apologise
   * has just failed twice.
   *
   * What the drill found is that it was also *invisible* — the turn was recorded as
   * `turn_complete`, identical to one that played out in full, so no metric and no review
   * queue could ever see it. It is named in the log now.
   */
  it("names a turn that stopped mid-sentence instead of scoring it as a success", () => {
    const s = scenario();
    s.greetingPlays();
    s.says("When does my policy renew?");
    const reply = s.llm.last();
    reply.emit("It renews in May. ");
    reply.finish();

    const heard = s.stream.bytesSent();
    s.tts.last().audio(1600);
    s.tts.last().fail("the stream dropped");
    s.tts.last().audio(1600);
    s.tts.last().fail("the stream dropped again");
    s.stream.ackAll();

    // Not silence: the caller heard the start of the answer.
    expect(heardSomething(s, heard)).toBe(true);
    // Not a success either, and the log now says so.
    expect(s.eventsOf("tts_sentence_dropped")).toHaveLength(1);
    expect(s.eventsOf("tts_failed")).toHaveLength(2);
    // The line stays open and the next thing the caller says is answered normally.
    expect(s.stream.hungUp).toBe(false);
    s.says("Sorry, when was that?");
    expect(s.llm.completions.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
describe("a tenant's endpoint hangs past the hard ceiling", () => {
  it("covers the wait with sound and tells the model nothing happened", async () => {
    vi.useFakeTimers();
    const s = scenario({ ...fillerSetup(), makeTools: withTools([HANGING_ENDPOINT]) });
    s.greetingPlays();
    s.says("Is my policy active?");

    const before = s.stream.bytesSent();
    s.llm.last().callTools([{ name: "check_policy", args: {} }]);

    // R5.4.2: holding speech starts when the tool is dispatched, not when it returns.
    // Synchronously, before the adapter runs — by the time the promise settles the silence
    // has already happened.
    expect(heardSomething(s, before)).toBe(true);

    await vi.advanceTimersByTimeAsync(HARD_TIMEOUT_MS + 100);

    // The ceiling held and the model was told, in words it cannot round off, that the
    // lookup did not happen.
    const notes = [...s.llm.lastMessages()].reverse().find((m) => m.role === "user")?.content ?? "";
    expect(notes).toContain("FAILED");
    expect(notes).toContain("timeout");
    expect(s.eventsOf("tool_call").at(-1)?.detail["outcome"]).toBe("failed");
    expect(s.stream.hungUp).toBe(false);
  });

  it("does not wait past the ceiling before the caller hears an answer", async () => {
    vi.useFakeTimers();
    const s = scenario({ ...fillerSetup(), makeTools: withTools([HANGING_ENDPOINT]) });
    s.greetingPlays();
    s.says("Is my policy active?");
    s.llm.last().callTools([{ name: "check_policy", args: {} }]);

    // One millisecond short of the ceiling the model has not been asked anything yet.
    await vi.advanceTimersByTimeAsync(HARD_TIMEOUT_MS - 1);
    const beforeCeiling = s.llm.completions.length;
    await vi.advanceTimersByTimeAsync(2);
    expect(s.llm.completions.length).toBeGreaterThan(beforeCeiling);

    s.agentAnswers("Sorry, I could not reach that just now.");
    expect(s.lastSpoken()).toContain("Sorry");
  });

  it("never speaks a result that arrived after the caller hung up", async () => {
    vi.useFakeTimers();
    const s = scenario({ ...fillerSetup(), makeTools: withTools([HANGING_ENDPOINT]) });
    s.greetingPlays();
    s.says("Is my policy active?");
    s.llm.last().callTools([{ name: "check_policy", args: {} }]);

    s.stream.closeCall("carrier sent stop");
    const spokenAtClose = s.spoken().length;
    const completionsAtClose = s.llm.completions.length;

    await vi.advanceTimersByTimeAsync(HARD_TIMEOUT_MS + 5_000);

    expect(s.spoken()).toHaveLength(spokenAtClose);
    expect(s.llm.completions).toHaveLength(completionsAtClose);
    expect(s.listen.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("the database is unreachable mid-call", () => {
  /** Every query rejects, which is what a dropped pool looks like from the recorder. */
  const rejectingDb = (): Db =>
    ({
      query: async (): Promise<never> => {
        throw new Error("connection terminated unexpectedly");
      },
    }) as unknown as Db;

  it("does not touch the conversation", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      // The real recorder, over a database that rejects everything. Not a stub: the whole
      // claim under test is that this particular code swallows, and a stub would be
      // testing the stub.
      const recorder = createCallRecorder({ dataSource: rejectingDb(), log: silentLog });
      const s = scenario({ alsoRecordTo: recorder });
      recorder.started({
        tenantId: asTenantId("5c3d0a5e-1f6d-4f6f-9b3a-0f2d7c8a4e11"),
        carrierCallId: "CA-drill",
        direction: "inbound",
        dialled: "unknown",
        caller: null,
        configVersion: null,
      });

      s.greetingPlays();
      s.says("When does my policy renew?");
      s.agentAnswers("It renews in May.");
      s.says("And how much is my premium?");
      s.agentAnswers("It is forty thousand naira.");
      recorder.ended("carrier sent stop", null, 30);

      // The caller's side of the call is untouched by any of it.
      expect(s.lastSpoken()).toBe("It is forty thousand naira.");
      expect(s.stream.hungUp).toBe(false);

      // Let every rejected write settle. A recorder that leaks one takes the process down
      // in production, which would turn a database blip into a dropped call for everyone.
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// ---------------------------------------------------------------------------
describe("the carrier drops the socket", () => {
  it("stops producing audio and closes the listener", () => {
    const s = scenario();
    s.greetingPlays();
    s.says("How do I make a claim?");
    const reply = s.llm.last();
    reply.emit("You call us first. ");
    s.tts.last().audio(1600);

    s.stream.closeCall("carrier sent stop");
    const bytesAtClose = s.stream.bytesSent();

    // Anything still in flight is cancelled, and audio produced after the close is
    // discarded rather than sent to a socket that is gone.
    expect(s.listen.closed).toBe(true);
    expect(reply.cancelled).toBe(true);
    s.tts.syntheses.forEach((x) => x.audio(1600));
    expect(s.stream.bytesSent()).toBe(bytesAtClose);
  });

  it("drops a continuation the caller will never finish", async () => {
    vi.useFakeTimers();
    const s = scenario();
    s.greetingPlays();
    s.says("Hi. Good morning. My name is.");

    s.stream.closeCall("caller hung up");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(s.llm.completions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("the two-second rule", () => {
  /**
   * The backstop behind every other drill. A caller who spoke and whose words were thrown
   * away — as line noise, or as a transcript invented from silence — has no turn running
   * and nothing downstream will ever run for them either.
   */
  it("answers a caller whose only transcript was discarded as invented", async () => {
    vi.useFakeTimers();
    const s = scenario({ ...fillerSetup(), minSpeechMs: 160 });
    s.greetingPlays();

    const before = s.stream.bytesSent();
    s.listen.endOfTurn(1_000);
    // No speech behind it, so it is discarded — the caller is now owed a reply that
    // nothing is going to produce.
    s.says("Ay, mi nombre es Pikachu.");
    expect(s.kinds()).toContain("hallucination discarded");

    await vi.advanceTimersByTimeAsync(SILENCE_LIMIT_MS);
    expect(heardSomething(s, before)).toBe(true);

    await vi.advanceTimersByTimeAsync(4_000);
    s.playsOut();
    expect(s.lastSpoken()).toContain("Sorry");
    expect(s.eventsOf("recovery_line").at(-1)?.detail["reason"]).toBe("no transcript");
  });

  it("makes a sound rather than leaving the thinking gap silent", async () => {
    vi.useFakeTimers();
    const s = scenario({ ...fillerSetup() });
    s.greetingPlays();

    const before = s.stream.bytesSent();
    s.listen.endOfTurn(1_000);
    await vi.advanceTimersByTimeAsync(SILENCE_LIMIT_MS);

    expect(heardSomething(s, before)).toBe(true);
    // And it is never remembered: the agent did not say anything it should be held to.
    expect(Buffer.isBuffer(s.stream.sent[0]?.data)).toBe(true);
  });
});
