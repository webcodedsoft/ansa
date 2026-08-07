import { Buffer } from "node:buffer";

import type { CompletionRequest, CompletionStream, LlmProvider, Message } from "@ansa/llm";
import type { OpenAiListenSession } from "@ansa/openai-listen";
import { TELEPHONY_AUDIO, asCallId, type AudioChunk, type Logger } from "@ansa/shared";
import type { CallMediaStream } from "@ansa/telephony";
import type { SynthesisRequest, SynthesisStream, TtsProvider } from "@ansa/tts";

/**
 * Test doubles for the orchestrator's four collaborators.
 *
 * The orchestrator is the most intricate code in the repo and every one of its bugs so
 * far has been a sequencing bug — an event arriving when another was in flight. These
 * fakes exist to make those sequences expressible: nothing here is asynchronous unless
 * the test asks for it, so a test can place events in an exact order.
 */

export const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
};

export const chunkOf = (bytes: number): AudioChunk => ({
  data: Buffer.alloc(bytes, 0x7f),
  offsetMs: 0,
});

export interface FakeStream {
  readonly stream: CallMediaStream;
  readonly sent: AudioChunk[];
  readonly marks: string[];
  clears: number;
  hungUp: boolean;
  bytesSent(): number;
  /** The carrier echoing a mark back once playback reaches it. */
  ackMark(name: string): void;
  /** Acknowledge every mark placed so far, i.e. the caller heard everything. */
  ackAll(): void;
  audioIn(chunk: AudioChunk): void;
  closeCall(reason: string): void;
}

export const fakeStream = (): FakeStream => {
  const sent: AudioChunk[] = [];
  const marks: string[] = [];
  const audioListeners: ((c: AudioChunk) => void)[] = [];
  const markListeners: ((n: string) => void)[] = [];
  const closedListeners: ((r: string) => void)[] = [];
  const self = {
    sent,
    marks,
    clears: 0,
    hungUp: false,
    bytesSent: () => sent.reduce((n, c) => n + c.data.length, 0),
    ackMark: (name: string) => markListeners.forEach((l) => l(name)),
    ackAll: () => marks.forEach((m) => markListeners.forEach((l) => l(m))),
    audioIn: (chunk: AudioChunk) => audioListeners.forEach((l) => l(chunk)),
    closeCall: (reason: string) => closedListeners.forEach((l) => l(reason)),
    stream: {
      callId: asCallId("CA-test"),
      format: TELEPHONY_AUDIO,
      onAudio: (l: (c: AudioChunk) => void) => audioListeners.push(l),
      send: (c: AudioChunk) => sent.push(c),
      mark: (n: string) => marks.push(n),
      onMark: (l: (n: string) => void) => markListeners.push(l),
      clear: () => {
        self.clears += 1;
      },
      onClosed: (l: (r: string) => void) => closedListeners.push(l),
      hangUp: () => {
        self.hungUp = true;
      },
    } satisfies CallMediaStream,
  };
  return self;
};

export interface FakeListen {
  readonly session: OpenAiListenSession;
  readonly written: AudioChunk[];
  closed: boolean;
  /**
   * Turn events and transcripts are driven independently, on purpose. R4.1.7 says the
   * orchestrator must never assume they arrive on one connection; making them separate
   * drivers here enforces that structurally instead of asserting it.
   */
  speechStart(offsetMs: number): void;
  endOfTurn(offsetMs: number): void;
  final(text: string, offsetMs?: number): void;
  interim(text: string, offsetMs?: number): void;
  /** The connection died. The agent is now deaf. */
  failWith(reason: string): void;
  /** A recoverable vendor complaint. Must not end the call. */
  vendorError(message: string): void;
}

export const fakeListen = (): FakeListen => {
  const written: AudioChunk[] = [];
  const interimL: ((t: { text: string; words: []; confidence: null; offsetMs: number }) => void)[] = [];
  const finalL: typeof interimL = [];
  const startL: ((e: { offsetMs: number }) => void)[] = [];
  const eotL: typeof startL = [];
  const eagerL: typeof startL = [];
  const resumedL: typeof startL = [];
  const failureL: ((reason: string) => void)[] = [];
  const vendorErrorL: ((message: string) => void)[] = [];

  const self: FakeListen = {
    written,
    closed: false,
    speechStart: (offsetMs) => startL.forEach((l) => l({ offsetMs })),
    endOfTurn: (offsetMs) => eotL.forEach((l) => l({ offsetMs })),
    final: (text, offsetMs = 0) =>
      finalL.forEach((l) => l({ text, words: [], confidence: null, offsetMs })),
    interim: (text, offsetMs = 0) =>
      interimL.forEach((l) => l({ text, words: [], confidence: null, offsetMs })),
    failWith: (reason) => failureL.forEach((l) => l(reason)),
    vendorError: (message) => vendorErrorL.forEach((l) => l(message)),
    session: {
      transcripts: {
        write: (c) => written.push(c),
        onInterim: (l) => interimL.push(l),
        onFinal: (l) => finalL.push(l),
        close: () => {
          self.closed = true;
        },
      },
      turns: {
        write: (c) => written.push(c),
        onSpeechStart: (l) => startL.push(l),
        onEagerEndOfTurn: (l) => eagerL.push(l),
        onEndOfTurn: (l) => eotL.push(l),
        onTurnResumed: (l) => resumedL.push(l),
        close: () => {
          self.closed = true;
        },
      },
      write: (c) => written.push(c),
      onFailure: (l) => failureL.push(l),
      onVendorError: (l) => vendorErrorL.push(l),
      close: () => {
        self.closed = true;
      },
    },
  };
  return self;
};

