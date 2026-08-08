import { Buffer } from "node:buffer";

import type { CallRecord, MetricEvent, RecordedTranscript, RecordedTurn } from "@ansa/db";
import type { AudioChunk } from "@ansa/shared";

import { chunkOf, fakeListen, fakeLlm, fakeStream, fakeTts, silentLog } from "../orchestrator/fakes";
import type { CallRecorder } from "../telephony/event-log";
import { runConversation } from "../orchestrator/orchestrator";

/**
 * A replayable conversation, driven through the orchestrator's own fakes.
 *
 * The scenarios in `conversation.test.ts` are the review loop made mechanical: a failure
 * heard on a call becomes a scenario here, and from then on it is a number rather than an
 * anecdote. They drive the same code a phone call drives — transcripts in, audio out —
 * with the network removed, so the sequence of events is exact rather than approximate.
 *
 * What this adds over the orchestrator's own tests is the **event log**. Each scenario
 * captures what the recorder was told and scores it with the same `scoreCalls` the viewer
 * uses, so "did that change make things better" has an answer that does not depend on
 * whoever listened to the call.
 *
 * What it is not: proof. Fakes cannot mishear a Nigerian accent on an 8kHz line. These
 * scenarios prove the conversation logic behaves; only a phone call proves the product
 * works, and CLAUDE.md is right to insist on the distinction.
 */

const GREETING = "Thank you for calling Ansa. How can I help you?";

/** One rendered phrase per tier, so a scenario can exercise the thinking gap. */
export const fillerSetup = (): {
  fillers: ReadonlyMap<string, readonly AudioChunk[]>;
  fillerTiers: readonly (readonly string[])[];
} => ({
  fillers: new Map([
    ["Mm-hm.", [chunkOf(4800)]],
    ["Let me check that.", [chunkOf(9600)]],
  ]) as ReadonlyMap<string, readonly AudioChunk[]>,
  fillerTiers: [["Mm-hm."], ["Let me check that."]] as readonly (readonly string[])[],
});

interface RecordedEvent {
  readonly kind: string;
  readonly detail: Record<string, unknown>;
}

/** Everything the call told the recorder, which is everything a metric can be built from. */
export interface CallLog {
  readonly events: RecordedEvent[];
  readonly turns: RecordedTurn[];
  readonly transcripts: RecordedTranscript[];
  readonly recorder: CallRecorder;
}

const recordingRecorder = (): CallLog => {
  const events: RecordedEvent[] = [];
  const turns: RecordedTurn[] = [];
  const transcripts: RecordedTranscript[] = [];
  return {
    events,
    turns,
    transcripts,
    recorder: {
      started: () => undefined,
      event: (kind, detail) => events.push({ kind, detail: { ...(detail ?? {}) } }),
      transcript: (t) => transcripts.push(t),
      turn: (t) => turns.push(t),
      ended: () => undefined,
    },
  };
};

export interface ScenarioOptions {
  readonly bargeInGuardMs?: number;
  readonly greetingAudio?: readonly AudioChunk[] | null;
  readonly fillers?: ReadonlyMap<string, readonly AudioChunk[]>;
  readonly fillerTiers?: readonly (readonly string[])[];
  readonly fillerAfterMs?: number;
  readonly transcriptWatchdogMs?: number;
  readonly minSpeechMs?: number;
}

