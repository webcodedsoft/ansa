import { Buffer } from "node:buffer";

import { TELEPHONY_AUDIO, asCallId, type AudioChunk, type Logger } from "@ansa/shared";
import type { CallMediaStream } from "@ansa/telephony";
import type { SynthesisRequest, SynthesisStream, TtsProvider } from "@ansa/tts";
import { describe, expect, it, vi } from "vitest";

import { GREETING_TEXT, speakGreeting } from "./greeting";

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
};

/** A CallMediaStream the test drives by hand. */
const stubStream = () => {
  const markListeners: ((name: string) => void)[] = [];
  const closedListeners: ((reason: string) => void)[] = [];
  const sent: AudioChunk[] = [];
  const marks: string[] = [];
  const hangUp = vi.fn();

  const stream: CallMediaStream = {
    callId: asCallId("CA-greeting-test"),
    format: TELEPHONY_AUDIO,
    onAudio: () => undefined,
    send: (chunk) => sent.push(chunk),
    mark: (name) => marks.push(name),
    onMark: (listener) => markListeners.push(listener),
    clear: () => undefined,
    onClosed: (listener) => closedListeners.push(listener),
    hangUp,
  };

  return {
    stream,
    sent,
    marks,
    hangUp,
    fireMark: (name: string) => markListeners.forEach((l) => l(name)),
    fireClosed: (reason: string) => closedListeners.forEach((l) => l(reason)),
  };
};

/** A TtsProvider the test drives by hand. */
const stubTts = () => {
  const requests: SynthesisRequest[] = [];
  let audio: ((chunk: AudioChunk) => void) | undefined;
  let done: (() => void) | undefined;
  let failed: ((error: Error) => void) | undefined;
  const cancel = vi.fn();

  const provider: TtsProvider = {
    name: "stub",
    synthesize: (request) => {
      requests.push(request);
      const stream: SynthesisStream = {
        onAudio: (l) => {
          audio = l;
        },
        onDone: (l) => {
          done = l;
        },
        onError: (l) => {
          failed = l;
        },
        cancel,
      };
      return stream;
    },
  };

  return {
    provider,
    requests,
    cancel,
    emitAudio: (bytes: number[]) => audio?.({ data: Buffer.from(bytes), offsetMs: 0 }),
    emitDone: () => done?.(),
    emitError: (message: string) => failed?.(new Error(message)),
  };
};

const setup = () => {
  const call = stubStream();
  const tts = stubTts();
  speakGreeting(call.stream, {
    tts: tts.provider,
    voiceId: "voice-ng-1",
    log: silentLog,
    markTimeoutMs: 50,
  });
  return { call, tts };
};

describe("speakGreeting", () => {
  it("asks for the real greeting, in the stream's format, in the configured voice", () => {
    const { tts } = setup();

    expect(tts.requests).toHaveLength(1);
    expect(tts.requests[0]).toEqual({
      text: GREETING_TEXT,
      voiceId: "voice-ng-1",
      format: TELEPHONY_AUDIO,
    });
    // The brand name is the point of speaking it at all (PRD §1.0).
    expect(GREETING_TEXT).toContain("Ansa");
  });

  it("forwards each synthesised chunk to the caller", () => {
    const { call, tts } = setup();

    tts.emitAudio([1, 2, 3]);
    tts.emitAudio([4, 5]);

    expect(Buffer.concat(call.sent.map((c) => c.data))).toEqual(Buffer.from([1, 2, 3, 4, 5]));
  });

  // The defect this guards: audio queued at the carrier has not been heard yet, so
  // hanging up when synthesis finishes cuts off the end of the greeting.
  it("marks when synthesis finishes but does not hang up yet", () => {
    const { call, tts } = setup();

    tts.emitAudio([1]);
    tts.emitDone();

    expect(call.marks).toHaveLength(1);
    expect(call.hangUp).not.toHaveBeenCalled();
  });

  it("hangs up once the carrier returns the mark", () => {
    const { call, tts } = setup();

    tts.emitAudio([1]);
    tts.emitDone();
    call.fireMark(call.marks[0] as string);

    expect(call.hangUp).toHaveBeenCalledTimes(1);
  });

  it("ignores marks it did not place", () => {
    const { call, tts } = setup();

    tts.emitDone();
    call.fireMark("some-other-mark");

    expect(call.hangUp).not.toHaveBeenCalled();
  });

  // Never silence: a failed synthesis has to end the call, not hold an open line.
  it("hangs up when synthesis fails", () => {
    const { call, tts } = setup();

    tts.emitError("elevenlabs returned 401");

    expect(call.hangUp).toHaveBeenCalledTimes(1);
  });

  it("hangs up if the mark never comes back", async () => {
    const { call, tts } = setup();

    tts.emitDone();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(call.hangUp).toHaveBeenCalledTimes(1);
  });

  it("does not hang up a stream the caller already closed", async () => {
    const { call } = setup();

    call.fireClosed("caller hung up");
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(call.hangUp).not.toHaveBeenCalled();
  });

  it("hangs up at most once", async () => {
    const { call, tts } = setup();

    tts.emitDone();
    call.fireMark(call.marks[0] as string);
    call.fireMark(call.marks[0] as string);
    tts.emitError("late failure");
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(call.hangUp).toHaveBeenCalledTimes(1);
  });
});
