import type { Message } from "@ansa/llm";
import { describe, expect, it } from "vitest";

import type { AudioChunk } from "@ansa/shared";

import { asCallId, asTenantId, type BusinessHours, type TenantId } from "@ansa/shared";
import {
  callControlTools,
  createToolDispatcher,
  createToolRegistry,
  registerInternalTools,
  type InternalTool,
} from "@ansa/tools";

import { chunkOf, fakeListen, fakeLlm, fakeStream, fakeTts, silentLog } from "./fakes";
import { createCallFacts, type CallFactsStore } from "../conversation/call-facts";
import { DEFAULT_SYSTEM_PROMPT } from "../prompts/compose";
import type { Handoff } from "../handoff/handoff";
import type { EscalationTrigger } from "../handoff/triggers";
import type { CallRecorder } from "../telephony/event-log";
import { runConversation, type OrchestratorDeps } from "./orchestrator";

const GREETING = "Thank you for calling Ansa. How can I help you?";

/** Any registered tenant. Only the tool tests below care which, and only that it is set. */
const TENANT = asTenantId("5c3d0a5e-1f6d-4f6f-9b3a-0f2d7c8a4e11");

/** One rendered phrase per tier, so the tiering itself is what is under test. */
const fillerSetup = () => ({
  fillers: new Map([
    ["Mm-hm.", [chunkOf(4800)]],
    ["Let me check that.", [chunkOf(9600)]],
  ]) as ReadonlyMap<string, readonly AudioChunk[]>,
  fillerTiers: [["Mm-hm."], ["Let me check that."]] as readonly (readonly string[])[],
});

const setup = (
  opts: {
    bargeInGuardMs?: number;
    greetingAudio?: readonly AudioChunk[] | null;
    fillers?: ReadonlyMap<string, readonly AudioChunk[]>;
    fillerTiers?: readonly (readonly string[])[];
    fillerAfterMs?: number;
    transcriptWatchdogMs?: number;
    minSpeechMs?: number;
    recorder?: CallRecorder;
    facts?: CallFactsStore;
    systemPrompt?: string;
    makeHandoff?: (say: (text: string) => Promise<void>) => Handoff;
    /** Null is an unregistered number: tool calling is off for the whole call. */
    tenantId?: TenantId | null;
    makeTools?: OrchestratorDeps["makeTools"];
  } = {},
) => {
  const stream = fakeStream();
  const listen = fakeListen();
  const llm = fakeLlm();
  const tts = fakeTts();

  runConversation(stream.stream, {
    listen: listen.session,
    llm: llm.provider,
    tts: tts.provider,
    voiceId: "voice-ng",
    log: silentLog,
    greeting: GREETING,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    tenantId: TENANT,
    forSpeech: (t) => t.replace(/\bAnsa\b/g, "An-Sah"),
    // These tests drive transcripts directly to exercise turn logic and never fan in
    // audio, so the no-speech filter would discard every one of them. The filter has its
    // own tests, which do fan in audio.
    minSpeechMs: 0,
    ...opts,
  });

  return { stream, listen, llm, tts };
};

/**
 * Invariants that must hold at the end of every scenario, whatever route it took.
 *
 * Note what is deliberately NOT asserted: two adjacent caller messages. That used to
 * signal a lost agent reply, but with playback-driven history it legitimately means the
 * agent was interrupted before a word reached the caller — so as far as the
 * conversation is concerned it never spoke, and the record is accurate.
 */
const assertInvariants = (h: ReturnType<typeof setup>): void => {
  const messages: readonly Message[] =
    h.llm.completions.length > 0 ? h.llm.lastMessages() : [];

  // An empty message is a recording bug: the turn should have been removed instead.
  for (const message of messages) {
    expect(message.content.trim().length, `empty message: ${JSON.stringify(messages)}`)
      .toBeGreaterThan(0);
  }

  // Two concurrent syntheses interleave at the carrier and are heard as garbled speech.
  expect(h.tts.live().length, "more than one synthesis in flight").toBeLessThanOrEqual(1);
};

/**
 * Records what the handoff was asked to do and keeps hold of `say`, which is the seam.
 *
 * At module scope because the tool loop escalates too: an irreversible tool and a
 * connector that will not answer both end at the same door, and a second spy would be a
 * second opinion about what going through it looks like.
 */
const spyHandoff = () => {
  const triggers: EscalationTrigger[] = [];
  let say: ((text: string) => Promise<void>) | null = null;
  const make = (s: (text: string) => Promise<void>): Handoff => {
    say = s;
    return {
      escalate: async (trigger: EscalationTrigger): Promise<void> => {
        triggers.push(trigger);
      },
    };
  };
  return {
    make,
    triggers,
    sayWith: (): ((text: string) => Promise<void>) => {
      if (say === null) throw new Error("the orchestrator never built the handoff");
      return say;
    },
  };
};