export interface FakeCompletion {
  readonly request: CompletionRequest;
  cancelled: boolean;
  emit(token: string): void;
  finish(): void;
  fail(message: string): void;
}

export interface FakeLlm {
  readonly provider: LlmProvider;
  /** Every completion requested, in order. `request.messages` is the history assertion surface. */
  readonly completions: FakeCompletion[];
  last(): FakeCompletion;
  /** History as the LLM last saw it — where every conversation bug shows up. */
  lastMessages(): readonly Message[];
}

export const fakeLlm = (): FakeLlm => {
  const completions: FakeCompletion[] = [];
  const provider: LlmProvider = {
    name: "fake-llm",
    complete: (request) => {
      const deltas: ((t: string) => void)[] = [];
      const dones: ((f: string) => void)[] = [];
      const errors: ((e: Error) => void)[] = [];
      let full = "";
      const c: FakeCompletion = {
        request,
        cancelled: false,
        emit: (token) => {
          if (c.cancelled) return;
          full += token;
          deltas.forEach((l) => l(token));
        },
        finish: () => {
          if (c.cancelled) return;
          dones.forEach((l) => l(full));
        },
        fail: (m) => {
          if (c.cancelled) return;
          errors.forEach((l) => l(new Error(m)));
        },
      };
      completions.push(c);
      const stream: CompletionStream = {
        onDelta: (l) => deltas.push(l),
        onDone: (l) => dones.push(l),
        onError: (l) => errors.push(l),
        cancel: () => {
          c.cancelled = true;
        },
      };
      return stream;
    },
  };
  return {
    provider,
    completions,
    last: () => {
      const c = completions[completions.length - 1];
      if (c === undefined) throw new Error("no completion was requested");
      return c;
    },
    lastMessages: () => {
      const c = completions[completions.length - 1];
      if (c === undefined) throw new Error("no completion was requested");
      return c.request.messages;
    },
  };
};

export interface FakeSynthesis {
  readonly request: SynthesisRequest;
  cancelled: boolean;
  /** Finished or failed. A settled synthesis is no longer producing audio. */
  settled: boolean;
  audio(bytes: number): void;
  done(): void;
  fail(message: string): void;
}

export interface FakeTts {
  readonly provider: TtsProvider;
  readonly syntheses: FakeSynthesis[];
  last(): FakeSynthesis;
  /** The text actually handed to TTS — proves forSpeech was applied. */
  texts(): string[];
  /** Still producing audio: neither finished nor cancelled. More than one is a defect. */
  live(): FakeSynthesis[];
}

export const fakeTts = (): FakeTts => {
  const syntheses: FakeSynthesis[] = [];
  const provider: TtsProvider = {
    name: "fake-tts",
    synthesize: (request) => {
      const audioL: ((c: AudioChunk) => void)[] = [];
      const doneL: (() => void)[] = [];
      const errL: ((e: Error) => void)[] = [];
      const s: FakeSynthesis = {
        request,
        cancelled: false,
        settled: false,
        audio: (bytes) => {
          if (s.cancelled || s.settled) return;
          audioL.forEach((l) => l(chunkOf(bytes)));
        },
        done: () => {
          if (s.cancelled || s.settled) return;
          s.settled = true;
          doneL.forEach((l) => l());
        },
        fail: (m) => {
          if (s.cancelled || s.settled) return;
          s.settled = true;
          errL.forEach((l) => l(new Error(m)));
        },
      };
      syntheses.push(s);
      const stream: SynthesisStream = {
        onAudio: (l) => audioL.push(l),
        onDone: (l) => doneL.push(l),
        onError: (l) => errL.push(l),
        cancel: () => {
          s.cancelled = true;
        },
      };
      return stream;
    },
  };
  return {
    provider,
    syntheses,
    last: () => {
      const s = syntheses[syntheses.length - 1];
      if (s === undefined) throw new Error("nothing was synthesised");
      return s;
    },
    texts: () => syntheses.map((s) => s.request.text),
    live: () => syntheses.filter((s) => !s.cancelled && !s.settled),
  };
};
