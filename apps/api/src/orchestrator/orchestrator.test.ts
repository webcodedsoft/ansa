import type { Message } from "@ansa/llm";
import { describe, expect, it } from "vitest";

import { fakeListen, fakeLlm, fakeStream, fakeTts, silentLog } from "./fakes";
import { runConversation } from "./orchestrator";

const GREETING = "Thank you for calling Ansa.";

const setup = (opts: { bargeInGuardMs?: number } = {}) => {
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
 * Each one corresponds to a bug that reached a live call.
 */
const assertInvariants = (h: ReturnType<typeof setup>): void => {
  const messages: readonly Message[] =
    h.llm.completions.length > 0 ? h.llm.lastMessages() : [];

  // Two adjacent messages from the same speaker means a turn was lost or duplicated.
  for (let i = 1; i < messages.length; i += 1) {
    expect(
      `${String(messages[i - 1]?.role)}->${String(messages[i]?.role)}`,
      `adjacent same-role messages at ${i}: ${JSON.stringify(messages)}`,
    ).not.toBe(`${String(messages[i]?.role)}->${String(messages[i]?.role)}`);
  }

  // Two concurrent syntheses interleave at the carrier and are heard as garbled speech.
  expect(h.tts.live().length, "more than one synthesis in flight").toBeLessThanOrEqual(1);
};

describe("runConversation", () => {
  it("greets the caller through forSpeech, without waiting to be spoken to", () => {
    const h = setup();

    expect(h.tts.texts()).toEqual(["Thank you for calling An-Sah."]);
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
      "Thank you for calling An-Sah.",
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
    h.listen.final("Thank you for calling An-Sah.", 4200);

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
    h.listen.final("thank you for calling an sah", 5000);

    expect(h.llm.completions).toHaveLength(0);
  });

  // The containment filter must never become "ignore the caller while speaking".
  it("answers genuinely new words spoken over the agent", () => {
    const h = setup({ bargeInGuardMs: 0 });
    h.tts.last().audio(800);

    h.listen.final("Actually, I want to cancel my policy.", 5000);

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
  // CLAUDE.md rules out.
  it("ends the call when the listen connection dies", () => {
    const h = setup();
    h.tts.last().audio(800);

    h.listen.failWith("socket closed with code 1006");

    expect(h.stream.hungUp).toBe(true);
    expect(h.tts.syntheses[0]?.cancelled).toBe(true);
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
      content: "Thank you for calling Ansa.",
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

  it("closes the listen session when the call ends", () => {
    const h = setup();

    h.stream.closeCall("carrier sent stop");

    expect(h.listen.closed).toBe(true);
  });
});