describe("runConversation", () => {
  it("greets the caller through forSpeech, without waiting to be spoken to", () => {
    const h = setup();

    expect(h.tts.texts()).toEqual(["Thank you for calling An-Sah. How can I help you?"]);
    assertInvariants(h);
  });

  it("fans caller audio into the listen session", () => {
    const h = setup();

    h.stream.audioIn({ data: Buffer.alloc(160, 1), offsetMs: 0 });
    h.stream.audioIn({ data: Buffer.alloc(160, 2), offsetMs: 20 });

    expect(h.listen.written).toHaveLength(2);
  });

  // Regression: two sentences synthesising at once interleaved at the carrier and were
  // heard as garbled speech on a live call.
  it("synthesises one sentence at a time", () => {
    const h = setup();
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Tell me about my policy.");
    const completion = h.llm.last();
    completion.emit("It renews in May. ");
    completion.emit("Your premium is unchanged. ");

    // Two sentences are ready, but only the first may be in flight.
    expect(h.tts.live()).toHaveLength(1);
    assertInvariants(h);
  });

  it("speaks the second sentence once the first finishes", () => {
    const h = setup();
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Tell me about my policy.");
    const completion = h.llm.last();
    completion.emit("It renews in May. Your premium is unchanged. ");
    const first = h.tts.last();
    first.audio(800);
    first.done();

    expect(h.tts.texts()).toEqual([
      "Thank you for calling An-Sah. How can I help you?",
      "It renews in May.",
      "Your premium is unchanged.",
    ]);
    assertInvariants(h);
  });

  // Regression: the agent's own audio returns through the caller's handset and fires
  // VAD. A caller cannot react to speech they have not finished hearing.
  it("ignores speech-start inside the barge-in guard", () => {
    const h = setup({ bargeInGuardMs: 10_000 });
    h.tts.last().audio(800);

    h.listen.speechStart(100);

    expect(h.stream.clears).toBe(0);
    assertInvariants(h);
  });

  it("treats speech-start outside the guard as a real interruption", () => {
    const h = setup({ bargeInGuardMs: 0 });
    h.tts.last().audio(800);

    h.listen.speechStart(100);

    expect(h.stream.clears).toBe(1);
    expect(h.tts.syntheses[0]?.cancelled).toBe(true);
    assertInvariants(h);
  });

  // The guard suppresses the speech-start but the transcript of that same segment
  // still arrives. Answering it is the agent holding a conversation with itself, which
  // is what five phantom turns on a live call turned out to be.
  it("ignores the transcript of a speech segment it judged to be echo", () => {
    const h = setup({ bargeInGuardMs: 10_000 });
    h.tts.last().audio(800);

    h.listen.speechStart(4200);
    h.listen.final("Thank you for calling An-Sah. How can I help you?", 4200);

    expect(h.llm.completions).toHaveLength(0);
    assertInvariants(h);
  });

  it("still answers a transcript from a segment it did not suppress", () => {
    const h = setup({ bargeInGuardMs: 10_000 });
    h.tts.last().audio(800);

    h.listen.speechStart(4200);
    h.listen.final("When does my policy renew?", 9999);

    expect(h.llm.completions).toHaveLength(1);
  });

  it("ignores a transcript that merely repeats what the agent is saying", () => {
    const h = setup({ bargeInGuardMs: 0 });
    h.tts.last().audio(800);

    // No speech-start: this arrives purely as content, echoed back by the handset.
    h.listen.final("thank you for calling an sah how can i help you", 5000);

    expect(h.llm.completions).toHaveLength(0);
  });

  // The containment filter must never become "ignore the caller while speaking".
  it("answers genuinely new words spoken over the agent", () => {
    const h = setup({ bargeInGuardMs: 0 });
    h.tts.last().audio(800);

    h.listen.final("Actually, I want to cancel my policy.", 5000);

    expect(h.llm.completions).toHaveLength(1);
  });

  // Seen on a live call: "Mm." arrived while the agent was mid-sentence, was treated as
  // a turn, and discarded 916ms of speech the caller was in the middle of hearing. A
  // person saying "mm-hm" is showing they are listening, not taking the floor.
  it("does not let a backchannel noise interrupt the agent", () => {
    const h = setup({ bargeInGuardMs: 0 });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Tell me about my policy.");
    h.llm.last().emit("It renews in May. ");
    const reply = h.tts.last();
    for (let i = 0; i < 10; i += 1) reply.audio(400);

    h.listen.final("Mm.", 9999);

    expect(reply.cancelled).toBe(false);
    expect(h.llm.completions).toHaveLength(1);
    assertInvariants(h);
  });

  // The same word in silence is a real answer: "yeah" to a question means yes.
  it("treats the same word as a real turn when the agent is not speaking", () => {
    const h = setup();
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Yeah.");

    expect(h.llm.completions).toHaveLength(1);
  });

  it("ignores transcripts too short to be speech", () => {
    const h = setup();
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final(".");

    expect(h.llm.completions).toHaveLength(0);
  });

  // A dropped realtime socket used to leave the agent permanently deaf: the caller
  // keeps talking to a line that will never answer. Silence is the one outcome
  // CLAUDE.md rules out. The call ends, but it says why first — see the recovery
  // tests below for the hangup itself.
  it("stops speaking and recovers when the listen connection dies", () => {
    const h = setup();
    h.tts.last().audio(800);

    h.listen.failWith("socket closed with code 1006");

    expect(h.tts.syntheses[0]?.cancelled).toBe(true);
    expect(h.tts.texts().at(-1)).toContain("Sorry");
    assertInvariants(h);
  });

  // Realtime `error` events are routinely recoverable. Ending a call on one would drop
  // conversations that were fine.
  it("does not end the call on a recoverable vendor error", () => {
    const h = setup();

    h.listen.vendorError("input_audio_buffer_commit_empty");

    expect(h.stream.hungUp).toBe(false);
    expect(h.listen.closed).toBe(false);
  });

  // The defect this replaces: marks existed only at sentence boundaries, so an
  // interruption partway through a sentence reported zero heard and deleted a reply the
  // caller had mostly heard. The agent then repeated itself.
  it("keeps a prefix of what was heard when interrupted mid-sentence", () => {
    const h = setup({ bargeInGuardMs: 0 });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Tell me about my policy.");
    h.llm.last().emit("Your policy renews in May and the premium is unchanged. ");

    const speech = h.tts.last();
    for (let i = 0; i < 20; i += 1) speech.audio(400); // 20 x 50ms = 1s, as TTS streams
    h.stream.ackAll();
    h.listen.speechStart(9999);

    const messages = h.llm.completions[0]?.request.messages ?? [];
    void messages;
    h.listen.final("Actually, hold on.");
    const history = h.llm.lastMessages();
    const agentTurn = history.find((m) => m.role === "assistant" && m.content.includes("policy"));

    expect(agentTurn, "the heard prefix was erased entirely").toBeDefined();
    expect(agentTurn?.content.length ?? 0).toBeGreaterThan(0);
    expect(agentTurn?.content).not.toContain("premium is unchanged");
    assertInvariants(h);
  });

  it("records the full turn once the caller has heard all of it", () => {
    const h = setup();
    h.tts.last().audio(4000);
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Hello?");

    expect(h.llm.lastMessages()[0]).toEqual({
      role: "assistant",
      content: "Thank you for calling Ansa. How can I help you?",
    });
    assertInvariants(h);
  });

  // Interrupted before a single byte reached the caller: as far as the conversation is
  // concerned that turn never happened.
  it("records nothing for a turn cut off before any audio played", () => {
    const h = setup({ bargeInGuardMs: 0 });

    h.listen.speechStart(100);
    h.listen.final("Hello?");

    expect(h.llm.lastMessages()).toEqual([{ role: "user", content: "Hello?" }]);
    assertInvariants(h);
  });

  it("emits sub-sentence marks so a mid-sentence interruption has evidence", () => {
    const h = setup();
    for (let i = 0; i < 20; i += 1) h.tts.last().audio(400); // 1s in 50ms chunks

    // ~200ms per mark, so a second of audio should produce several.
    expect(h.stream.marks.length).toBeGreaterThanOrEqual(4);
    expect(h.stream.marks.every((m) => m.startsWith("1:"))).toBe(true);
  });

  // respondTo used to replace the live turn with no teardown: the old LLM and TTS kept
  // streaming, and audio already queued at the carrier played over the new reply.
  it("tears down the previous turn when a transcript arrives mid-reply", () => {
    const h = setup({ bargeInGuardMs: 10_000 });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Tell me about my policy.");
    h.llm.last().emit("It renews in May. ");
    const firstReply = h.tts.last();
    for (let i = 0; i < 10; i += 1) firstReply.audio(400); // 500ms, heard by the caller
    h.stream.ackAll();

    const clearsBefore = h.stream.clears;
    h.listen.final("Actually, cancel it.", 12_345);

    expect(h.stream.clears).toBe(clearsBefore + 1);
    expect(firstReply.cancelled).toBe(true);
    expect(h.llm.completions[0]?.cancelled ?? h.llm.completions[1]?.cancelled).toBe(true);
    assertInvariants(h);
  });

  it("leaves exactly one completion live when two transcripts arrive in quick succession", () => {
    const h = setup({ bargeInGuardMs: 10_000 });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("First question.");
    h.listen.final("Second question.", 500);

    const live = h.llm.completions.filter((c) => !c.cancelled);
    expect(live).toHaveLength(1);
    assertInvariants(h);
  });

  it("cancels the in-flight synthesis when the model fails mid-turn", () => {
    const h = setup();
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Tell me about my policy.");
    h.llm.last().emit("It renews in ");
    h.llm.last().emit("May. ");
    const speech = h.tts.last();
    speech.audio(400);

    h.llm.last().fail("openai returned 429");

    expect(speech.cancelled).toBe(true);
    expect(h.stream.clears).toBeGreaterThan(0);
    assertInvariants(h);
  });

  // Without finishIfComplete on the TTS error path, no mark ever arrives, the turn stays
  // open forever and the agent never speaks again.
  it("does not wedge the turn when synthesis fails and nothing is queued", () => {
    const h = setup();
    h.tts.last().fail("elevenlabs returned 500");

    h.listen.final("Hello?");

    // A new turn was accepted, which only happens if the previous one closed.
    expect(h.llm.completions).toHaveLength(1);
    assertInvariants(h);
  });

  describe("dead air", () => {
    // The greeting is a constant in a fixed voice: deterministic, yet it cost a measured
    // 959ms cold on a live call, at the moment the caller is listening hardest.
    it("plays a pre-rendered greeting without calling TTS at all", () => {
      const h = setup({ greetingAudio: [chunkOf(1600), chunkOf(1600)] });

      expect(h.tts.syntheses).toHaveLength(0);
      expect(h.stream.bytesSent()).toBe(3200);
      expect(h.stream.marks.length).toBeGreaterThan(0);
    });

    it("still greets when the pre-render failed", () => {
      const h = setup({ greetingAudio: null });

      expect(h.tts.texts()).toEqual(["Thank you for calling An-Sah. How can I help you?"]);
    });

    it("credits a pre-rendered greeting to history once heard", () => {
      const h = setup({ greetingAudio: [chunkOf(4000)] });
      h.stream.ackAll();

      h.listen.final("Hello?");

      expect(h.llm.lastMessages()[0]?.content).toBe(GREETING);
    });

    it("plays an acknowledgement when the reply is slow", async () => {
      const h = setup({ ...fillerSetup(), fillerAfterMs: 5 });
      h.tts.last().done();
      h.stream.ackAll();
      const before = h.stream.bytesSent();

      h.listen.endOfTurn(1000);
      await new Promise((r) => setTimeout(r, 30));

      expect(h.stream.bytesSent()).toBe(before + 4800);
    });

    // Filler is not something the agent said. It must not be remembered, marked, or
    // counted as audio the caller heard.
    it("keeps filler out of history and out of the accounting", async () => {
      const h = setup({ ...fillerSetup(), fillerAfterMs: 5 });
      h.tts.last().done();
      h.stream.ackAll();
      const marksBefore = h.stream.marks.length;

      h.listen.endOfTurn(1000);
      await new Promise((r) => setTimeout(r, 30));
      h.listen.final("Hello?");

      expect(h.stream.marks.length).toBe(marksBefore);
      expect(h.llm.lastMessages().some((m) => m.content.includes("Mm-hm"))).toBe(false);
    });

    it("does not play filler once the real reply has started", async () => {
      const h = setup({ ...fillerSetup(), fillerAfterMs: 20 });
      h.tts.last().done();
      h.stream.ackAll();

      h.listen.endOfTurn(1000);
      h.listen.final("Hello?");
      h.llm.last().emit("Hello there. ");
      h.tts.last().audio(400);
      const after = h.stream.bytesSent();
      await new Promise((r) => setTimeout(r, 40));

      expect(h.stream.bytesSent()).toBe(after);
    });

    // The dead air used to manufacture the interruption that deleted the answer: a
    // caller noise during the think window cancelled an LLM about to produce its first
    // token, and if the noise transcribed under two characters no reply came at all.
    // A second "mm-hm" seconds later sounds like the line is stuck. The caller needs to
    // hear that something is happening, not just that they were heard.
    it("moves to a progress phrase rather than repeating the acknowledgement", async () => {
      const h = setup({ ...fillerSetup(), fillerAfterMs: 5 });
      h.tts.last().done();
      h.stream.ackAll();
      const before = h.stream.bytesSent();

      h.listen.endOfTurn(1000);
      await new Promise((r) => setTimeout(r, 30));
      const afterFirst = h.stream.bytesSent();

      expect(afterFirst - before).toBe(4800); // the acknowledgement
      // The progress tier is armed at a fixed 2.2s, too long for a unit test to wait
      // out; that it is a different pool is asserted in filler.test.ts.
      expect(h.tts.syntheses.every((x) => !x.request.text.includes("Mm-hm"))).toBe(true);
    });

    it("does not treat a noise during the think window as an interruption", () => {
      const h = setup({ bargeInGuardMs: 0 });
      h.tts.last().done();
      h.stream.ackAll();

      h.listen.final("When does my policy renew?");
      h.listen.speechStart(9999);

      expect(h.llm.last().cancelled).toBe(false);
      expect(h.stream.clears).toBe(0);
    });
  });

  describe("failures degrade into speech", () => {
    it("says something when the model fails rather than going quiet", () => {
      const h = setup();
      h.tts.last().done();
      h.stream.ackAll();

      h.listen.final("When does my policy renew?");
      h.llm.last().fail("openai returned 429");

      expect(h.tts.texts().at(-1)).toContain("Sorry");
      assertInvariants(h);
    });

    it("retries a failed sentence once before giving up on it", () => {
      const h = setup();

      h.tts.last().fail("elevenlabs returned 500");

      expect(h.tts.texts()).toEqual([
        "Thank you for calling An-Sah. How can I help you?",
        "Thank you for calling An-Sah. How can I help you?",
      ]);
      expect(h.stream.hungUp).toBe(false);
    });

    // Two failures with nothing said: do not keep retrying through the provider that
    // just failed. An open silent line is worse than a clean ending.
    it("ends the call when a turn cannot produce any audio at all", () => {
      const h = setup();

      h.tts.last().fail("elevenlabs returned 500");
      h.tts.last().fail("elevenlabs returned 500");

      expect(h.stream.hungUp).toBe(true);
    });

    // Seen on a live call: the caller stopped speaking, two fillers played, and then
    // ten seconds of silence, because no transcript ever arrived and the only watchdog
    // was armed inside respondTo - which never runs without one.
    it("says something when the caller finishes but no transcript arrives", async () => {
      const h = setup({ transcriptWatchdogMs: 20 });
      h.tts.last().done();
      h.stream.ackAll();

      h.listen.endOfTurn(1000);
      await new Promise((r) => setTimeout(r, 60));

      expect(h.tts.texts().at(-1)).toContain("Sorry");
      assertInvariants(h);
    });

    it("does not fire that watchdog when the transcript does arrive", async () => {
      const h = setup({ transcriptWatchdogMs: 40 });
      h.tts.last().done();
      h.stream.ackAll();

      h.listen.endOfTurn(1000);
      h.listen.final("When does my policy renew?");
      h.llm.last().emit("It renews in May. ");
      await new Promise((r) => setTimeout(r, 80));

      expect(h.tts.texts().some((t) => t.includes("Sorry"))).toBe(false);
    });

    // The watchdog pointed the other way. It is armed at end-of-turn and was cancelled
    // only by a reply, an audio byte or the next end-of-turn — so a caller who simply
    // started speaking again could be interrupted, five seconds in, by "Sorry, I did not
    // catch that" while they were mid-sentence.
    it("does not fire that watchdog once the caller has started again", async () => {
      const h = setup({ transcriptWatchdogMs: 30, bargeInGuardMs: 0 });
      h.tts.last().done();
      h.stream.ackAll();

      h.listen.endOfTurn(1000);
      h.listen.speechStart(1200);
      await new Promise((r) => setTimeout(r, 70));

      expect(h.tts.texts().some((t) => t.includes("Sorry"))).toBe(false);
      assertInvariants(h);
    });

    // One constant spoken word for word however many times a call needed it is how a
    // caller learns they are talking to a machine. capture.ts varies its second readback
    // for the same reason.
    it("does not repeat the same recovery line twice running", async () => {
      const h = setup({ transcriptWatchdogMs: 20 });
      h.tts.last().done();
      h.stream.ackAll();

      const said: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        h.listen.endOfTurn(1000 * (i + 1));
        await new Promise((r) => setTimeout(r, 60));
        const line = h.tts.texts().at(-1) ?? "";
        said.push(line);
        // Let the recovery turn finish so the next watchdog can arm.
        h.tts.last().done();
        h.stream.ackAll();
      }

      expect(said).toHaveLength(4);
      for (const [i, line] of said.entries()) {
        expect(line).toContain("Sorry");
        if (i > 0) expect(line).not.toBe(said[i - 1]);
      }
    });

    it("apologises before hanging up when the listen connection dies", () => {
      const h = setup();
      h.tts.last().done();
      h.stream.ackAll();

      h.listen.failWith("socket closed with code 1006");

      expect(h.tts.texts().at(-1)).toContain("Sorry");
      expect(h.stream.hungUp).toBe(false);

      // Only once the caller has actually heard it.
      h.tts.last().audio(4000);
      h.tts.last().done();
      h.stream.ackAll();
      expect(h.stream.hungUp).toBe(true);
    });
  });

  describe("asking it to repeat", () => {
    const askAndAnswer = (h: ReturnType<typeof setup>) => {
      h.tts.last().done();
      h.stream.ackAll();
      h.listen.final("When does my policy renew?");
      h.llm.last().emit("Your policy renews in May. ");
      h.llm.last().finish();
      const reply = h.tts.last();
      for (let i = 0; i < 10; i += 1) reply.audio(400);
      reply.done();
      h.stream.ackAll();
      return h;
    };

    it("says the same thing again instead of answering something new", () => {
      const h = askAndAnswer(setup());
      const completionsBefore = h.llm.completions.length;

      h.listen.final("Sorry, what?");

      expect(h.tts.texts().at(-1)).toBe("Your policy renews in May.");
      // No model round trip: someone who missed what you said wants it now.
      expect(h.llm.completions).toHaveLength(completionsBefore);
      assertInvariants(h);
    });

    // History holds only what was heard, so replaying from there would repeat the
    // fragment they already got rather than the part they missed.
    it("repeats what it meant to say, not the truncated part they heard", () => {
      const h = setup({ bargeInGuardMs: 0 });
      h.tts.last().done();
      h.stream.ackAll();

      h.listen.final("Tell me about my policy.");
      h.llm.last().emit("Your policy renews in May and the premium is unchanged. ");
      h.llm.last().finish();
      const reply = h.tts.last();
      for (let i = 0; i < 3; i += 1) reply.audio(400); // only a little heard
      h.stream.ackAll();
      h.listen.speechStart(9999);

      h.listen.final("Sorry, I did not catch that.");

      expect(h.tts.texts().at(-1)).toBe(
        "Your policy renews in May and the premium is unchanged.",
      );
    });

    it("replays the greeting if asked right after it", () => {
      const h = setup();
      h.tts.last().done();
      h.stream.ackAll();

      h.listen.final("Pardon?");

      expect(h.tts.texts().at(-1)).toBe("Thank you for calling An-Sah. How can I help you?");
    });

    // Anchoring is what stops this hijacking real turns.
    // The first version of this only matched the WHOLE utterance, so it caught bare
    // "Sorry?" and nothing else. Real repair requests arrive inside longer turns,
    // especially now the transcriber returns multi-sentence turns.
    it.each([
      "Sorry, I didn't hear you. Can you say that again?",
      "What did you say?",
      "Sorry, can you repeat that please?",
      "Hmm, come again?",
      "I missed that, one more time?",
      "Sorry. What was that?",
    ])("treats %j as a request to repeat", (utterance) => {
      const h = askAndAnswer(setup());
      const before = h.llm.completions.length;

      h.listen.final(utterance);

      expect(h.tts.texts().at(-1)).toBe("Your policy renews in May.");
      expect(h.llm.completions).toHaveLength(before);
    });

    // A substring match must not hijack an ordinary question.
    it.each([
      "What can you do for me?",
      "What is my premium this year?",
      "Can you repeat customers get a discount?",
      "I did not get that discount you mentioned last year on my policy.",
    ])("does not treat %j as a repeat request", (utterance) => {
      const h = askAndAnswer(setup());
      const before = h.llm.completions.length;

      h.listen.final(utterance);

      expect(h.llm.completions.length).toBe(before + 1);
    });

    it("does not mistake a real question containing 'what' for a repeat request", () => {
      const h = askAndAnswer(setup());
      const before = h.llm.completions.length;

      h.listen.final("What can you do for me?");

      expect(h.llm.completions.length).toBe(before + 1);
    });

    it("does nothing special before the agent has said anything", () => {
      const h = setup({ greetingAudio: null });
      // No utterance recorded yet beyond the greeting, which is set at call open.
      expect(h.tts.texts()).toHaveLength(1);
    });
  });

  it("closes the listen session when the call ends", () => {
    const h = setup();

    h.stream.closeCall("carrier sent stop");

    expect(h.listen.closed).toBe(true);
  });
});

