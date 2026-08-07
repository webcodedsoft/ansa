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

  it("closes the listen session when the call ends", () => {
    const h = setup();

    h.stream.closeCall("carrier sent stop");

    expect(h.listen.closed).toBe(true);
  });
});
