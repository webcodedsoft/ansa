import type { Message } from "@ansa/llm";
import { describe, expect, it } from "vitest";

import type { AudioChunk } from "@ansa/shared";

import { chunkOf, fakeListen, fakeLlm, fakeStream, fakeTts, silentLog } from "./fakes";
import { runConversation } from "./orchestrator";

const GREETING = "Thank you for calling Ansa. How can I help you?";

const setup = (
  opts: {
    bargeInGuardMs?: number;
    greetingAudio?: readonly AudioChunk[] | null;
    fillers?: readonly (readonly AudioChunk[])[];
    fillerAfterMs?: number;
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
    forSpeech: (t) => t.replace(/\bAnsa\b/g, "An-Sah"),
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
      const h = setup({ fillers: [[chunkOf(4800)]], fillerAfterMs: 5 });
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
      const h = setup({ fillers: [[chunkOf(4800)]], fillerAfterMs: 5 });
      h.tts.last().done();
      h.stream.ackAll();
      const marksBefore = h.stream.marks.length;

      h.listen.endOfTurn(1000);
      await new Promise((r) => setTimeout(r, 30));
      h.listen.final("Hello?");

      expect(h.stream.marks.length).toBe(marksBefore);
      expect(h.llm.lastMessages().some((m) => m.content.includes("Mm"))).toBe(false);
    });

    it("does not play filler once the real reply has started", async () => {
      const h = setup({ fillers: [[chunkOf(4800)]], fillerAfterMs: 20 });
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

  it("closes the listen session when the call ends", () => {
    const h = setup();

    h.stream.closeCall("carrier sent stop");

    expect(h.listen.closed).toBe(true);
  });
});