describe("reply length adapts to what was asked", () => {
  const askAndCount = (h: ReturnType<typeof setup>, question: string, reply: string) => {
    h.tts.last().done();
    h.stream.ackAll();
    h.listen.final(question);
    const completion = h.llm.last();
    for (const token of reply.split(/(?<=[.!?])\s+/)) completion.emit(`${token} `);
    completion.finish();

    // Sentences synthesise one at a time, so the queue only advances as each finishes.
    // Without draining, every scenario would look like a one-sentence reply.
    for (let i = 0; i < 10; i += 1) {
      const live = h.tts.live()[0];
      if (live === undefined) break;
      live.audio(400);
      live.done();
    }
    return h.tts.texts().slice(1).join(" ").split(/\s+/).filter((w) => w.length > 0).length;
  };

  // The pair the whole mechanism exists for: same code path, opposite budgets.
  it("keeps a yes/no answer short", () => {
    const spoken = askAndCount(
      setup(),
      "Is my policy still active?",
      "Yes, it is. It renews in May and your premium has not changed at all this year.",
    );
    expect(spoken).toBeLessThanOrEqual(10);
  });

  it("lets an explanation run longer", () => {
    const spoken = askAndCount(
      setup(),
      "How do I make a claim?",
      "Call us within five days. We will send you a form to complete. Then an assessor visits.",
    );
    expect(spoken).toBeGreaterThan(12);
  });

  // Three turns in ten were cut off at a single word because the model opened with
  // "Okay." and the sentence cap treated that interjection as the whole turn.
  it("does not end a turn on a one-word opener", () => {
    const spoken = askAndCount(
      setup(),
      "Is my policy still active?",
      "Okay. Yes, it is active until May.",
    );
    expect(spoken).toBeGreaterThan(3);
  });
});

