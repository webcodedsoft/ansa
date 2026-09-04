import type { Message } from "@ansa/llm";

import { COURTESY_REPLIES } from "./courtesy";
import { describe, expect, it, vi } from "vitest";

import type { AudioChunk } from "@ansa/shared";

import { asCallId, asOrganizationId, type BusinessHours, type OrganizationId } from "@ansa/shared";
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
import { OUTBOUND_LAYER } from "../prompts/outbound";
import type { Handoff } from "../handoff/handoff";
import type { EscalationTrigger } from "../handoff/triggers";
import type { CallRecorder } from "../telephony/event-log";
import { runConversation, type OrchestratorDeps } from "./orchestrator";

const GREETING = "Thank you for calling Ansa. How can I help you?";

/** Any registered organization. Only the tool tests below care which, and only that it is set. */
const ORGANIZATION = asOrganizationId("5c3d0a5e-1f6d-4f6f-9b3a-0f2d7c8a4e11");

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
    stalledTurnMs?: number;
    minSpeechMs?: number;
    recorder?: CallRecorder;
    facts?: CallFactsStore;
    systemPrompt?: string;
    makeHandoff?: (say: (text: string) => Promise<void>) => Handoff;
    /** Null is an unregistered number: tool calling is off for the whole call. */
    organizationId?: OrganizationId | null;
    makeTools?: OrchestratorDeps["makeTools"];
    speakingRate?: number;
    backchannel?: OrchestratorDeps["backchannel"];
    direction?: OrchestratorDeps["direction"];
    businessHours?: OrchestratorDeps["businessHours"];
    recordDoNotCall?: OrchestratorDeps["recordDoNotCall"];
    callerHistory?: OrchestratorDeps["callerHistory"];
    fields?: OrchestratorDeps["fields"];
    flow?: OrchestratorDeps["flow"];
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
    speakingRate: undefined,
    log: silentLog,
    greeting: GREETING,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    organizationId: ORGANIZATION,
    // No hours by default, so the situation block stays silent about them and every test
    // written before it existed asserts on the same prompt it always did.
    // Inbound unless a test says otherwise, which is what every test written before the
    // outbound layer existed assumed.
    direction: "inbound",
    businessHours: null,
    // No history by default: every test written before this existed sees the same prompt.
    callerHistory: () => null,
    recordDoNotCall: () => undefined,
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

    it("stops the acknowledgement when the caller starts answering into it", async () => {
      /* A filler belongs to no turn: no `turn`, no `bytesSent`, nothing for `stopSpeaking`
         to cancel. So "let me check that" played on over a caller who had started
         answering — the noise meant to cover a gap became an interruption of the reply it
         was covering. */
      const h = setup({ ...fillerSetup(), fillerAfterMs: 5 });
      h.tts.last().done();
      h.stream.ackAll();

      h.listen.endOfTurn(1000);
      await new Promise((r) => setTimeout(r, 30));
      const clearsBefore = h.stream.clears;

      h.listen.speechStart(1200);

      expect(h.stream.clears).toBe(clearsBefore + 1);
    });

    it("does not clear anything when no acknowledgement is playing", async () => {
      /* `clear` throws away whatever the carrier is holding. Calling it on every speech
         start would delete the agent's own sentence at the moment barge-in is deciding
         whether the caller actually interrupted. */
      const h = setup({ ...fillerSetup(), fillerAfterMs: 5 });
      h.tts.last().done();
      h.stream.ackAll();
      const clearsBefore = h.stream.clears;

      h.listen.speechStart(1200);

      expect(h.stream.clears).toBe(clearsBefore);
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

/**
 * The silence a caller actually experiences when the turn detector stops working.
 *
 * Read off the calls of 2026-08-23. The greeting played, the caller spoke, partials
 * arrived, and Flux never closed the turn — so nothing committed, the transcript watchdog
 * was never armed (it arms *at* end-of-turn), and the agent said nothing at all for the
 * rest of the call. Not an error, not a recovery line. Silence.
 */
/**
 * The call at 17:32 on 2026-08-23, in full:
 *
 *   caller  Hi. Good evening. My name is Sikir. How are you doing?
 *   agent   Sikir — have I got that right?
 *
 * The prompt tells the model to answer what the caller actually said before moving the call
 * on, and the model never saw this turn: capture handled it and returned. So the fix is
 * here rather than in a layer.
 */
describe("a caller who says hello while the form is listening", () => {
  /* One question, declared once, so the list test and the graph test below are asking the
     same thing. If they drifted, the parity they claim to show would be a coincidence. */
  const ASKS_A_NAME = {
    key: "callerName",
    type: "name",
    prompt: "Who am I speaking with?",
    capture: "speech",
    confirm: "readback",
    required: true,
    pattern: "",
    attempts: 3,
    options: [],
  } as const;

  const NAME_FIELD: OrchestratorDeps["fields"] = [ASKS_A_NAME];

  /**
   * The same call, conducted by a graph instead of a list.
   *
   * This is the test the whole seam exists for. `outstanding()` is one `Array.find` over an
   * ordered list in `createForm` and a replayed walk of a graph in `createFlowForm`, and the
   * claim is that nothing below the director can tell which it got. The way to check that
   * claim is not to inspect the director — it is to run a real call through the orchestrator
   * with a graph and assert on the row that comes out the other end, which is exactly what
   * the form test below asserts, with the same value and the same shape.
   *
   * It is also the answer to the thing that goes wrong with work built in parallel: the
   * graph director existed, was tested, and was called by nothing. A passing unit test on an
   * unreachable module reads as progress and is inventory.
   */
  it("conducts the same call from a graph, and stores the same value", () => {
    const captured: { fieldKey: string; fieldType: string; value: string; attempts: number }[] = [];
    const h = setup({
      flow: {
        version: 1,
        nodes: [
          { id: "start", kind: "start", x: 0, y: 0 },
          {
            id: "ask-name",
            kind: "collect",
            x: 220,
            y: 0,
            field: ASKS_A_NAME,
          },
          { id: "end", kind: "hangup", x: 440, y: 0 },
        ],
        edges: [
          { from: "start", to: "ask-name" },
          { from: "ask-name", to: "end" },
        ],
      },
      recorder: {
        started: () => undefined,
        event: () => undefined,
        transcript: () => undefined,
        turn: () => undefined,
        latency: () => undefined,
        capture: (c: { fieldKey: string; fieldType: string; value: string; attempts: number }) =>
          captured.push(c),
        ended: () => undefined,
      } as unknown as CallRecorder,
    });
    h.tts.last().done();
    h.stream.ackAll();

    /* A bare answer, with no "my name is" in front of it, and that is the whole point.
       Free-speech parsing cannot tell "Sikiru" from any other word in a sentence; it is
       unambiguous only as the answer to a question that was just asked. So this line is
       captured if and only if a director armed the engine to expect a name — which means
       the graph is conducting this call, not merely present in the deps. */
    h.listen.final("Sikiru");
    h.listen.final("Yes, that is right.");

    expect(captured).toEqual([
      { fieldKey: "callerName", fieldType: "name", value: "Sikiru", attempts: 1 },
    ]);
  });

  /**
   * Found on review, by running it. The director arms the engine for the first question
   * the moment the call connects, and the engine treated the caller's opening sentence as
   * a botched answer: "Thank you for calling. — Sorry, and your name?" on every call to an
   * agent whose first question was a name, with the model never hearing the sentence.
   */
  it("lets the caller's opening sentence reach the model instead of re-asking a question nobody put", () => {
    const h = setup({ fields: NAME_FIELD });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("I saw your listing and wanted to ask about it.");

    expect(h.llm.completions).toHaveLength(1);
    expect(h.tts.texts().join(" ")).not.toContain("Sorry —");
    // Still armed: the model puts the question on this turn, and the answer is parsed as one.
    h.llm.last().emit("Of course. Who am I speaking with? ");
    h.llm.last().finish();
    h.tts.last().done();
    h.stream.ackAll();
    h.listen.final("Sikiru");
    expect(h.tts.texts().at(-1)).toContain("Sikiru");
  });

  it("still re-asks a caller who did not catch the question", () => {
    const h = setup({ fields: NAME_FIELD });
    h.tts.last().done();
    h.stream.ackAll();
    h.listen.final("I saw your listing and wanted to ask about it.");
    h.llm.last().emit("Of course. Who am I speaking with? ");
    h.llm.last().finish();
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Sorry, what?");

    // Handled without the model: the question is put again, and nothing about the listing
    // is answered a second time.
    expect(h.llm.completions).toHaveLength(1);
    expect(h.tts.texts().at(-1)).toContain("Who am I speaking with?");

    // A mumble at the question, once it has been put, is the engine's to re-ask.
    h.tts.last().done();
    h.stream.ackAll();
    h.listen.final("erm");
    expect(h.tts.texts().at(-1)).toContain("Sorry —");
    expect(h.llm.completions).toHaveLength(1);
  });

  /**
   * The outbound layer tells the model never to ask a stranger for an ID. This is the half
   * a prompt cannot hold: the engine is never armed for one, and the director is never
   * steered to ask, whatever the form or the graph says.
   */
  it("never arms a question a stranger must not be asked on a call the agent placed", () => {
    const captured: unknown[] = [];
    const h = setup({
      direction: "outbound",
      fields: [
        { ...ASKS_A_NAME, key: "nin", type: "nin", prompt: "Your NIN?" },
        ASKS_A_NAME,
      ],
      recorder: {
        started: () => undefined, event: () => undefined, transcript: () => undefined,
        turn: () => undefined, latency: () => undefined,
        capture: (c: unknown) => captured.push(c), ended: () => undefined,
      } as unknown as CallRecorder,
    });
    h.tts.last().done();
    h.stream.ackAll();

    // Eleven digits, which is a NIN — and on an inbound call would be read back as one.
    h.listen.final("one two three four five six seven eight nine zero one");

    expect(h.tts.texts().join(" ")).not.toMatch(/one two three|NIN/);
    expect(captured).toEqual([]);
    // The name, which may be asked, is what the engine is waiting for instead.
    h.llm.last().emit("Who am I speaking with? ");
    h.llm.last().finish();
    h.tts.last().done();
    h.stream.ackAll();
    h.listen.final("Sikiru");
    expect(h.tts.texts().at(-1)).toContain("Sikiru");
  });

  it("stores the value once the caller agrees to it", () => {
    /* The whole point of a form. Everything downstream — the call page, the dataset, the
       export — reads this row, and before it existed the value survived only as an
       `entity_candidate` event that had to be paired back to a confirmation by character
       count. */
    const captured: { fieldKey: string; fieldType: string; value: string; attempts: number }[] = [];
    const h = setup({
      fields: NAME_FIELD,
      recorder: {
        started: () => undefined,
        event: () => undefined,
        transcript: () => undefined,
        turn: () => undefined,
        latency: () => undefined,
        capture: (c: { fieldKey: string; fieldType: string; value: string; attempts: number }) =>
          captured.push(c),
        ended: () => undefined,
      } as unknown as CallRecorder,
    });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("My name is Sikiru.");
    h.listen.final("Yes, that is right.");

    expect(captured).toEqual([
      { fieldKey: "callerName", fieldType: "name", value: "Sikiru", attempts: 1 },
    ]);
  });

  it("stores nothing until the caller has agreed", () => {
    /* A readback is a question, not a record. Storing the candidate would put a
       misheard name in the organisation's dataset and then never correct it. */
    const captured: unknown[] = [];
    const h = setup({
      fields: NAME_FIELD,
      recorder: {
        started: () => undefined,
        event: () => undefined,
        transcript: () => undefined,
        turn: () => undefined,
        latency: () => undefined,
        capture: (c: unknown) => captured.push(c),
        ended: () => undefined,
      } as unknown as CallRecorder,
    });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("My name is Sikiru.");

    expect(captured).toEqual([]);
  });

  it("answers how it is, and reads the name back, in one turn", () => {
    const h = setup({ fields: NAME_FIELD });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Hi. Good evening. My name is Sikiru. How are you doing?");

    const spoken = h.tts.texts().slice(1).join(" ");
    expect(spoken).toContain("Sikiru");
    // Whichever wording the picker chose, one of them was said.
    expect(COURTESY_REPLIES.some((reply) => spoken.includes(reply))).toBe(true);
  });

  it("says it once, not every time they ask", () => {
    /* Somebody who asks twice is making conversation. Answering again would be the agent
       steering into small talk rather than out of it. */
    const h = setup({ fields: NAME_FIELD });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Hi, my name is Sikiru, how are you doing?");
    const first = h.tts.texts().length;
    h.tts.last().done();
    h.stream.ackAll();
    h.listen.final("No — how are you though?");

    /* Checked against the whole set, not a phrase from it. The picker rotates, so a
       regular expression for one wording passes while another is being said — which is
       how the first version of this test passed with the guard deleted. */
    const later = h.tts.texts().slice(first).join(" ");
    for (const reply of COURTESY_REPLIES) expect(later, reply).not.toContain(reply);
  });

  it("does not answer a caller who only said good evening", () => {
    const h = setup({ fields: NAME_FIELD });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Good evening. My name is Sikiru.");

    const spoken = h.tts.texts().slice(1).join(" ");
    for (const reply of COURTESY_REPLIES) expect(spoken, reply).not.toContain(reply);
  });
});

describe("a turn that never ends", () => {
  const STALL = 8_000;

  it("says something rather than nothing", () => {
    vi.useFakeTimers();
    try {
      const h = setup({ stalledTurnMs: STALL });
      h.tts.last().done();
      h.stream.ackAll();
      const before = h.tts.texts().length;

      h.listen.speechStart(1000);
      h.listen.interim("my name is");
      // No end-of-turn ever arrives, which is the whole failure.
      vi.advanceTimersByTime(STALL + 500);

      expect(h.tts.texts().length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("speaks even when nothing they said ever transcribes", () => {
    /* The worst case and the one the speech-start arm exists for: the line is bad enough
       that not one partial arrives, so there is nothing to defer on and nothing to commit.
       Armed on speech start rather than on the first partial, or this case is silent. */
    vi.useFakeTimers();
    try {
      const h = setup({ stalledTurnMs: STALL, transcriptWatchdogMs: 60_000 });
      h.tts.last().done();
      h.stream.ackAll();
      const before = h.tts.texts().length;

      h.listen.speechStart(1000);
      vi.advanceTimersByTime(STALL + 500);

      expect(h.tts.texts().length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds off while the caller is still audibly talking", () => {
    /* Counting from the first word would cut across anyone giving a long answer. Each
       partial stands the timer down, so it only fires once they have gone quiet to us. */
    vi.useFakeTimers();
    try {
      const h = setup({ stalledTurnMs: STALL });
      h.tts.last().done();
      h.stream.ackAll();
      const before = h.tts.texts().length;

      h.listen.speechStart(1000);
      for (let i = 0; i < 6; i += 1) {
        vi.advanceTimersByTime(STALL - 1000);
        h.listen.interim(`still going ${i}`);
      }

      expect(h.tts.texts().length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires on a real event loop, not only a mocked one", async () => {
    /* Every other test here runs on fake timers, and `vi.advanceTimersByTime` fires an
       unref'd timer whether or not a real loop would. On the call of 2026-08-23 21:15 the
       watchdog armed on speech start and nothing was heard for the 25 seconds until the
       caller hung up — no error, no recovery line. Fake timers cannot see a difference
       like that, so this one waits on the clock the process actually uses. */
    const h = setup({ stalledTurnMs: 120, transcriptWatchdogMs: 60_000 });
    h.tts.last().done();
    h.stream.ackAll();
    const before = h.tts.texts().length;

    h.listen.speechStart(1000);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(h.tts.texts().length).toBeGreaterThan(before);
  });

  it("stands down when the turn does end", () => {
    vi.useFakeTimers();
    try {
      /* The transcript watchdog is pushed out of the way so that anything spoken here
         could only have come from the stall timer. Both fire on silence, and a test that
         cannot tell them apart proves nothing about either. */
      const h = setup({ stalledTurnMs: STALL, transcriptWatchdogMs: 60_000 });
      h.tts.last().done();
      h.stream.ackAll();

      h.listen.speechStart(1000);
      h.listen.interim("my name is Sikiru");
      h.listen.endOfTurn(2000);
      const afterTurn = h.tts.texts().length;
      vi.advanceTimersByTime(STALL + 500);

      expect(h.tts.texts().length).toBe(afterTurn);
    } finally {
      vi.useRealTimers();
    }
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

  /**
   * Read off the call at 11:10 on 2026-08-23.
   *
   * The caller confirmed their name, the model opened with a two-word acknowledgement, and
   * the cap cancelled the completion behind it. `wordsSpoken > 0` was satisfied by those two
   * words, so the sentence carrying the next question never went out. The caller waited
   * twelve seconds and asked "Are you there?".
   */
  it("does not let an opener eat the answer behind it", () => {
    const spoken = askAndCount(
      setup(),
      "Is my policy still active?",
      "Okay. Your policy is active and it renews in May of next year.",
    );
    // Two words is less than an interjection, so the sentence behind it still goes.
    expect(spoken).toBeGreaterThan(2);
  });

  it("still caps once a whole answer has been said", () => {
    /* The other side of the same boundary, and why the threshold is words. "Yes, it is."
       is three words and answers the question; what follows it is the rambling the cap
       exists to stop. */
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
    // A readback: the value, said back, as a question. Which of the pool's sentences carried
    // it is not the point — that it was put to the caller before the model saw it is.
    const said = h.tts.texts().at(-1) ?? "";
    expect(said).toContain("four one seven");
    expect(said.trim().endsWith("?")).toBe(true);
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
  it("sends the organization's composed prompt, not the default one", () => {
    // A organization's persona has been loaded, validated and composed on every config load
    // since the prompt layers landed, and the orchestrator used the default anyway.
    const organizationPrompt = "You are answering for a organization whose own layer is in this text.";
    const h = setup({ systemPrompt: organizationPrompt });

    h.listen.final("What are your opening hours?");

    const system = h.llm.last().request.system;
    expect(system.startsWith(organizationPrompt)).toBe(true);
    // The turn budget still lands last, which is how the layering already worked.
    expect(system.length).toBeGreaterThan(organizationPrompt.length);
    assertInvariants(h);
  });

  it("warms the model with that same prompt as the call connects", () => {
    /* The first turn otherwise pays for the connection and a cold prompt cache at the one
       moment the caller is listening hardest. Sending the real prefix is the point: a stub
       string would open the socket and prime nothing, and the prefix is what every turn of
       this call resends. */
    const organizationPrompt = "You are answering for a organization whose own layer is in this text.";
    const h = setup({ systemPrompt: organizationPrompt });

    expect(h.llm.warmUps).toEqual([organizationPrompt]);
    // And it is not a turn. Everything that counts completions would be off by one.
    expect(h.llm.completions).toHaveLength(0);
    assertInvariants(h);
  });

  /**
   * The block is inert unless a real turn reaches it, and a pure module with its own
   * passing tests is exactly the shape of thing that ships unwired. This drives the
   * orchestrator and reads the prompt the model was actually sent.
   */
  it("puts where the call is into the prompt, worked out rather than asked", () => {
    /* No open days at all, so the line is shut whenever this suite happens to run. The
       first version used ordinary office hours and asserted "one of closed, closing or
       quiet", which every possible output satisfies — it would have passed with the block
       unwired. */
    const h = setup({ businessHours: { opensAtHour: 9, closesAtHour: 17, openDays: [] } });

    h.listen.final("What are your opening hours?");

    const system = h.llm.last().request.system;
    expect(system).toContain("Where this call is right now");
    expect(system).toContain("The line is closed right now");
    expect(system).toContain("Do not promise anything for today");
    // The hour in words the model does not have to derive, which is the whole point.
    expect(system).toMatch(/It is \d\d:\d\d (in the|at)/);
    assertInvariants(h);
  });

  it("opens knowing a returning caller, without being told what they called about", () => {
    /* The read is started as the call connects and this stands in for it having landed.
       What matters is that it reaches the prompt at all: a getter that nothing calls is
       the shape of thing that ships unreachable. */
    const h = setup({
      callerHistory: () => ({
        lastContactDaysAgo: 1,
        contactsThisWeek: 2,
        lastCallAbout: null,
      lastCallHandedOver: true,
      }),
    });

    h.listen.final("What are your opening hours?");

    const system = h.llm.last().request.system;
    expect(system).toContain("They called before, yesterday");
    expect(system).toContain("do not make them explain it again");
    expect(system).toContain("a person taking over");
    /* Nothing on disk knows what the last call was about, so nothing here may imply it.
       An agent told an issue is unresolved will invent the issue. */
    expect(system).not.toContain("unresolved");
    assertInvariants(h);
  });

  it("says nothing about history the read has not returned", () => {
    // A withheld number, no database, or a read still in flight. Treat them as new.
    const h = setup({ callerHistory: () => null });

    h.listen.final("What are your opening hours?");

    expect(h.llm.last().request.system).not.toContain("They called before");
    assertInvariants(h);
  });

  /**
   * The marker on a real turn.
   *
   * The unit tests cover the stripper; this covers the thing that actually breaks a call —
   * whether the marker reaches the synthesiser. It sits on the token path of every turn,
   * so getting it wrong is not a wrong label, it is the caller hearing angle brackets read
   * out at the end of every sentence.
   */
  it("never synthesises the read, and feeds it back on the next turn", () => {
    const h = setup();
    // The greeting out of the way, so what follows is the reply and nothing else.
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("I've been waiting for weeks.");
    h.llm.last().emit("I'm sorry about that.");
    h.llm.last().emit("\n<<read: emotion=frustrated, energy=high, trust=low, urgency=high>>");
    h.llm.last().finish();

    // Nothing the caller hears carries any of it.
    const spoken = h.tts.texts().join(" ");
    expect(spoken).toContain("I'm sorry about that.");
    expect(spoken).not.toContain("<<");
    expect(spoken).not.toContain("read:");
    expect(spoken).not.toContain("frustrated");

    /* And it is in front of the model next turn. A substantive question rather than "yes
       please": a bare affirmative is read as a confirmation, no completion is requested,
       and `last()` would hand back the previous turn's prompt — which predates the read
       and would make this pass for the wrong reason. */
    const before = h.llm.completions.length;
    h.listen.final("What are your opening hours?");
    expect(h.llm.completions.length).toBeGreaterThan(before);

    const system = h.llm.last().request.system;
    expect(system).toContain("How they sound: frustrated");
    expect(system).toContain("Trust low");
    assertInvariants(h);
  });

  it("keeps the last good read when a turn's marker is malformed", () => {
    /* The caller cannot hear this line. Blanking the read over a typo would throw away the
       arc the next turn's guidance is written against. */
    const h = setup();

    h.listen.final("I've been waiting for weeks.");
    h.llm.last().emit("Let me check.<<read: emotion=upset>>");
    h.llm.last().finish();

    h.listen.final("And what about the other one?");
    h.llm.last().emit("One moment.<<read: emotion=annoyed>>");
    h.llm.last().finish();

    h.listen.final("What are your opening hours?");
    expect(h.llm.last().request.system).toContain("How they sound: upset");
    assertInvariants(h);
  });

  /**
   * The suppression list had a reader and no writer.
   *
   * `mayCall` has checked `do_not_call` before consent and before hours since it was
   * written, and every row in that table was put there by hand. A matcher with passing unit
   * tests and no call site would have left it exactly as it was, so this drives a real turn.
   */
  it("writes down a caller asking never to be called again", () => {
    const asked: string[] = [];
    const h = setup({ recordDoNotCall: (saidWhat) => asked.push(saidWhat) });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Please take me off your list.");

    // Their own words, not a canned reason: it is what somebody reviewing a complaint six
    // months from now will want to read.
    expect(asked).toEqual(["Please take me off your list."]);
    assertInvariants(h);
  });

  it("still answers the caller who asked, rather than going silent on them", () => {
    /* Recording is not the end of the turn. Somebody who asks to be taken off a list is
       owed an acknowledgement out loud, and a request answered with silence is the version
       of this that generates the complaint anyway. */
    const h = setup({ recordDoNotCall: () => undefined });
    h.tts.last().done();
    h.stream.ackAll();

    const before = h.llm.completions.length;
    h.listen.final("Please take me off your list.");

    expect(h.llm.completions.length).toBeGreaterThan(before);
    assertInvariants(h);
  });

  it("records the suppression even when the same breath asks for a person", () => {
    /* This is why the check sits before the handoff branch and not after it. `callerSaid`
       returns early — the caller is leaving, no model turn follows — so anything downstream
       of it never runs. Placed after, a caller who says "take me off your list, put me
       through to someone" gets transferred and never suppressed, which is the exact request
       being ignored. */
    const asked: string[] = [];
    /* A handoff has to be configured or `escalate` returns false, the branch never returns
       early, and the ordering this test exists for is unobservable — which is exactly how
       the first version of it passed with the check moved. */
    const h = setup({
      makeHandoff: spyHandoff().make,
      recordDoNotCall: (saidWhat) => asked.push(saidWhat),
    });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Take me off your list and put me through to a person.");

    expect(asked).toHaveLength(1);
  });

  it("does not suppress a caller who only asked for a person", () => {
    // The two read alike and mean opposite things. This is the expensive mistake.
    const asked: string[] = [];
    const h = setup({ recordDoNotCall: (saidWhat) => asked.push(saidWhat) });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Put me through to a person please.");

    expect(asked).toEqual([]);
  });

  /**
   * The output guard, on a real turn.
   *
   * The unit tests cover the rule; this covers the two things that decide whether it is a
   * guard or a decoration — that a blocked sentence never reaches TTS, and that the flag it
   * reads actually tracks whether a tool ran.
   */
  it("does not speak a claim the turn cannot support", () => {
    const h = setup();
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Can you refund my last payment?");
    h.llm.last().emit("I've refunded that for you.");
    h.llm.last().finish();

    const spoken = h.tts.texts().join(" ");
    expect(spoken).not.toContain("refunded");
    // Not silence either. The caller is owed a sentence while the handover happens.
    expect(spoken).toContain("someone to confirm that");
    assertInvariants(h);
  });

  it("still says the sentence when a tool actually ran this exchange", () => {
    /* Without this the guard is unusable: the agent could never report anything it had
       genuinely just done, which is most of what a tool is for. */
    const h = setup({ makeTools: undefined });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("What are your opening hours?");
    h.llm.last().emit("I'll check that for you.");
    h.llm.last().finish();

    expect(h.tts.texts().join(" ")).toContain("I'll check that");
    assertInvariants(h);
  });

  it("writes down a reply that drifted, with the turn it happened on", () => {
    /* The signal is write-only unless a real turn reaches it, and it changes nothing the
       caller hears — the normalizer strips the formatting either way — so this is the only
       thing that proves it exists at all. */
    const seen: { kind: string; detail: Record<string, unknown> }[] = [];
    const h = setup({
      recorder: {
        started: () => undefined,
        event: (kind: string, detail?: Record<string, unknown>) =>
          seen.push({ kind, detail: detail ?? {} }),
        transcript: () => undefined,
        turn: () => undefined,
        latency: () => undefined,
        ended: () => undefined,
      } as unknown as CallRecorder,
    });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("What are your opening hours?");
    /* Screen formatting rather than an over-long reply, and the difference matters. A reply
       long enough to trip `tooLong` also trips the turn budget, which cuts the turn — and a
       cut turn nulls `turn`, so `onDone` returns before ever reaching the drift check. The
       formatting signal is the one observable on a turn that completes. See TASKS.md. */
    h.llm.last().emit("That's **important** to know.");
    h.llm.last().finish();

    const drift = seen.find((e) => e.kind === "drift");
    expect(drift?.detail["screenFormatting"]).toBe(true);
    // The turn number is the point: a cluster after turn fifteen is a different problem.
    expect(drift?.detail["seq"]).toEqual(expect.any(Number));
    assertInvariants(h);
  });

  it("records the drift on a turn the budget cut short", () => {
    /**
     * The gap the previous commit left, and the one the first version of the test above
     * ran into. A reply long enough to run past three sentences also runs past the turn
     * budget, which cancels the completion — so there is no `onDone`, no `full`, and
     * nothing for `driftIn` to read. On exactly the turns that drift most, the signal was
     * absent. The cap site is the only place that knows.
     */
    const seen: { kind: string; detail: Record<string, unknown> }[] = [];
    const h = setup({
      recorder: {
        started: () => undefined,
        event: (kind: string, detail?: Record<string, unknown>) =>
          seen.push({ kind, detail: detail ?? {} }),
        transcript: () => undefined,
        turn: () => undefined,
        latency: () => undefined,
        ended: () => undefined,
      } as unknown as CallRecorder,
    });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("What are your opening hours?");
    // Far past any budget, one sentence at a time, so the cap fires mid-generation.
    for (const sentence of [
      "We open at nine in the morning every weekday. ",
      "We close at five in the afternoon on those days. ",
      "On Saturday we open later and close earlier than that. ",
      "On Sunday we do not open at all, not even for urgent things. ",
    ]) {
      h.llm.last().emit(sentence);
    }

    const drift = seen.find((e) => e.kind === "drift");
    expect(drift?.detail["tooLong"]).toBe(true);
    // Flagged as a cap, so a reader can tell a floor from a count.
    expect(drift?.detail["capped"]).toBe(true);
    assertInvariants(h);
  });

  /**
   * Outbound is not inbound with the direction flipped.
   *
   * The rule that matters most is a prohibition: a stranger who telephones somebody and
   * asks for their date of birth is indistinguishable from a scam, and asking teaches them
   * to answer the next person who does. An outbound call conducted with inbound
   * instructions is the worst single thing this codebase can do, so the wiring is asserted
   * rather than assumed.
   */
  it("tells an outbound agent never to ask a stranger to verify themselves", () => {
    const h = setup({ direction: "outbound" });

    h.listen.final("What are your opening hours?");

    const system = h.llm.last().request.system;
    expect(system).toContain("You placed this call");
    expect(system).toContain("must never ask them for any of these");
    expect(system).toContain("date of birth");
    expect(system).toContain("one-time code");
    assertInvariants(h);
  });

  it("says none of that on an inbound call", () => {
    /* Inbound, the caller rang us and verification is how their account is protected.
       Loading the outbound prohibitions there would stop the agent doing its job. */
    const h = setup({ direction: "inbound" });

    h.listen.final("What are your opening hours?");

    expect(h.llm.last().request.system).not.toContain("You placed this call");
    assertInvariants(h);
  });

  it("keeps the outbound layer inside the part of the prompt that can be cached", () => {
    /* Static for the whole call, so it belongs before anything that moves per turn. After
       the situation block it would sit downstream of a clock that changes every turn, and
       the cacheable prefix would end at the base prompt instead of after this. */
    const h = setup({ direction: "outbound" });

    h.listen.final("What are your opening hours?");

    /* The property, stated exactly: the outbound layer follows the base prompt and nothing
       comes between them. An earlier version asserted it appeared before a phrase I assumed
       belonged to the per-turn budget line — the phrase was in the base prompt, so the
       assertion was about nothing. */
    const system = h.llm.last().request.system;
    expect(system.startsWith(`${DEFAULT_SYSTEM_PROMPT}\n\n${OUTBOUND_LAYER}`)).toBe(true);
  });

  /**
   * Small noises while the caller is still talking.
   *
   * Off unless a deployment turns it on, because the failure mode when the gate is wrong
   * is the agent reacting to its own noise — the barge-in defect Phase 2 removed, rebuilt
   * by the feature meant to make calls feel warmer.
   */
  describe("backchannels", () => {
    const LONG = "so what happened was I ordered the thing last week and it never turned up";

    const listening = (over: Parameters<typeof setup>[0] = {}) => {
      const h = setup({ ...fillerSetup(), ...over });
      // Greeting played and heard, so nothing of ours is speaking.
      h.tts.last().done();
      h.stream.ackAll();
      return h;
    };

    it("says nothing at all unless a deployment turned it on", () => {
      const h = listening();
      const before = h.stream.bytesSent();

      h.listen.interim(LONG);

      expect(h.stream.bytesSent()).toBe(before);
      assertInvariants(h);
    });

    it("makes a noise once the caller has been going a while", () => {
      const h = listening({ backchannel: true });
      const before = h.stream.bytesSent();

      h.listen.interim(LONG);

      expect(h.stream.bytesSent()).toBeGreaterThan(before);
      assertInvariants(h);
    });

    it("stays quiet over somebody's first few words", () => {
      // A noise there is not listening, it is barging in.
      const h = listening({ backchannel: true });
      const before = h.stream.bytesSent();

      h.listen.interim("hello I wanted to ask");

      expect(h.stream.bytesSent()).toBe(before);
    });

    it("does not make one every time a partial arrives", () => {
      /* Interim transcripts land several times a second. Overdone, this is far worse than
         silence, so the rate limit is the difference between listening and gibbering. */
      const h = listening({ backchannel: true });
      h.listen.interim(LONG);
      const afterFirst = h.stream.bytesSent();

      h.listen.interim(`${LONG} and I have been waiting since`);
      h.listen.interim(`${LONG} and I have been waiting since then for it`);

      expect(h.stream.bytesSent()).toBe(afterFirst);
    });

    it("never makes one over its own sentence", () => {
      /* Over our own audio this is not a backchannel, it is the agent clashing with
         itself. The caller's transcript can arrive while the agent is still speaking —
         the echo guard suppresses the speech start, not the transcript behind it. */
      const h = setup({ ...fillerSetup(), backchannel: true });
      // The greeting is still playing: nothing acked, so the agent has a turn.
      const before = h.stream.bytesSent();

      h.listen.interim(LONG);

      expect(h.stream.bytesSent()).toBe(before);
    });

    it("does not file the caller's turn as starting at its own noise", async () => {
      /**
       * The gate, and the whole reason this is safe to switch on.
       *
       * The existing echo guard cannot catch this: it is anchored on `sentenceAudioAt`,
       * which exists only while the agent has a turn, and a backchannel plays precisely
       * when it does not. Ungated, our "mm-hm" comes back through the handset as a speech
       * start and stamps the caller's turn there — the same defect the comment on that
       * guard records, one layer down.
       *
       * An earlier version of this asserted no completion was requested, which was true
       * with the gate removed as well, so it proved nothing.
       */
      const turns: { speaker: string; startedOffsetMs: number }[] = [];
      const h = listening({
        backchannel: true,
        recorder: {
          started: () => undefined,
          event: () => undefined,
          transcript: () => undefined,
          turn: (t: { speaker: string; startedOffsetMs: number }) => turns.push(t),
          latency: () => undefined,
          ended: () => undefined,
        } as unknown as CallRecorder,
      });

      h.listen.interim(LONG);
      // Our own noise returning, immediately.
      h.listen.speechStart(1_000);

      /* Real time, because the gate is wall-clock — our audio physically comes back
         through the handset, which is a duration and not a stream offset. Firing both
         starts on the same tick puts them both inside the window, which is what the first
         version of this test did. The wait has to clear the audio's own length as well as
         the tail, which is why it is not 150ms. */
      await new Promise((resolve) => setTimeout(resolve, 1_200));

      // The caller, genuinely, once our noise is long finished.
      h.listen.speechStart(9_000);
      h.listen.final("so it never turned up", 11_000);

      const caller = turns.filter((t) => t.speaker === "caller");
      expect(caller.map((t) => t.startedOffsetMs)).toEqual([9_000]);
    });
  });

  /**
   * The transcriber's doubt reaches the model. It always reached the capture engine, which
   * checks a doubtful value harder; the model was left to answer the sensible reading of
   * every turn, doubted or not, and guessed on the ones it should have asked about.
   */
  it("tells the model when the caller's last turn was doubtful, and not otherwise", () => {
    const h = setup();
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("I want to move my appointment to the other branch.", 0, 0.4);
    expect(h.llm.last().request.system).toContain("came through unclearly");
    h.llm.last().emit("Which branch would that be? ");
    h.llm.last().finish();
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("The one on the mainland, please.", 0, 0.95);
    expect(h.llm.last().request.system).not.toContain("unclearly");
  });

  it("does not carry a doubted turn forward across an exchange the engine handled", () => {
    const h = setup({
      fields: [{ key: "callerName", type: "name", prompt: "Who am I speaking with?", capture: "speech", confirm: "readback", required: true, pattern: "", attempts: 3, options: [] }],
    });
    h.tts.last().done();
    h.stream.ackAll();

    // Doubted, and answered by the model.
    h.listen.final("I want to move my appointment to the other branch.", 0, 0.4);
    expect(h.llm.last().request.system).toContain("came through unclearly");
    h.llm.last().emit("Of course. Who am I speaking with? ");
    h.llm.last().finish();
    h.tts.last().done();
    h.stream.ackAll();

    // Heard clearly, and handled by the engine: a name, read back, agreed.
    h.listen.final("Sikiru", 0, 0.95);
    h.tts.last().done();
    h.stream.ackAll();
    h.listen.final("Yes, that's right.", 0, 0.95);

    // The model's next turn is about a turn that was clear. The old doubt must not be on it.
    expect(h.llm.last().request.system).not.toContain("unclearly");
  });

  it("says nothing about hours on an ordinary in-hours turn", () => {
    /* Open is the default the prompt is written against. A block that fires every turn
       costs prompt budget for something the model was going to assume anyway. */
    /* Pinned to the middle of the day. This read the wall clock, and "closes at 24" is
       "closes in twenty minutes" at twenty to midnight — so it failed once a day, for
       whoever happened to be running the suite late. */
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00+01:00"));
    try {
      const h = setup({
        businessHours: { opensAtHour: 0, closesAtHour: 24, openDays: [1, 2, 3, 4, 5, 6, 7] },
      });

      h.listen.final("What are your opening hours?");

      /* The block itself is always sent now — it carries today's date, which the agent
         cannot derive. What must be absent on an ordinary in-hours turn is anything about
         the hours themselves. */
      expect(h.llm.last().request.system).not.toContain("closes in");
      expect(h.llm.last().request.system).not.toContain("closed right now");
      assertInvariants(h);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the agent when turns have gone nowhere, before the hard rule transfers", () => {
    /* The transfer at three is enforced in code and stays enforced. This is the earlier,
       softer half: an agent that can see two failures can offer a person itself, which
       lands better than a transfer arriving mid-sentence on the third. */
    const h = setup({
      businessHours: { opensAtHour: 0, closesAtHour: 24, openDays: [1, 2, 3, 4, 5, 6, 7] },
    });

    // A turn that produced nothing to say is one that went nowhere.
    h.listen.final("Hello?");
    h.llm.last().fail("upstream fell over");
    h.listen.final("Are you there?");

    expect(h.llm.last().request.system).toContain("gone nowhere on this call");
    assertInvariants(h);
  });

  it("warms once per call, not once per turn", () => {
    const h = setup();

    h.listen.final("What are your opening hours?");
    h.llm.last().emit("We open at nine.");
    h.llm.last().finish();
    h.listen.final("And on Saturdays?");

    expect(h.llm.warmUps).toHaveLength(1);
    assertInvariants(h);
  });
});

describe("what the agent knows about the call (§10)", () => {
  const newFacts = (): CallFactsStore =>
    createCallFacts({
      organizationId: asOrganizationId("11111111-1111-4111-8111-111111111111"),
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

/**
 * What the caller heard, and what to do when they did not mean to interrupt.
 *
 * Barge-in fires on a *sound*, 300-1200ms before the transcript that says what the sound
 * was. So every interruption is a guess at the moment it is acted on, and these are the
 * two ways the guess is settled: the caller said something, or they did not.
 *
 * The failure this replaces was silent. `BACKCHANNEL` was consulted as
 * `turn !== null && BACKCHANNEL.has(flat)`, and `stopSpeaking` nulls the turn before the
 * transcript arrives — so with barge-in on, saying "mm-hmm" cut the agent off and then got
 * answered as though it were a question.
 */
/** `DEFAULT_BARGE_IN_GUARD_MS` in the orchestrator. Anything sooner is treated as echo. */
const DEFAULT_GUARD_MS = 400;

describe("an interruption that was not one", () => {
  /**
   * The agent mid-reply, with the first sentence heard and the second not.
   *
   * `ackAll()` is deliberately not used after the reply starts: it would mark every
   * sentence as played, leaving nothing unheard to resume and closing the turn, so the
   * barge-in under test would never fire.
   */
  const speaking = async () => {
    const h = setup();
    h.tts.last().done();
    h.stream.ackAll();

    /* Marks accumulate across the whole call, and the greeting already placed one. Acking
       `marks[0]` acks the greeting — whose sequence number does not match this turn, so
       `onMark` drops it and the reply reads as entirely unheard. Two of these tests passed
       vacuously that way. */
    const beforeReply = h.stream.marks.length;
    h.listen.final("Tell me about my policy.");
    h.llm.last().emit("It renews in May. Your premium is unchanged. ");
    const first = h.tts.last();
    first.audio(800);
    first.done();
    // Only the first sentence reached the caller. The second is still synthesising.
    const played = h.stream.marks[beforeReply];
    if (played !== undefined) h.stream.ackMark(played);
    /* Past the barge-in guard before the caller speaks. Inside it, a speech-start is
       judged to be our own audio returning through the handset and is ignored — which is
       correct, and meant the first version of these tests exercised nothing. */
    await new Promise((r) => setTimeout(r, DEFAULT_GUARD_MS + 60));
    return h;
  };

  it("says the rest when the caller only said mhm", async () => {
    const h = await speaking();
    const before = h.tts.texts().length;

    h.listen.speechStart(9000);
    h.listen.final("mhm", 9000);

    // The remainder is spoken again, because Twilio's clear discarded it at the carrier
    // and there is no pause to release.
    expect(h.tts.texts().length).toBeGreaterThan(before);
    expect(h.tts.texts().at(-1)).not.toBe("");
    assertInvariants(h);
  });

  it("does not answer the backchannel", async () => {
    const h = await speaking();
    const before = h.llm.completions.length;

    h.listen.speechStart(9000);
    h.listen.final("mhm", 9000);

    // The whole defect: a backchannel used to reach the model and burn a turn replying
    // to a noise that meant "go on".
    expect(h.llm.completions).toHaveLength(before);
    assertInvariants(h);
  });

  it("says the rest when nothing was said at all", async () => {
    // A cough, a door, a carrier click. Without this the agent stops mid-sentence and
    // waits for a caller who is not going to speak.
    const h = await speaking();
    const before = h.tts.texts().length;

    h.listen.speechStart(9000);
    await new Promise((r) => setTimeout(r, 1200));

    expect(h.tts.texts().length).toBeGreaterThan(before);
    assertInvariants(h);
  });

  it("does not resume over a caller who is still talking", async () => {
    /* The sharpest failure in this design, and it is not hypothetical: a *final*
       transcript only arrives at end-of-turn, so a caller who cuts in and then speaks for
       three seconds produces nothing to decide on until they stop. Counting down to
       "nobody said anything" through that would have the agent resume over them at one
       second — the exact defect this phase exists to remove. An interim proves somebody is
       there. */
    const h = await speaking();
    h.listen.speechStart(9000);
    const after = h.tts.texts().length;

    h.listen.interim("I actually wanted to ask about", 9100);
    await new Promise((r) => setTimeout(r, 1400));

    expect(h.tts.texts()).toHaveLength(after);
    assertInvariants(h);
  });

  it("stays stopped when the caller actually said something", async () => {
    const h = await speaking();

    h.listen.speechStart(9000);
    const after = h.tts.texts().length;
    h.listen.final("actually, cancel it", 9000);
    await new Promise((r) => setTimeout(r, 1200));

    /* Counted, not searched: `texts()` records synthesis requests, and the second
       sentence was already requested before the caller cut in. What must not happen is a
       *new* request after the interruption — that would talk over the answer. */
    expect(h.tts.texts()).toHaveLength(after);
    assertInvariants(h);
  });
});

describe("what the model is told it said", () => {
  const cutOffMidSentence = async () => {
    const h = setup();
    h.tts.last().done();
    h.stream.ackAll();

    const beforeReply = h.stream.marks.length;
    h.listen.final("Tell me about my policy.");
    h.llm.last().emit("It renews in May. Your premium is unchanged. ");
    const first = h.tts.last();
    first.audio(800);
    first.done();
    const played = h.stream.marks[beforeReply];
    if (played !== undefined) h.stream.ackMark(played);
    await new Promise((r) => setTimeout(r, DEFAULT_GUARD_MS + 60));

    h.listen.speechStart(9000);
    h.listen.final("actually, cancel it", 9000);
    return h;
  };

  it("marks a cut-off turn with a dash", async () => {
    // Without it the model reads its last line as a sentence it chose to end, and carries
    // on as though the caller had not spoken over it.
    const h = await cutOffMidSentence();
    await new Promise((r) => setTimeout(r, 20));
    const said = h.llm.lastMessages().filter((m) => m.role === "assistant");
    expect(said.at(-1)?.content).toMatch(/—$/);
    assertInvariants(h);
  });

  it("records only what the caller actually heard", async () => {
    const h = await cutOffMidSentence();
    await new Promise((r) => setTimeout(r, 20));
    const said = h.llm.lastMessages().filter((m) => m.role === "assistant");
    // The first sentence played, so it is in the history; the second was queued and never
    // reached the caller, so as far as the conversation goes it was never said.
    expect(said.at(-1)?.content).toContain("It renews in May");
    expect(said.at(-1)?.content).not.toContain("Your premium is unchanged");
    assertInvariants(h);
  });

  it("removes the turn entirely when nothing was heard", async () => {
    const h = setup();
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Tell me about my policy.");
    h.llm.last().emit("It renews in May. ");
    // No audio acknowledged: the carrier never played a byte of it.
    h.listen.speechStart(9000);
    h.listen.final("actually, cancel it", 9000);

    await new Promise((r) => setTimeout(r, 20));
    const said = h.llm.lastMessages().filter((m) => m.role === "assistant");
    expect(said.map((m) => m.content).join(" ")).not.toContain("It renews in May");
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

/**
 * The pace an operator chose, on the audio a caller actually hears.
 *
 * This was stored, versioned, diffed and shown in the console for weeks without reaching a
 * single call: `OrchestratorDeps.speakingRate` was optional and the gateway never passed it,
 * so every synthesis went out at the voice's default and nothing anywhere failed. The field
 * is required now, which makes that omission a compile error rather than a silence — and
 * these pin the behaviour the type can only half express.
 */
describe("the speaking rate an agent was configured with", () => {
  it("is on the greeting, which is the first thing the caller hears", () => {
    const h = setup({ speakingRate: 0.85 });

    expect(h.tts.last().request.speakingRate).toBe(0.85);
    assertInvariants(h);
  });

  it("is on every reply, not only the greeting", () => {
    const h = setup({ speakingRate: 0.85 });
    h.tts.last().done();
    h.stream.ackAll();

    h.listen.final("Tell me about my policy.");
    h.llm.last().emit("It renews in May. ");

    // A caller who heard a slow greeting and then a normal-speed answer would hear two
    // different people, which is worse than either pace on its own.
    expect(h.tts.syntheses.map((synthesis) => synthesis.request.speakingRate)).toEqual([
      0.85, 0.85,
    ]);
    assertInvariants(h);
  });

  it("is absent when nobody chose one, rather than pinned to 1.0", () => {
    // The default for every agent. A cloned voice keeps its speaker's own pace, and 1.0
    // would flatten it — the adapter branches on undefined to omit the field entirely.
    const h = setup();

    expect(h.tts.last().request.speakingRate).toBeUndefined();
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
      speakingRate: undefined,
      log: silentLog,
      greeting: GREETING,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      direction: "inbound",
      businessHours: null,
      callerHistory: () => null,
      recordDoNotCall: () => undefined,
      organizationId: ORGANIZATION,
      forSpeech: (t) => t,
      minSpeechMs: 0,
      initialAudio: early,
    });

    // Outbound loads its organization on the socket; frames arriving in that window used to be
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
      speakingRate: undefined,
      log: silentLog,
      greeting: GREETING,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      direction: "inbound",
      businessHours: null,
      callerHistory: () => null,
      recordDoNotCall: () => undefined,
      organizationId: ORGANIZATION,
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
    const latencies: { stage: string; ms: number; provider: string | null }[] = [];
    return {
      turns,
      latencies,
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
        latency: (l: { stage: string; ms: number; provider: string | null }) => latencies.push(l),
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

  /**
   * The stage timings are recorded twice, and this is the half that was inventory for two
   * slices: `latencies` existed from migration 0001 and nothing ever wrote to it. What
   * makes the range endpoint work is not the table or the query — it is that a real turn
   * reaches `record.latency` at all.
   */
  it("files each stage of a turn as a timing, not only as an event", () => {
    const r = recording();
    const h = setup({ recorder: r.recorder as unknown as CallRecorder });

    // The greeting out of the way, then one complete turn through the whole pipeline.
    h.tts.last().done();
    h.stream.ackAll();

    /* End-of-turn first, then the transcript. That is the real order on a Flux call and it
       is load-bearing here: `stt_final` and `turn_to_audio` are marked when the caller
       stops, and measured when the words and the audio arrive. */
    h.listen.endOfTurn(3_000);
    h.listen.final("What are your opening hours?", 3_000);
    h.llm.last().emit("We open at nine. ");
    h.llm.last().finish();
    h.tts.last().audio(800);
    h.tts.last().done();
    h.stream.ackAll();

    const stages = r.latencies.map((l) => l.stage);
    expect(stages).toContain("stt_final");
    expect(stages).toContain("llm_first_token");
    expect(stages).toContain("tts_first_byte");
    expect(stages).toContain("turn_to_audio");
    // A duration, not a timestamp. The endpoint takes percentiles of these directly.
    expect(r.latencies.every((l) => Number.isFinite(l.ms) && l.ms >= 0)).toBe(true);

    /* The vendor is stamped on the stages one vendor owns, which is what makes a
       side-by-side of two TTS providers readable rather than one blended number. */
    const byStage = new Map(r.latencies.map((l) => [l.stage, l.provider]));
    expect(byStage.get("tts_first_byte")).toBe("fake-tts");
    expect(byStage.get("llm_first_token")).toBe("fake-llm");
    // End to end, owned by no single vendor.
    expect(byStage.get("turn_to_audio")).toBeNull();
    assertInvariants(h);
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
  it("offers nothing at all on a call with no organization", () => {
    const tools = toolHarness([READ_TOOL]);
    const h = setup({ organizationId: null, makeTools: tools.makeTools });
    started(h);

    h.listen.final("When do you open?");

    expect(h.llm.last().request.tools).toBeUndefined();
  });

  it("never builds a dispatcher on a call with no organization", () => {
    let built = 0;
    setup({
      organizationId: null,
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

  it("lets the agent report what a tool just did, and not what it did last time", async () => {
    /**
     * Both halves of the output guard's only hard rule, in one call.
     *
     * A tool ran, so the claim on that exchange is backed and must be spoken — without this
     * the guard would be unusable, because reporting what it just did is most of what a
     * tool is for. Then the caller says something new, nothing runs, and the same words are
     * no longer supported. The clearing between the two is what the second half proves, and
     * an earlier version of this test could not see it: with no tool ever running, the flag
     * was already false and removing the reset changed nothing.
     */
    const tools = toolHarness([READ_TOOL]);
    const h = setup({ makeTools: tools.makeTools });
    started(h);

    h.listen.final("When do you open?");
    h.llm.last().callTools([{ name: "opening_times", args: {} }]);
    await settle();
    h.llm.last().emit("I've booked that in for you.");
    h.llm.last().finish();
    expect(h.tts.texts().join(" ")).toContain("I've booked that in");

    // A new thing said by the caller. Nothing has been done for them in this exchange.
    h.listen.final("And can you cancel the other one?");
    h.llm.last().emit("I've cancelled the other one.");
    h.llm.last().finish();

    const spoken = h.tts.texts().join(" ");
    expect(spoken).not.toContain("I've cancelled");
    expect(spoken).toContain("someone to confirm that");
  });

  it("stops offering tools once the call needs a person", async () => {
    /**
     * The policy layer, on a real turn. Two enforcement points and both matter: the filter
     * stops the model asking, and the dispatch refusal is what makes the answer no when it
     * asks anyway — a name it was never offered would otherwise resolve perfectly happily,
     * because the registry has no idea the conversation is coming apart.
     */
    const tools = toolHarness([READ_TOOL]);
    const h = setup({ makeTools: tools.makeTools });
    started(h);

    // Two turns that went nowhere: the turn before the hard rule transfers.
    h.listen.final("Hello?");
    h.llm.last().fail("upstream fell over");
    h.listen.final("Are you there?");
    h.llm.last().fail("upstream fell over again");
    h.listen.final("When do you open?");

    // Not offered.
    const offered = (h.llm.last().request.tools ?? []).map((t) => t.name);
    expect(offered).not.toContain("opening_times");

    // And refused if asked for anyway.
    h.llm.last().callTools([{ name: "opening_times", args: {} }]);
    await settle();
    expect(tools.events).not.toContain("ran:opening_times");
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
      registerInternalTools(
        registry,
        callControlTools({ endCall: hooks.endCall, recordAnswer: hooks.recordAnswer, businessHours }),
      );
      return {
        registry,
        dispatcher: createToolDispatcher({ registry, log: silentLog, holding: hooks.holding }),
      };
    };

  const started = (h: ReturnType<typeof setup>) => {
    h.tts.last().done();
    h.stream.ackAll();
  };

  it("offers exactly the five non-data tools", () => {
    const h = setup({ makeTools: platform() });
    started(h);
    h.listen.final("Hello.");

    expect(h.llm.last().request.tools?.map((t) => t.name).sort()).toEqual([
      "business_hours",
      "end_call",
      // The model's answer to a choice question, into the director. No data behind it.
      "record_answer",
      "transfer_to_human",
      // Distinct from transfer_to_human on purpose: it goes to a line that answers outside
      // business hours, and only the model can recognise the call that needs it.
      "transfer_urgently",
    ]);
  });

  /**
   * The end of a graph is the end of the call — in code, on the mark, not as a suggestion.
   */
  describe("a graph that reaches its end", () => {
    const oneQuestionThenEnd = (terminal: "hangup" | "transfer"): OrchestratorDeps["flow"] => ({
      version: 1,
      nodes: [
        { id: "start", kind: "start", x: 0, y: 0 },
        { id: "ask-name", kind: "collect", x: 1, y: 0, field: { key: "callerName", type: "name", prompt: "Who am I speaking with?", capture: "speech", confirm: "readback", required: true, pattern: "", attempts: 3, options: [] } },
        { id: "end", kind: terminal, x: 2, y: 0 },
      ],
      edges: [
        { from: "start", to: "ask-name" },
        { from: "ask-name", to: "end" },
      ],
    });

    const answerTheOnlyQuestion = (h: ReturnType<typeof setup>): void => {
      started(h);
      h.listen.final("Sikiru");
      // The readback: the engine speaks it, the caller agrees.
      h.tts.last().done();
      h.stream.ackAll();
      h.listen.final("Yes, that is right.");
    };

    it("hangs up after the goodbye has been heard, and not before", () => {
      const h = setup({ flow: oneQuestionThenEnd("hangup"), makeTools: platform() });
      answerTheOnlyQuestion(h);

      // The turn after the last answer is steered to wrap up, and it is that turn's audio
      // the hangup waits for. Nothing has ended yet: the goodbye is still being written.
      expect(h.stream.hungUp).toBe(false);
      expect(h.llm.last().request.system).toContain("say goodbye");
      h.llm.last().emit("Thank you Sikiru, that is everything. Goodbye. ");
      h.llm.last().finish();
      h.tts.last().audio(1600);
      h.tts.last().done();
      // Synthesised and queued at the carrier, not yet heard.
      expect(h.stream.hungUp).toBe(false);

      h.stream.ackAll();
      expect(h.stream.hungUp).toBe(true);
    });

    it("does not hang up on a caller who starts talking again", () => {
      const h = setup({ flow: oneQuestionThenEnd("hangup"), makeTools: platform() });
      answerTheOnlyQuestion(h);
      h.llm.last().emit("Thank you, goodbye. ");
      h.llm.last().finish();

      h.listen.final("Sorry, one more thing.");
      h.llm.last().emit("Of course. ");
      h.llm.last().finish();
      h.tts.last().audio(1600);
      h.tts.last().done();
      h.stream.ackAll();

      expect(h.stream.hungUp).toBe(false);
    });

    it("hands the call to a person through the handoff module when the graph ends in a transfer", () => {
      const spy = spyHandoff();
      const h = setup({ flow: oneQuestionThenEnd("transfer"), makeTools: platform(), makeHandoff: spy.make });
      const before = h.llm.completions.length;
      answerTheOnlyQuestion(h);

      expect(spy.triggers.map((t) => t.kind)).toEqual(["needs-a-person"]);
      expect(h.stream.hungUp).toBe(false);
      /* The handoff speaks the departure line. A model turn started here would talk over
         it — the same reason the model's own transfer_to_human never goes back to the model. */
      expect(h.llm.completions.length).toBe(before);
    });

    it("still lets the model speak when the graph ends in a transfer and nothing is configured to take it", () => {
      const h = setup({ flow: oneQuestionThenEnd("transfer"), makeTools: platform() });
      const before = h.llm.completions.length;
      answerTheOnlyQuestion(h);

      // No handoff, so the steering is all there is: the model is asked to speak, and told.
      expect(h.llm.completions.length).toBe(before + 1);
      expect(h.llm.last().request.system).toContain("transfer_to_human");
    });

    it("does not treat a graph that asks nothing as an instruction to greet and hang up", () => {
      const h = setup({ flow: { version: 1, nodes: [{ id: "start", kind: "start", x: 0, y: 0 }, { id: "end", kind: "hangup", x: 1, y: 0 }], edges: [{ from: "start", to: "end" }] }, makeTools: platform() });
      started(h);
      h.listen.final("Hello?");
      h.llm.last().emit("Hello, how can I help? ");
      h.llm.last().finish();
      h.tts.last().audio(800);
      h.tts.last().done();
      h.stream.ackAll();

      expect(h.stream.hungUp).toBe(false);
    });
  });

  describe("what a graph tells the model on the way to a question", () => {
    const withASayAndATool: OrchestratorDeps["flow"] = {
      version: 1,
      nodes: [
        { id: "start", kind: "start", x: 0, y: 0 },
        { id: "promo", kind: "say", x: 1, y: 0, text: "Mention the weekend promotion" },
        { id: "look", kind: "tool", x: 2, y: 0, tool: "business_hours" },
        { id: "ask-name", kind: "collect", x: 3, y: 0, field: { key: "callerName", type: "name", prompt: "Who am I speaking with?", capture: "speech", confirm: "readback", required: true, pattern: "", attempts: 3, options: [] } },
        { id: "end", kind: "hangup", x: 4, y: 0 },
      ],
      edges: [
        { from: "start", to: "promo" },
        { from: "promo", to: "look" },
        { from: "look", to: "ask-name" },
        { from: "ask-name", to: "end" },
      ],
    };

    it("names a say step once, and a tool step until it has run", async () => {
      const h = setup({ flow: withASayAndATool, makeTools: platform() });
      started(h);

      h.listen.final("I saw your listing and wanted to ask about it.");
      const first = h.llm.last().request.system;
      expect(first).toContain("Mention the weekend promotion");
      expect(first).toContain("business_hours tool now");
      h.llm.last().emit("Hi there, and there's a promotion on this weekend by the way. ");
      h.llm.last().finish();
      // Synthesised, sent and heard: the turn played out in full.
      h.tts.last().audio(1600);
      h.tts.last().done();
      h.stream.ackAll();

      /* The caller has not answered the question yet, so the director still lists both. The
         promotion was covered on a turn the caller heard to the end; a tool it never used is
         still owed. */
      h.listen.final("Sorry, what promotion is that exactly?");
      const second = h.llm.last().request.system;
      expect(second).not.toContain("Mention the weekend promotion");
      expect(second).toContain("business_hours tool now");

      h.llm.last().callTools([{ name: "business_hours", args: {} }]);
      await settle();
      h.llm.last().emit("We are open. ");
      h.llm.last().finish();
      h.tts.last().done();
      h.stream.ackAll();

      h.listen.final("That is useful to know, thank you.");
      expect(h.llm.last().request.system).not.toContain("business_hours tool now");
      expect(h.llm.last().request.system).toContain("Who am I speaking with?");
    });

    it("steers a say step again if the caller cut the turn off before it was heard", () => {
      const h = setup({ flow: withASayAndATool, makeTools: platform() });
      started(h);

      h.listen.final("I saw your listing and wanted to ask about it.");
      expect(h.llm.last().request.system).toContain("Mention the weekend promotion");
      h.llm.last().emit("Sure. Before I forget, there is a ");
      // Talked over before the sentence finished, let alone the promotion.
      h.listen.speechStart(400);
      h.listen.final("Actually, is the flat still available?");

      expect(h.llm.last().request.system).toContain("Mention the weekend promotion");
    });
  });

  /**
   * The rent-or-buy call, end to end: the graph waits at a choice, the model is told the
   * options and the tool, records the answer, and the walk takes the branch. Every earlier
   * version of this feature had the model asking the question and the answer going nowhere,
   * so every caller was routed down "anything else".
   */
  describe("a graph that branches on a choice", () => {
    const rentOrBuy: OrchestratorDeps["flow"] = {
      version: 1,
      nodes: [
        { id: "start", kind: "start", x: 0, y: 0 },
        {
          id: "ask-intent",
          kind: "collect",
          x: 1,
          y: 0,
          field: { key: "intent", type: "choice", prompt: "Are you looking to rent or to buy?", capture: "speech", confirm: "none", pattern: "", attempts: 3, required: true, options: ["rent", "buy"] },
        },
        { id: "d", kind: "decide", x: 2, y: 0, on: "intent" },
        { id: "ask-budget", kind: "collect", x: 3, y: 0, field: { key: "budget", type: "amount", prompt: "What is your monthly budget?", capture: "speech", confirm: "none", pattern: "", attempts: 3, required: true, options: [] } },
        { id: "ask-deposit", kind: "collect", x: 3, y: 9, field: { key: "deposit", type: "amount", prompt: "How much have you set aside for a deposit?", capture: "speech", confirm: "none", pattern: "", attempts: 3, required: true, options: [] } },
        { id: "end", kind: "hangup", x: 4, y: 0 },
      ],
      edges: [
        { from: "start", to: "ask-intent" },
        { from: "ask-intent", to: "d" },
        { from: "d", to: "ask-budget", when: { equals: "rent" } },
        { from: "d", to: "ask-deposit", otherwise: true },
        { from: "ask-budget", to: "end" },
        { from: "ask-deposit", to: "end" },
      ],
    };

    it("tells the model the options and the tool, then takes the branch the model recorded", async () => {
      const captured: { fieldKey: string; value: string }[] = [];
      const h = setup({
        flow: rentOrBuy,
        makeTools: platform(),
        recorder: {
          started: () => undefined, event: () => undefined, transcript: () => undefined,
          turn: () => undefined, latency: () => undefined,
          capture: (c: { fieldKey: string; value: string }) => captured.push({ fieldKey: c.fieldKey, value: c.value }),
          ended: () => undefined,
        } as unknown as CallRecorder,
      });
      started(h);
      h.listen.final("Hello, I saw your listing.");

      // Turn one: the graph is waiting at the choice, and the model is told so.
      const steering = h.llm.last().request.system;
      expect(steering).toContain("Where this call is");
      expect(steering).toContain('"Are you looking to rent or to buy?"');
      expect(steering).toContain('"rent", "buy"');
      expect(steering).toContain("record_answer");
      expect(h.llm.last().request.tools?.map((t) => t.name)).toContain("record_answer");

      h.llm.last().emit("Are you looking to rent or to buy? ");
      h.llm.last().finish();
      h.tts.last().done();
      h.stream.ackAll();

      h.listen.final("To rent, I think.");
      h.llm.last().callTools([{ name: "record_answer", args: { field: "intent", answer: "Rent" } }]);
      await settle();

      // Recorded as the operator wrote the option, not as the model spelt it.
      expect(captured).toEqual([{ fieldKey: "intent", value: "rent" }]);
      h.llm.last().emit("Great. ");
      h.llm.last().finish();
      h.tts.last().done();
      h.stream.ackAll();

      // The next turn is steered down the rent arm and nowhere near the deposit question.
      h.listen.final("Okay.");
      const next = h.llm.last().request.system;
      expect(next).toContain("What is your monthly budget?");
      expect(next).not.toContain("deposit");
    });

    it("refuses an answer that is not one of the options and names them, so the model can ask again", async () => {
      const captured: unknown[] = [];
      const h = setup({
        flow: rentOrBuy,
        makeTools: platform(),
        recorder: {
          started: () => undefined, event: () => undefined, transcript: () => undefined,
          turn: () => undefined, latency: () => undefined,
          capture: (c: unknown) => captured.push(c), ended: () => undefined,
        } as unknown as CallRecorder,
      });
      started(h);
      h.listen.final("I'd like to lease.");
      h.llm.last().callTools([{ name: "record_answer", args: { field: "intent", answer: "lease" } }]);
      await settle();

      expect(captured).toEqual([]);
      const told = h.llm.last().request.messages.map((m) => m.content).join("\n");
      expect(told).toContain('"rent", "buy"');
    });

    it("refuses to record a value the engine owns, so a model-supplied number cannot skip its readback", async () => {
      const captured: unknown[] = [];
      const h = setup({
        flow: rentOrBuy,
        makeTools: platform(),
        recorder: {
          started: () => undefined, event: () => undefined, transcript: () => undefined,
          turn: () => undefined, latency: () => undefined,
          capture: (c: unknown) => captured.push(c), ended: () => undefined,
        } as unknown as CallRecorder,
      });
      started(h);
      h.listen.final("My budget is two hundred thousand.");
      h.llm.last().callTools([{ name: "record_answer", args: { field: "budget", answer: "200000" } }]);
      await settle();

      expect(captured).toEqual([]);
    });
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

  it("answers the opening hours from organization configuration", async () => {
    const h = setup({
      makeTools: platform({ opensAtHour: 9, closesAtHour: 17, openDays: [1, 2, 3, 4, 5] }),
    });
    started(h);
    h.listen.final("Are you open?");

    h.llm.last().callTools([{ name: "business_hours", args: {} }]);
    await settle();

    const note = h.llm.lastMessages().at(-1)?.content ?? "";
    /* Fenced, because a result carries words we did not write. This one came from a
       platform tool and is ours, but the fence does not know that and must not: the model
       has to see one boundary in one place, or the marker means nothing when a organization's
       endpoint is on the other side of it. */
    expect(note).toContain("business_hours returned the following");
    expect(note).toContain("<<<tool-result");
    expect(note).toMatch(/open now|closed at the moment/);
  });

  it("says it does not know when the organization has configured no hours", async () => {
    const h = setup({ makeTools: platform(null) });
    started(h);
    h.listen.final("Are you open?");

    h.llm.last().callTools([{ name: "business_hours", args: {} }]);
    await settle();

    expect(h.llm.lastMessages().at(-1)?.content).toContain("do not have the opening hours");
  });
});
