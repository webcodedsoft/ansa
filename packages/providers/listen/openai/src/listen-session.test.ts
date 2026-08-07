import { Buffer } from "node:buffer";

import { TELEPHONY_AUDIO } from "@ansa/shared";
import type { Transcript } from "@ansa/transcriber";
import type { TurnEvent } from "@ansa/turn-detector";
import { describe, expect, it } from "vitest";

import { openListenSession, type ListenSocket } from "./listen-session";

const fakeSocket = () => {
  let open: (() => void) | undefined;
  let message: ((d: string) => void) | undefined;
  const sent: string[] = [];
  let closed = false;

  const socket: ListenSocket = {
    onOpen: (l) => {
      open = l;
    },
    onMessage: (l) => {
      message = l;
    },
    onClose: () => undefined,
    onError: () => undefined,
    send: (d) => sent.push(d),
    close: () => {
      closed = true;
    },
  };

  return {
    socket,
    sent,
    isClosed: () => closed,
    open: () => open?.(),
    emit: (e: unknown) => message?.(JSON.stringify(e)),
    appends: () => sent.map((s) => JSON.parse(s)).filter((f) => f.type === "input_audio_buffer.append"),
  };
};

const connect = () => {
  const f = fakeSocket();
  const session = openListenSession(f.socket, {
    format: TELEPHONY_AUDIO,
    model: "gpt-4o-transcribe",
    turnDetection: { type: "server_vad", silenceMs: 500 },
    keyterms: ["Ansa"],
  });
  return { ...f, session };
};

const chunk = (n: number) => ({ data: Buffer.alloc(n, 0x7f), offsetMs: 0 });

describe("openListenSession", () => {
  it("configures the session as mu-law on open", () => {
    const f = connect();
    f.open();

    const update = JSON.parse(f.sent[0] as string);
    expect(update.type).toBe("session.update");
    expect(update.session.audio.input.format).toEqual({ type: "audio/pcmu" });
    expect(update.session.audio.input.turn_detection.silence_duration_ms).toBe(500);
  });

  // Regression guard. Passing keyterms as a `prompt` made the model recite them back as
  // caller speech on a live call — "Expect these terms: Ansa, policy, premium, naira."
  // arrived five times as phantom turns, and the agent answered them. Whisper-family
  // models regurgitate their prompt when fed silence or noise. Never send one.
  it("never sends a transcription prompt, whatever keyterms it is given", () => {
    const f = connect();
    f.open();

    const transcription = JSON.parse(f.sent[0] as string).session.audio.input.transcription;
    expect(transcription.prompt).toBeUndefined();
    expect(JSON.stringify(transcription)).not.toContain("Ansa");
  });

  // The vendor discards audio sent before the session is configured. Dropping those
  // frames would take the first word of every call with them.
  it("buffers audio written before the session is ready, then flushes it in order", () => {
    const f = connect();
    f.open();
    f.session.write(chunk(160));
    f.session.write(chunk(160));

    expect(f.appends()).toHaveLength(0);

    f.emit({ type: "session.updated" });
    expect(f.appends()).toHaveLength(2);

    f.session.write(chunk(160));
    expect(f.appends()).toHaveLength(3);
  });

  it("feeds both interfaces from a single write", () => {
    const f = connect();
    f.open();
    f.emit({ type: "session.updated" });

    const transcripts: Transcript[] = [];
    const turns: TurnEvent[] = [];
    f.session.transcripts.onFinal((t) => transcripts.push(t));
    f.session.turns.onEndOfTurn((e) => turns.push(e));

    f.session.write(chunk(8000)); // one second of mu-law
    f.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "hello" });
    f.emit({ type: "input_audio_buffer.speech_stopped", audio_end_ms: 990 });

    expect(transcripts[0]?.text).toBe("hello");
    expect(turns[0]?.offsetMs).toBe(990);
    // One write, one upload — not one per consumer.
    expect(f.appends()).toHaveLength(1);
  });

  it("reports transcripts with a stream offset derived from bytes written", () => {
    const f = connect();
    f.open();
    f.emit({ type: "session.updated" });

    const seen: Transcript[] = [];
    f.session.transcripts.onFinal((t) => seen.push(t));

    f.session.write(chunk(16000)); // two seconds at 8kHz mu-law
    f.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "two" });

    expect(seen[0]?.offsetMs).toBe(2000);
  });

  it("prefers the vendor's own audio offsets for turn events when present", () => {
    const f = connect();
    f.open();
    f.emit({ type: "session.updated" });

    const starts: TurnEvent[] = [];
    f.session.turns.onSpeechStart((e) => starts.push(e));

    f.session.write(chunk(8000));
    f.emit({ type: "input_audio_buffer.speech_started", audio_start_ms: 123 });

    expect(starts[0]?.offsetMs).toBe(123);
  });

  it("falls back to the byte counter when the vendor omits an offset", () => {
    const f = connect();
    f.open();
    f.emit({ type: "session.updated" });

    const starts: TurnEvent[] = [];
    f.session.turns.onSpeechStart((e) => starts.push(e));

    f.session.write(chunk(4000)); // 500ms
    f.emit({ type: "input_audio_buffer.speech_started" });

    expect(starts[0]?.offsetMs).toBe(500);
  });

  it("reports interim transcripts separately from finals", () => {
    const f = connect();
    f.open();
    f.emit({ type: "session.updated" });

    const interim: string[] = [];
    const final: string[] = [];
    f.session.transcripts.onInterim((t) => interim.push(t.text));
    f.session.transcripts.onFinal((t) => final.push(t.text));

    f.emit({ type: "conversation.item.input_audio_transcription.delta", delta: "he" });
    f.emit({ type: "conversation.item.input_audio_transcription.delta", delta: "llo" });
    f.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "hello" });

    expect(interim).toEqual(["he", "llo"]);
    expect(final).toEqual(["hello"]);
  });

  // Honesty about the gap: this provider gives no word timings or confidence, and
  // R4.1.5 wants both. Inventing a number here would corrupt every downstream decision
  // about whether to ask a clarifying question.
  it("reports null confidence and no words rather than inventing them", () => {
    const f = connect();
    f.open();
    f.emit({ type: "session.updated" });

    const seen: Transcript[] = [];
    f.session.transcripts.onFinal((t) => seen.push(t));
    f.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "x" });

    expect(seen[0]?.confidence).toBeNull();
    expect(seen[0]?.words).toEqual([]);
  });

  it("ignores unknown and malformed events rather than dropping the call", () => {
    const f = connect();
    f.open();
    f.emit({ type: "session.updated" });

    expect(() => {
      f.emit({ type: "something.brand.new", data: 1 });
      f.emit({ nope: true });
      f.session.transcripts.onFinal(() => undefined);
    }).not.toThrow();
  });

  it("closes once, from either interface", () => {
    const f = connect();
    f.open();
    f.emit({ type: "session.updated" });

    f.session.turns.close();
    f.session.transcripts.close();
    expect(f.isClosed()).toBe(true);

    // Writes after close are dropped rather than throwing on a dead socket.
    expect(() => f.session.write(chunk(160))).not.toThrow();
  });
});