describe("readback in the turn loop (R4.3)", () => {
  it("holds the model back while a dictated number is unconfirmed", () => {
    const h = setup();
    const before = h.llm.completions.length;

    h.listen.final("My policy number is four one seven two nine.");

    // The gate's whole purpose: the model must not get to answer around a number that
    // has not been confirmed.
    expect(h.llm.completions.length).toBe(before);
    const said = h.tts.texts().join(" ");
    expect(said).toContain("read that back");
    expect(said).toContain("four one seven");
    assertInvariants(h);
  });

  it("lets the model run once the caller agrees, and tells it the confirmed value", () => {
    const h = setup();
    h.listen.final("My policy number is four one seven two nine.");
    const during = h.llm.completions.length;

    h.listen.final("Yes, that is correct.");

    expect(h.llm.completions.length).toBeGreaterThan(during);
    const lastCaller = [...h.llm.lastMessages()].reverse().find((m) => m.role === "user");
    expect(lastCaller?.content).toContain("41729");
    assertInvariants(h);
  });

  it("does not read back a plain quantity", () => {
    const h = setup();

    h.listen.final("I have three policies with you.");

    // "You have three policies, let me read that back" would be intolerable.
    expect(h.llm.completions.length).toBeGreaterThan(0);
    expect(h.tts.texts().join(" ")).not.toContain("read that back");
    assertInvariants(h);
  });

  it("takes a correction without ever releasing the wrong value", () => {
    const h = setup();
    h.listen.final("It is four one seven two nine.");
    h.listen.final("No, it is four one eight two nine.");

    const said = h.tts.texts().join(" ");
    // Five digits group as "four one eight, two nine" - the comma is a pause in TTS.
    expect(said).toContain("four one eight, two nine");
    // Still nothing has reached the model: a correction is speech and gets confirmed too.
    expect(h.llm.completions.length).toBe(0);
    assertInvariants(h);
  });

  it("offers the keypad after two failures and accepts the tones", () => {
    const h = setup();
    h.listen.final("It is four one seven two nine.");
    h.listen.final("No.");
    h.listen.final("No.");

    expect(h.tts.texts().join(" ")).toContain("keypad");

    for (const digit of "41829") h.stream.press(digit);
    h.stream.press("#");

    // Tones are unambiguous, so this goes straight through to the model.
    const lastCaller = [...h.llm.lastMessages()].reverse().find((m) => m.role === "user");
    expect(lastCaller?.content).toContain("41829");
    assertInvariants(h);
  });

  /**
   * 2026-08-08, 12:12:42, on a real call: capture escalated and the agent never spoke
   * again. `captureHandled` reported every subsequent turn as handled, so `respondTo`
   * never ran, and the caller — who had just been told a colleague was coming — talked to
   * a dead line until they hung up.
   */
  it("keeps answering the caller after capture has escalated", () => {
    const h = setup();

    // Name capture with no usable candidate: readback rejected, spelling asked for twice,
    // then given up on. The route is what capture.ts decides, not something asserted here.
    h.listen.final("My name is Adebayo.");
    h.listen.final("No.");
    h.listen.final("No.");
    h.listen.final("No.");
    expect(h.tts.texts().join(" ")).toContain("colleague");

    const answered = h.llm.completions.length;
    const spokenSoFar = h.tts.texts().length;
    h.listen.final("Fine. What time do you close today?");

    // The model gets the turn. Silence here is the bug.
    expect(h.llm.completions.length).toBeGreaterThan(answered);
    // And they are not dragged back into the readback they just failed three times:
    // `escalate` is terminal for capture, so nothing capture says can follow it.
    expect(h.tts.texts().slice(spokenSoFar).join(" ")).not.toMatch(/spell|colleague|right\?/);
    assertInvariants(h);
  });

  /**
   * The old gate reached capture only through a name cue or a digit run, so every entity
   * whose value is not digits was unreachable however clearly the caller said it. A table
   * rather than one case: a fix that only rescues one kind fails visibly here.
   */
  it.each([
    ["an email", "my email is s i k i r u at gmail dot com"],
    ["an amount", "the premium is forty five thousand naira"],
    ["an address", "my address is 14 Adeola Odeku Street, Victoria Island"],
    ["a date", "call me back tomorrow"],
  ])("confirms %s before the model sees it", (_what, said) => {
    const h = setup();

    h.listen.final(said);

    // Held back, and something was said about it — the readback wording belongs to
    // capture.ts and is asserted there.
    expect(h.llm.completions.length).toBe(0);
    expect(h.tts.texts().length).toBeGreaterThan(0);
    assertInvariants(h);
  });

  it("ignores keypad tones when no capture is running", () => {
    const h = setup();
    const before = h.tts.texts().length;

    for (const digit of "417") h.stream.press(digit);

    // A caller fidgeting with their handset must not become a reference.
    expect(h.tts.texts().length).toBe(before);
    assertInvariants(h);
  });
});