export interface Scenario {
  readonly stream: ReturnType<typeof fakeStream>;
  readonly listen: ReturnType<typeof fakeListen>;
  readonly llm: ReturnType<typeof fakeLlm>;
  readonly tts: ReturnType<typeof fakeTts>;
  readonly log: CallLog;
  /** Everything handed to TTS this call, greeting first. */
  spoken(): readonly string[];
  /** The last thing the caller would have heard, whole. */
  lastSpoken(): string;
  /** Everything spoken, joined — for asking "did it ever say X". */
  allSpoken(): string;
  /** The greeting plays out and the caller hears all of it. */
  greetingPlays(): void;
  /** The caller says something. */
  says(text: string, offsetMs?: number): void;
  /** The caller makes a real sound for `ms` before speaking, so the speech gate opens. */
  speaksAloudFor(ms: number): void;
  /** Silence on the line: enough of it that any transcript arriving is invented. */
  silenceFor(ms: number): void;
  /** The model answers, in full, and the caller hears every word of it. */
  agentAnswers(reply: string): void;
  /** Drains whatever is queued at TTS and acknowledges it, as a carrier would. */
  playsOut(): void;
  /** Event kinds in the order they were recorded. */
  kinds(): readonly string[];
  /** Every recorded event of one kind. */
  eventsOf(kind: string): readonly RecordedEvent[];
  /** The call as the metrics see it. */
  asRecord(): CallRecord;
}

export const scenario = (options: ScenarioOptions = {}): Scenario => {
  const stream = fakeStream();
  const listen = fakeListen();
  const llm = fakeLlm();
  const tts = fakeTts();
  const log = recordingRecorder();

  runConversation(stream.stream, {
    listen: listen.session,
    llm: llm.provider,
    tts: tts.provider,
    voiceId: "voice-ng",
    log: silentLog,
    greeting: GREETING,
    // The real normaliser is @ansa/normalizer's forSpeech; the scenarios care about the
    // conversation, so this is the identity plus the one respelling that changes what a
    // transcriber would hear back.
    forSpeech: (t) => t.replace(/\bAnsa\b/g, "An-Sah"),
    // Transcripts are driven directly, so nothing fans audio in and the no-speech filter
    // would discard every one of them. The scenarios that care about it set it.
    minSpeechMs: 0,
    recorder: log.recorder,
    listenProvider: "fake",
    ...options,
  });

  /** A loud frame: alternating extremes, which is what the speech gate measures. */
  const loudFrame = (): Buffer =>
    Buffer.from(Array.from({ length: 160 }, (_u, j) => (j % 2 === 0 ? 0x00 : 0x80)));

  const playsOut = (): void => {
    // Sentences synthesise one at a time, so the queue only advances as each finishes.
    for (let i = 0; i < 20; i += 1) {
      const live = tts.live()[0];
      if (live === undefined) break;
      live.audio(1600);
      live.done();
    }
    stream.ackAll();
  };

  return {
    stream,
    listen,
    llm,
    tts,
    log,
    spoken: () => tts.texts(),
    lastSpoken: () => tts.texts().at(-1) ?? "",
    allSpoken: () => tts.texts().join(" "),
    greetingPlays: () => {
      playsOut();
    },
    says: (text, offsetMs) => {
      listen.final(text, offsetMs);
    },
    speaksAloudFor: (ms) => {
      for (let i = 0; i < Math.ceil(ms / 20); i += 1) {
        stream.audioIn({ data: loudFrame(), offsetMs: i * 20 });
      }
    },
    silenceFor: (ms) => {
      for (let i = 0; i < Math.ceil(ms / 20); i += 1) {
        stream.audioIn({ data: Buffer.alloc(160, 0xff), offsetMs: i * 20 });
      }
    },
    agentAnswers: (reply) => {
      const completion = llm.last();
      for (const sentence of reply.split(/(?<=[.!?])\s+/)) completion.emit(`${sentence} `);
      completion.finish();
      playsOut();
    },
    playsOut,
    kinds: () => log.events.map((e) => e.kind),
    eventsOf: (kind) => log.events.filter((e) => e.kind === kind),
    asRecord: () => ({
      callId: "scenario",
      endReason: "carrier sent stop",
      durationSeconds: 30,
      callerTurns: log.turns.filter((t) => t.speaker === "caller").length,
      agentTurns: log.turns.filter((t) => t.speaker === "agent").length,
      events: log.events.map((e): MetricEvent => ({ kind: e.kind, detail: e.detail })),
      reviewed: [],
    }),
  };
};