describe("handing the call to a person (R6.4)", () => {

  /**
   * The ordering only a phone call punishes. `transferToNumber` replaces the carrier
   * instruction and tears down the media stream; audio still queued at the carrier —
   * ~1.8s on this project's own calls — goes with it. So the departure line has to be
   * HEARD, and `say` resolving early is the bug that would strand a caller mid-sentence.
   */
  it("resolves the departure line only once the caller has heard it", async () => {
    const spy = spyHandoff();
    const h = setup({ makeHandoff: spy.make });
    h.tts.last().done();
    h.stream.ackAll();

    let heard = false;
    const spoken = spy.sayWith()("Let me put you through to someone now.").then(() => {
      heard = true;
    });

    // Synthesised and sent, but the carrier has not acknowledged a byte of it.
    h.tts.last().audio(1600);
    h.tts.last().done();
    await Promise.resolve();
    expect(heard).toBe(false);

    h.stream.ackAll();
    await spoken;
    expect(heard).toBe(true);
  });

  it("transfers a caller who asks for a person, without a model turn", () => {
    const spy = spyHandoff();
    const h = setup({ makeHandoff: spy.make });
    const before = h.llm.completions.length;

    h.listen.final("Can I speak to a person please?");

    expect(spy.triggers.map((t) => t.kind)).toEqual(["asked-for-a-person"]);
    // They are leaving. Answering the question they did not ask wastes their time.
    expect(h.llm.completions.length).toBe(before);
  });

  it("does not transfer on our own audio saying it", () => {
    const spy = spyHandoff();
    const h = setup({ bargeInGuardMs: 10_000, makeHandoff: spy.make });
    h.tts.last().audio(800);

    h.listen.speechStart(4200);
    h.listen.final("Let me put you through to someone now.", 4200);

    expect(spy.triggers).toEqual([]);
  });

  it("hands over when capture gives up, and says one departure line rather than two", () => {
    const spy = spyHandoff();
    const h = setup({ makeHandoff: spy.make });

    h.listen.final("My name is Adebayo.");
    h.listen.final("No.");
    h.listen.final("No.");
    const before = h.tts.texts().length;
    h.listen.final("No.");

    expect(spy.triggers.map((t) => t.kind)).toEqual(["capture-failed"]);
    // capture.ts's own "Let me get a colleague for you" is suppressed: the handoff speaks
    // its own line, and the caller must not hear both.
    expect(h.tts.texts().slice(before)).toEqual([]);
  });

  it("counts three failed turns as one broken call, and only three", () => {
    const spy = spyHandoff();
    const h = setup({ makeHandoff: spy.make });
    h.tts.last().done();
    h.stream.ackAll();

    for (let i = 0; i < 2; i += 1) {
      h.listen.final("Sorry, what did you say?");
      h.llm.completions.at(-1)?.finish();
      h.stream.ackAll();
    }
    expect(spy.triggers).toEqual([]);

    h.listen.final("Sorry, what did you say?");
    expect(spy.triggers.map((t) => t.kind)).toEqual(["repeated-misunderstanding"]);
  });

  it("does not transfer a call that keeps working between failures", () => {
    const spy = spyHandoff();
    const h = setup({ makeHandoff: spy.make });
    h.tts.last().done();
    h.stream.ackAll();

    for (let i = 0; i < 4; i += 1) {
      h.listen.final("Sorry, what did you say?");
      // A turn that produced real speech resets the counter — R6.4 is three failures on
      // one intent, not three scattered across a call that was otherwise fine.
      h.listen.final("What are your opening hours?");
      h.llm.last().emit("We are open from eight until five.");
      h.llm.last().finish();
      h.stream.ackAll();
    }

    expect(spy.triggers).toEqual([]);
  });
});

describe("the prompt the call was configured with", () => {
  it("sends the tenant's composed prompt, not the default one", () => {
    // A tenant's persona has been loaded, validated and composed on every config load
    // since the prompt layers landed, and the orchestrator used the default anyway.
    const tenantPrompt = "You are answering for a tenant whose own layer is in this text.";
    const h = setup({ systemPrompt: tenantPrompt });

    h.listen.final("What are your opening hours?");

    const system = h.llm.last().request.system;
    expect(system.startsWith(tenantPrompt)).toBe(true);
    // The turn budget still lands last, which is how the layering already worked.
    expect(system.length).toBeGreaterThan(tenantPrompt.length);
    assertInvariants(h);
  });
});

describe("what the agent knows about the call (§10)", () => {
  const newFacts = (): CallFactsStore =>
    createCallFacts({
      tenantId: asTenantId("11111111-1111-4111-8111-111111111111"),
      callId: asCallId("CA-facts"),
      callDirection: "inbound",
    });

  /**
   * Seven names from as many traditions, plus a hyphen and a diacritic, because a fix
   * that only carries one name through is not a fix. None of them appears in a branch —
   * the store is keyed on the entity kind capture reports.
   */
  it.each([
    "Adebayo",
    "Ngozi Okonkwo",
    "Siobhan",
    "Jean-Pierre",
    "Zoë",
    "Wei",
    "Maria del Carmen",
  ])("carries a confirmed name (%s) into the model's prompt", (name) => {
    const facts = newFacts();
    const h = setup({ facts });

    h.listen.final(`My name is ${name}.`);
    h.listen.final("Yes, that is right.");

    expect(facts.facts.callerNameConfirmed).toBe(true);
    // The prompt the model was given for the turn that follows the confirmation.
    expect(h.llm.last().request.system).toContain(name);
    assertInvariants(h);
  });

  it("does not put an unconfirmed candidate in front of the model", () => {
    const facts = newFacts();
    const h = setup({ facts });

    h.listen.final("My name is Adebayo.");
    // Still under readback. The agent may know it is holding a name; it may not use it.
    h.listen.final("What are your opening hours?");

    expect(facts.facts.callerNameConfirmed).toBe(false);
    const system = h.llm.completions.at(-1)?.request.system ?? "";
    expect(system).not.toContain("Adebayo");
    assertInvariants(h);
  });

  it("remembers the question it asked, and forgets it once answered", () => {
    const facts = newFacts();
    const h = setup({ facts });

    h.listen.final("I want to renew.");
    h.llm.last().emit("Happy to help. Which policy is it?");
    h.llm.last().finish();
    expect(facts.facts.pendingQuestion.value).toContain("Which policy is it?");

    h.listen.final("The motor one.");
    expect(facts.facts.pendingQuestion.value).toBeNull();
    assertInvariants(h);
  });

  it("says nothing at all about the call until something is known", () => {
    const h = setup({ facts: newFacts() });

    h.listen.final("What are your opening hours?");

    // Turn one must be byte-for-byte the prompt that was sent before any of this existed.
    expect(h.llm.last().request.system).not.toContain("Do not change it");
    assertInvariants(h);
  });
});

describe("a turn the detector cut in half", () => {
  it("does not answer a sentence that has not finished", () => {
    const h = setup();
    const before = h.llm.completions.length;

    // 2026-08-08, 10:54:19. The detector committed here, the agent replied, and it
    // talked straight over the name the caller was in the middle of saying.
    h.listen.final("Hi. Good morning. My name is.");

    expect(h.llm.completions.length).toBe(before);
    assertInvariants(h);
  });

  it("answers both halves as one turn once the caller finishes", () => {
    const h = setup();

    h.listen.final("Hi. Good morning. My name is.");
    h.listen.final("Adebayo. How are you doing?");

    const lastCaller = [...h.llm.lastMessages()].reverse().find((m) => m.role === "user");
    // One reply to the whole thing, not a reply to the half that arrived last.
    expect(lastCaller?.content).toContain("My name is");
    expect(lastCaller?.content).toContain("Adebayo");
    assertInvariants(h);
  });

  it("answers anyway if the caller never continues", async () => {
    const h = setup();
    h.listen.final("Hi. Good morning. My name is.");

    await new Promise((r) => setTimeout(r, 1300));

    // Waiting forever would be a worse failure than answering half a sentence.
    expect(h.llm.completions.length).toBeGreaterThan(0);
    assertInvariants(h);
  });

  it("never makes a caller wait mid-readback", async () => {
    const h = setup();
    h.listen.final("My policy number is four one seven two nine.");
    const readbacks = h.tts.texts().length;

    // "No" ends on nothing danglable, but the guard matters for turns that do — a
    // correction must never be held back while a number is being confirmed.
    h.listen.final("No. It is four one eight.");

    expect(h.tts.texts().length).toBeGreaterThan(readbacks);
    assertInvariants(h);
  });

  it("still answers a complete turn immediately", () => {
    const h = setup();
    h.listen.final("I want to renew my policy.");
    expect(h.llm.completions.length).toBeGreaterThan(0);
    assertInvariants(h);
  });
});

describe("the filler must not interrupt a deliberate pause", () => {
  it("stays silent while a turn is held for a continuation", async () => {
    const h = setup({ ...fillerSetup(), fillerAfterMs: 100 });
    const before = h.stream.sent.length;

    // 2026-08-08, 11:06:25. The agent said "Alright." into the pause it was deliberately
    // leaving for the caller to finish their name.
    h.listen.final("Hi. Good morning. My name is.");
    await new Promise((r) => setTimeout(r, 300));

    expect(h.stream.sent.length, "audio played during the wait").toBe(before);
    assertInvariants(h);
  });
});

describe("transcripts invented from silence", () => {
  const withFilter = () => setup({ minSpeechMs: 160 });
  const loudFrame = () =>
    Buffer.from(Array.from({ length: 160 }, (_u, j) => (j % 2 === 0 ? 0x00 : 0x80)));

  it("discards a transcript when the caller made no sound", () => {
    const h = withFilter();
    const before = h.llm.completions.length;

    // Only silence has been fanned in. Anything the transcriber returns here it made up:
    // this is literally the "Ay, mi nombre es Pikachu" case.
    for (let i = 0; i < 100; i += 1) {
      h.stream.audioIn({ data: Buffer.alloc(160, 0xff), offsetMs: i * 20 });
    }
    h.listen.final("Ay, mi nombre es Pikachu.");

    expect(h.llm.completions.length).toBe(before);
    assertInvariants(h);
  });

  it("keeps a transcript the caller actually spoke", () => {
    const h = withFilter();

    for (let i = 0; i < 40; i += 1) h.stream.audioIn({ data: loudFrame(), offsetMs: i * 20 });
    h.listen.final("I want to renew my policy.");

    expect(h.llm.completions.length).toBeGreaterThan(0);
    assertInvariants(h);
  });

  it("keeps a turn as short as a bare no", () => {
    const h = withFilter();

    // ~300ms of speech. The threshold must sit below this or corrections are lost.
    for (let i = 0; i < 15; i += 1) h.stream.audioIn({ data: loudFrame(), offsetMs: i * 20 });
    h.listen.final("No.");

    expect(h.llm.completions.length).toBeGreaterThan(0);
    assertInvariants(h);
  });

  it("still forwards every byte to the listener", () => {
    const h = withFilter();
    for (let i = 0; i < 50; i += 1) {
      h.stream.audioIn({ data: Buffer.alloc(160, 0xff), offsetMs: i * 20 });
    }

    // Withholding silence would starve a shared turn detector of the one thing it
    // listens for, and end-of-turn would never fire.
    expect(h.listen.written.length).toBe(50);
    assertInvariants(h);
  });
});

describe("the filler must not interrupt the agent itself", () => {
  it("stays silent once real audio has gone out", async () => {
    const h = setup({ ...fillerSetup(), fillerAfterMs: 50 });

    // A readback consults no model, so nothing was cancelling the timers armed at
    // end-of-turn: the agent talked over its own question and then heard it back.
    h.listen.final("My policy number is four one seven two nine.");
    const afterReadback = h.stream.sent.length;

    await new Promise((r) => setTimeout(r, 400));

    expect(h.stream.sent.length, "filler played over the readback").toBe(afterReadback);
    assertInvariants(h);
  });
});

describe("audio that arrived before the listener existed", () => {
  it("replays buffered frames into the listen session", () => {
    const stream = fakeStream();
    const listen = fakeListen();
    const early = [
      { data: Buffer.alloc(160, 0x01), offsetMs: 0 },
      { data: Buffer.alloc(160, 0x02), offsetMs: 20 },
    ];

    runConversation(stream.stream, {
      listen: listen.session,
      llm: fakeLlm().provider,
      tts: fakeTts().provider,
      voiceId: "voice-ng",
      log: silentLog,
      greeting: GREETING,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      tenantId: TENANT,
      forSpeech: (t) => t,
      minSpeechMs: 0,
      initialAudio: early,
    });

    // Outbound loads its tenant on the socket; frames arriving in that window used to be
    // dropped outright.
    expect(listen.written).toHaveLength(2);
    expect(listen.written[0]?.data[0]).toBe(0x01);
  });

  it("keeps replayed frames ahead of live ones", () => {
    const stream = fakeStream();
    const listen = fakeListen();

    runConversation(stream.stream, {
      listen: listen.session,
      llm: fakeLlm().provider,
      tts: fakeTts().provider,
      voiceId: "voice-ng",
      log: silentLog,
      greeting: GREETING,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      tenantId: TENANT,
      forSpeech: (t) => t,
      minSpeechMs: 0,
      initialAudio: [{ data: Buffer.alloc(160, 0x01), offsetMs: 0 }],
    });
    stream.audioIn({ data: Buffer.alloc(160, 0x09), offsetMs: 20 });

    // Order matters: the speech gate's noise floor is built from the start of the call.
    expect(listen.written.map((c) => c.data[0])).toEqual([0x01, 0x09]);
  });
});

describe("turns are written down", () => {
  const recording = () => {
    const turns: {
      seq: number;
      speaker: string;
      startedOffsetMs: number;
      bargedInAtMs: number | null;
    }[] = [];
    return {
      turns,
      recorder: {
        started: () => undefined,
        event: () => undefined,
        transcript: () => undefined,
        turn: (t: {
          seq: number;
          speaker: string;
          startedOffsetMs: number;
          bargedInAtMs: number | null;
        }) => turns.push(t),
        ended: () => undefined,
      },
    };
  };

  it("records the caller's turn and the agent's reply in the order they happened", () => {
    const r = recording();
    const h = setup({ recorder: r.recorder as unknown as CallRecorder });

    h.listen.final("Tell me about my policy.");

    // Both speakers, and the greeting counts — it is an agent turn like any other.
    expect(r.turns.map((t) => t.speaker)).toContain("caller");
    expect(r.turns.map((t) => t.speaker)).toContain("agent");

    // One shared counter across both speakers: the table is unique on (call, seq), so a
    // per-speaker counter would collide on the second turn.
    const seqs = r.turns.map((t) => t.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    assertInvariants(h);
  });

  /**
   * `barged_in_at_ms` was null on every interruption on every real call. `commitHeard`
   * ran on the first mark the carrier acknowledged and recorded the turn there, clearing
   * `startedAtMs`, so `stopSpeaking`'s own call — the only one that knows where the
   * caller cut in — found nothing left to stamp.
   */
  it("stamps how far the caller heard when they interrupt", () => {
    const r = recording();
    const h = setup({ recorder: r.recorder as unknown as CallRecorder, bargeInGuardMs: 0 });

    // Greeting out of the way first, played and heard in full.
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Tell me about my policy.");
    h.llm.last().emit("It renews in May. ");
    // A second of the reply reaches the caller before they cut in.
    h.tts.last().audio(1600);
    h.stream.ackAll();

    h.listen.speechStart(5_000);

    const interrupted = r.turns.filter((t) => t.speaker === "agent" && t.bargedInAtMs !== null);
    expect(interrupted.length, "no agent turn carries a barge offset").toBeGreaterThan(0);
    for (const t of interrupted) expect(t.bargedInAtMs).toBeGreaterThan(0);
    assertInvariants(h);
  });

  it("records an agent turn once, not once per mark", () => {
    const r = recording();
    const h = setup({ recorder: r.recorder as unknown as CallRecorder });

    // Several marks for one turn: the greeting is marked roughly every 200ms of audio.
    h.tts.last().audio(4800);
    h.tts.last().done();
    h.stream.ackAll();
    h.stream.ackAll();

    const greeting = r.turns.filter((t) => t.speaker === "agent" && t.seq === 1);
    expect(greeting).toHaveLength(1);
    // It played out, so there is no barge offset on it.
    expect(greeting[0]?.bargedInAtMs).toBeNull();
    assertInvariants(h);
  });

  it("does not file the caller's turn as starting at our own echo", () => {
    const r = recording();
    const h = setup({ recorder: r.recorder as unknown as CallRecorder, bargeInGuardMs: 10_000 });
    h.tts.last().audio(800);

    // Our own audio coming back through the handset, suppressed by the guard.
    h.listen.speechStart(1_000);
    // The greeting plays out, so nothing is speaking and the guard no longer applies.
    h.tts.last().done();
    h.stream.ackAll();
    // The caller, genuinely starting.
    h.listen.speechStart(9_000);
    h.listen.final("What are your opening hours?", 11_000);

    const caller = r.turns.filter((t) => t.speaker === "caller");
    expect(caller.map((t) => t.startedOffsetMs)).toEqual([9_000]);
  });

  it("does not record a turn for an agent that never spoke", () => {
    const r = recording();
    setup({ recorder: r.recorder as unknown as CallRecorder, greetingAudio: null });
    expect(r.turns.filter((t) => t.speaker === "agent")).toHaveLength(0);
  });
});

/**
 * The tool loop, at the seam.
 *
 * `packages/tools` has its own tests and they prove the dispatcher. None of them prove
 * that the model is offered anything, that a result reaches the next turn, that holding
 * speech starts before the adapter runs, or that a caller who interrupts is not answered
 * by a tool they talked over. Every serious bug on this project has been at a seam, and
 * this is the seam.
 */
describe("tool calling", () => {
  /** Lets the dispatcher's promise chain settle without pretending time passed. */
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  };

  const READ_TOOL: InternalTool = {
    definition: {
      name: "opening_times",
      description: "Reads something harmless.",
      parameters: { type: "object", properties: {} },
      riskTier: "read",
      summarise: (result) => `The answer is ${String(result)}.`,
    },
    handler: async () => "forty two",
  };

  const BROKEN_TOOL: InternalTool = {
    definition: {
      name: "broken_lookup",
      description: "Reads something from a system that is down.",
      parameters: { type: "object", properties: {} },
      riskTier: "read",
      summarise: () => "unreachable",
    },
    handler: async () => {
      throw new Error("the connector is down");
    },
  };

  const WRITE_TOOL: InternalTool = {
    definition: {
      name: "change_something",
      description: "Changes a stored value.",
      parameters: { type: "object", properties: { value: { type: "string" } } },
      riskTier: "write",
      readback: (args) => `Changing it to ${String(args.value)}. Should I go ahead?`,
      summarise: () => "Done, it is changed.",
    },
    handler: async ({ args }) => ({ value: args.value }),
  };

  const IRREVERSIBLE_TOOL: InternalTool = {
    definition: {
      name: "undo_everything",
      description: "Cannot be taken back.",
      parameters: { type: "object", properties: {} },
      riskTier: "irreversible",
      transferReason: "an irreversible change",
    },
    handler: async () => {
      throw new Error("must never execute");
    },
  };

  /**
   * Wraps the orchestrator's own holding hook so the test can see when it fired without
   * replacing it — the thing under test is that the real hook runs before the adapter.
   */
  const toolHarness = (
    tools: readonly InternalTool[],
  ): {
    makeTools: NonNullable<OrchestratorDeps["makeTools"]>;
    /** Holding-speech registers and adapter invocations, in the order they happened. */
    events: string[];
    ran: string[];
  } => {
    const events: string[] = [];
    const ran: string[] = [];
    const watched = tools.map((tool) => ({
      definition: tool.definition,
      handler: async (call: Parameters<typeof tool.handler>[0]) => {
        events.push(`ran:${call.name}`);
        ran.push(call.name);
        return tool.handler(call);
      },
    }));

    return {
      events,
      ran,
      makeTools: (hooks) => {
        const registry = createToolRegistry();
        registerInternalTools(registry, watched);
        return {
          registry,
          dispatcher: createToolDispatcher({
            registry,
            log: silentLog,
            holding: {
              start: (context) => {
                events.push(`start:${context.name}`);
                hooks.holding.start(context);
              },
              slow: (context) => {
                events.push(`slow:${context.name}`);
                hooks.holding.slow?.(context);
              },
              stop: (context) => {
                events.push(`stop:${context.name}`);
                hooks.holding.stop(context);
              },
            },
          }),
        };
      },
    };
  };

  const started = (h: ReturnType<typeof setup>) => {
    h.tts.last().done();
    h.stream.ackAll();
  };

  it("offers the registered tools to the model", () => {
    const tools = toolHarness([READ_TOOL]);
    const h = setup({ makeTools: tools.makeTools });
    started(h);

    h.listen.final("When do you open?");

    expect(h.llm.last().request.tools?.map((t) => t.name)).toEqual(["opening_times"]);
  });

  // CLAUDE.md rule 3. An unregistered number may hold a conversation and must not reach
  // anybody's systems.
  it("offers nothing at all on a call with no tenant", () => {
    const tools = toolHarness([READ_TOOL]);
    const h = setup({ tenantId: null, makeTools: tools.makeTools });
    started(h);

    h.listen.final("When do you open?");

    expect(h.llm.last().request.tools).toBeUndefined();
  });

  it("never builds a dispatcher on a call with no tenant", () => {
    let built = 0;
    setup({
      tenantId: null,
      makeTools: (hooks) => {
        built += 1;
        const registry = createToolRegistry();
        registerInternalTools(registry, [READ_TOOL]);
        return { registry, dispatcher: createToolDispatcher({ registry, log: silentLog, holding: hooks.holding }) };
      },
    });

    expect(built).toBe(0);
  });

  it("makes a noise before the adapter runs, not after it returns", async () => {
    const tools = toolHarness([READ_TOOL]);
    const h = setup({ ...fillerSetup(), makeTools: tools.makeTools });
    started(h);
    h.listen.final("When do you open?");
    const before = h.stream.bytesSent();

    h.llm.last().callTools([{ name: "opening_times", args: {} }]);

    // R5.4.2, and the ordering IS the requirement: by the time the promise settles the
    // silence has already happened, so a hook that fired around the await would be too
    // late however correct it looked.
    expect(tools.events[0]).toBe("start:opening_times");
    expect(tools.events[1]).toBe("ran:opening_times");
    // Audio went out on the same tick as the dispatch, before any adapter returned.
    expect(h.stream.bytesSent()).toBeGreaterThan(before);
    // The progress register, not the acknowledgement one: "mm-hm" does not explain a
    // pause that has a reason behind it.
    expect(h.tts.texts()).not.toContain("Mm-hm.");

    await settle();
    expect(tools.events).toContain("stop:opening_times");
  });

  it("gives the model the result and speaks the reply it writes", async () => {
    const tools = toolHarness([READ_TOOL]);
    const h = setup({ makeTools: tools.makeTools });
    started(h);
    h.listen.final("When do you open?");
    const asking = h.llm.completions.length;

    h.llm.last().callTools([{ name: "opening_times", args: {} }]);
    await settle();

    expect(h.llm.completions.length).toBe(asking + 1);
    const note = h.llm.lastMessages().at(-1);
    expect(note?.role).toBe("user");
    expect(note?.content).toContain("forty two");

    h.llm.last().emit("We open at forty two. ");
    h.llm.last().finish();
    expect(h.tts.texts().at(-1)).toContain("forty two");
    assertInvariants(h);
  });

  // The failure mode the charter names by name.
  it("tells the model a failed tool failed, so the next sentence cannot claim it worked", async () => {
    const tools = toolHarness([BROKEN_TOOL]);
    const h = setup({ makeTools: tools.makeTools });
    started(h);
    h.listen.final("Check that for me.");

    h.llm.last().callTools([{ name: "broken_lookup", args: {} }]);
    await settle();

    const note = h.llm.lastMessages().at(-1)?.content ?? "";
    expect(note).toContain("FAILED");
    expect(note).toContain("Do not tell the caller it worked");
  });

  it("hands over after the second tool failure rather than asking more questions", async () => {
    const spy = spyHandoff();
    const tools = toolHarness([BROKEN_TOOL]);
    const h = setup({ makeTools: tools.makeTools, makeHandoff: spy.make });
    started(h);

    for (const attempt of ["Check that for me.", "Try again please."]) {
      h.listen.final(attempt);
      h.llm.last().callTools([{ name: "broken_lookup", args: {} }]);
      await settle();
    }

    expect(spy.triggers.map((t) => t.kind)).toEqual(["tool-failed"]);
  });

  it("never runs an irreversible tool and asks for a person instead", async () => {
    const spy = spyHandoff();
    const tools = toolHarness([IRREVERSIBLE_TOOL]);
    const h = setup({ makeTools: tools.makeTools, makeHandoff: spy.make });
    started(h);
    h.listen.final("Undo the whole thing.");

    h.llm.last().callTools([{ name: "undo_everything", args: {} }]);
    await settle();

    expect(tools.ran).toEqual([]);
    // The handoff module owns the transfer. A second path here would be a second answer
    // to "what does the caller hear when it fails".
    expect(spy.triggers.map((t) => t.kind)).toEqual(["needs-a-person"]);
    expect(h.llm.lastMessages().at(-1)?.content).toContain("NOT run");
  });

  it("reads a write back and does not fire it", async () => {
    const tools = toolHarness([WRITE_TOOL]);
    const h = setup({ makeTools: tools.makeTools });
    started(h);
    h.listen.final("Change it for me.");

    h.llm.last().callTools([{ name: "change_something", args: { value: "the new one" } }]);
    await settle();

    expect(tools.ran).toEqual([]);
    // Spoken verbatim rather than paraphrased by the model (R4.3.1).
    expect(h.tts.texts().at(-1)).toContain("Should I go ahead?");
  });

  it("fires the write once the caller says yes", async () => {
    const tools = toolHarness([WRITE_TOOL]);
    const h = setup({ makeTools: tools.makeTools });
    started(h);
    h.listen.final("Change it for me.");
    h.llm.last().callTools([{ name: "change_something", args: { value: "the new one" } }]);
    await settle();
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Yes, go ahead.");
    await settle();

    expect(tools.ran).toEqual(["change_something"]);
    expect(h.tts.texts().at(-1)).toContain("it is changed");
  });

  /** "Yeah, but…" is not a yes. Defaulting to no is the safe direction. */
  const NOT_A_YES: readonly string[] = [
    "No, leave it.",
    "Yeah, but hold on.",
    "Yes? What did you say?",
    "Actually, yes — wait.",
    "Nope.",
    "Hmm, not right.",
  ];

  for (const answer of NOT_A_YES) {
    it(`does not fire the write on ${JSON.stringify(answer)}`, async () => {
      const tools = toolHarness([WRITE_TOOL]);
      const h = setup({ makeTools: tools.makeTools });
      started(h);
      h.listen.final("Change it for me.");
      h.llm.last().callTools([{ name: "change_something", args: { value: "the new one" } }]);
      await settle();
      h.tts.last().done();
      h.stream.ackAll();

      h.listen.final(answer);
      await settle();

      expect(tools.ran).toEqual([]);
    });
  }

  it("answers a second yes as conversation, never as a second write", async () => {
    const tools = toolHarness([WRITE_TOOL]);
    const h = setup({ makeTools: tools.makeTools });
    started(h);
    h.listen.final("Change it for me.");
    h.llm.last().callTools([{ name: "change_something", args: { value: "the new one" } }]);
    await settle();
    h.tts.last().done();
    h.stream.ackAll();
    h.listen.final("Yes.");
    await settle();
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Yes.");
    await settle();

    expect(tools.ran).toEqual(["change_something"]);
  });

  it("drops the outcome of a tool the caller talked over", async () => {
    const tools = toolHarness([READ_TOOL]);
    const h = setup({ bargeInGuardMs: 0, makeTools: tools.makeTools });
    started(h);
    h.listen.final("When do you open?");
    h.llm.last().callTools([{ name: "opening_times", args: {} }]);

    // The caller carries on before the tool comes back. The turn that asked is void.
    h.listen.final("Actually, never mind.");
    const after = h.llm.completions.length;
    await settle();

    // No follow-up turn was manufactured from a result nobody is waiting for.
    expect(h.llm.completions.length).toBe(after);
  });
});

/**
 * `end_call`, `transfer_to_human` and `business_hours` as the call path actually gets
 * them — the real definitions, not stand-ins.
 */
describe("the platform tools on a call", () => {
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  };

  const platform = (businessHours: BusinessHours | null = null): NonNullable<OrchestratorDeps["makeTools"]> =>
    (hooks) => {
      const registry = createToolRegistry();
      registerInternalTools(registry, callControlTools({ endCall: hooks.endCall, businessHours }));
      return {
        registry,
        dispatcher: createToolDispatcher({ registry, log: silentLog, holding: hooks.holding }),
      };
    };

  const started = (h: ReturnType<typeof setup>) => {
    h.tts.last().done();
    h.stream.ackAll();
  };

  it("offers exactly the three non-data tools", () => {
    const h = setup({ makeTools: platform() });
    started(h);
    h.listen.final("Hello.");

    expect(h.llm.last().request.tools?.map((t) => t.name).sort()).toEqual([
      "business_hours",
      "end_call",
      "transfer_to_human",
    ]);
  });

  it("does not hang up until the caller has heard the goodbye", async () => {
    const h = setup({ makeTools: platform() });
    started(h);
    h.listen.final("That is everything, thanks.");

    h.llm.last().callTools([{ name: "end_call", args: { reason: "the caller is done" } }]);
    await settle();
    expect(h.stream.hungUp).toBe(false);

    h.llm.last().emit("Thanks for calling, goodbye. ");
    h.llm.last().finish();
    // Synthesised and queued. The carrier has not played a byte of it, and this is
    // exactly where hanging up truncates the last words.
    h.tts.last().audio(1600);
    h.tts.last().done();
    expect(h.stream.hungUp).toBe(false);

    h.stream.ackAll();
    expect(h.stream.hungUp).toBe(true);
  });

  it("does not hang up on a caller who starts speaking again", async () => {
    const h = setup({ makeTools: platform() });
    started(h);
    h.listen.final("That is everything, thanks.");
    h.llm.last().callTools([{ name: "end_call", args: {} }]);
    await settle();

    h.listen.final("Sorry, one more thing.");
    h.llm.last().emit("Of course. ");
    h.llm.last().finish();
    h.tts.last().audio(1600);
    h.tts.last().done();
    h.stream.ackAll();

    expect(h.stream.hungUp).toBe(false);
  });

  it("routes transfer_to_human through the handoff module rather than a second path", async () => {
    const spy = spyHandoff();
    const h = setup({ makeTools: platform(), makeHandoff: spy.make });
    started(h);
    h.listen.final("I need someone who can actually help.");

    h.llm.last().callTools([{ name: "transfer_to_human", args: {} }]);
    await settle();

    expect(spy.triggers.map((t) => t.kind)).toEqual(["needs-a-person"]);
    expect(h.stream.hungUp).toBe(false);
  });

  it("answers the opening hours from tenant configuration", async () => {
    const h = setup({
      makeTools: platform({ opensAtHour: 9, closesAtHour: 17, openDays: [1, 2, 3, 4, 5] }),
    });
    started(h);
    h.listen.final("Are you open?");

    h.llm.last().callTools([{ name: "business_hours", args: {} }]);
    await settle();

    const note = h.llm.lastMessages().at(-1)?.content ?? "";
    expect(note).toContain("business_hours returned:");
    expect(note).toMatch(/open now|closed at the moment/);
  });

  it("says it does not know when the tenant has configured no hours", async () => {
    const h = setup({ makeTools: platform(null) });
    started(h);
    h.listen.final("Are you open?");

    h.llm.last().callTools([{ name: "business_hours", args: {} }]);
    await settle();

    expect(h.llm.lastMessages().at(-1)?.content).toContain("do not have the opening hours");
  });
});
