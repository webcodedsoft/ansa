import type { Logger } from "@ansa/shared";
import { describe, expect, it, vi } from "vitest";

import { openIntronSession, type IntronSocket } from "./listen-session";
import { MIN_CHUNK_BYTES } from "./protocol";

/**
 * Written against what the live API actually did on 2026-08-23, not against the docs.
 *
 * The three behaviours that shape this adapter — COMMIT closes the socket, a session takes
 * 659ms to become usable, and 8000 Hz is honoured — were probed, and each one is a way for
 * a caller's words to go missing if it is handled wrongly.
 */

const silent: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
} as unknown as Logger;

const fakeSocket = () => {
  const listeners = { message: [] as ((d: string) => void)[], close: [] as ((r: string) => void)[], error: [] as ((e: Error) => void)[], open: [] as (() => void)[] };
  const sent: string[] = [];
  const socket: IntronSocket = {
    onOpen: (l) => listeners.open.push(l),
    onMessage: (l) => listeners.message.push(l),
    onClose: (l) => listeners.close.push(l),
    onError: (l) => listeners.error.push(l),
    send: (d) => sent.push(d),
    close: () => {},
  };
  return {
    socket,
    sent,
    ready: (rate = 8000) =>
      listeners.message.forEach((l) =>
        l(JSON.stringify({ message_type: "SESSION_CREATED", session_id: "s", configs: { sample_rate: rate } })),
      ),
    say: (type: string, body: Record<string, unknown>) =>
      listeners.message.forEach((l) => l(JSON.stringify({ message_type: type, ...body }))),
    hangUp: (reason: string) => listeners.close.forEach((l) => l(reason)),
  };
};

const setup = () => {
  const legs: ReturnType<typeof fakeSocket>[] = [];
  const session = openIntronSession(
    () => { const leg = fakeSocket(); legs.push(leg); return leg.socket; },
    { host: "h", format: { encoding: "mulaw", sampleRate: 8000 }, language: "en", log: silent, startedAtMs: Date.now() },
  );
  return { session, legs };
};

const audio = (bytes: number) => ({ data: Buffer.alloc(bytes, 0xff), timestampMs: 0 }) as never;

describe("the socket that is already open", () => {
  it("opens a second one immediately, because a cold one costs 659ms", () => {
    /* Probed: connect to SESSION_CREATED is 659ms at the median, three times the whole
       turn-to-audio budget. It can only be paid while the agent is talking. */
    const { legs } = setup();
    expect(legs).toHaveLength(2);
  });

  it("feeds both, so a promoted socket is not deaf to what was said while it opened", () => {
    const { session, legs } = setup();
    legs[0]?.ready();
    legs[1]?.ready();
    session.write(audio(MIN_CHUNK_BYTES));
    for (const leg of legs) expect(leg.sent.length).toBeGreaterThan(0);
  });
});

describe("audio that arrives before the session is ready", () => {
  it("is held and sent once the server says it is listening", () => {
    /* The window is real — 659ms of it — and a caller who starts talking inside it would
       otherwise be transcribed from the middle of their first word. */
    const { session, legs } = setup();
    session.write(audio(MIN_CHUNK_BYTES * 2));
    expect(legs[0]?.sent).toHaveLength(0);

    legs[0]?.ready();
    expect(legs[0]?.sent.length).toBeGreaterThan(0);
    const frame = JSON.parse(legs[0]?.sent[0] ?? "{}") as Record<string, unknown>;
    expect(frame["message_type"]).toBe("INPUT_AUDIO_CHUNK");
    expect(Buffer.from(String(frame["audio_base_64"]), "base64").length).toBe(MIN_CHUNK_BYTES * 4);
  });
});

describe("committing a turn", () => {
  it("sends the tail below the chunk floor before committing", () => {
    /* The end of a turn is where the answer is. Audio still under the 1 KB floor when the
       caller stops would otherwise be dropped on the way to COMMIT. */
    const { session, legs } = setup();
    legs[0]?.ready();
    session.write(audio(100));
    session.commit();

    const types = (legs[0]?.sent ?? []).map((raw) => (JSON.parse(raw) as { message_type: string }).message_type);
    expect(types).toEqual(["INPUT_AUDIO_CHUNK", "COMMIT"]);
  });

  it("delivers the committed transcript as a final", () => {
    const { session, legs } = setup();
    const heard: string[] = [];
    session.transcripts.onFinal((t) => heard.push(t.text));
    legs[0]?.ready();
    session.commit();
    legs[0]?.say("COMMITTED_TRANSCRIPT", { transcript_text: "my name is Sikiru" });
    expect(heard).toEqual(["my name is Sikiru"]);
  });

  it("does not treat the close that follows a commit as a failure", () => {
    /* The vendor closes with code 1000 after COMMIT. Reporting that as a dead listener
       would end a call at the end of every single turn. */
    const { session, legs } = setup();
    const failures: string[] = [];
    session.onFailure((reason) => failures.push(reason));
    legs[0]?.ready();
    session.commit();
    legs[0]?.hangUp("1000");
    expect(failures).toEqual([]);
  });

  it("reports a close that nobody asked for", () => {
    const { session, legs } = setup();
    const failures: string[] = [];
    session.onFailure((reason) => failures.push(reason));
    legs[0]?.ready();
    legs[0]?.hangUp("1006");
    expect(failures).toHaveLength(1);
  });
});

describe("what it does not report", () => {
  it("carries no confidence, because the provider reports none", () => {
    /* Null is not low. The orchestrator must not read an absent number as a reason to ask
       a clarifying question, nor as permission to skip one. */
    const { session, legs } = setup();
    const seen: (number | null)[] = [];
    session.transcripts.onFinal((t) => { seen.push(t.confidence); expect(t.words).toEqual([]); });
    legs[0]?.ready();
    session.commit();
    legs[0]?.say("COMMITTED_TRANSCRIPT", { transcript_text: "x" });
    expect(seen).toEqual([null]);
  });

  it("stays quiet about the per-chunk ack", () => {
    const { session, legs } = setup();
    const errors: string[] = [];
    session.onVendorError((m) => errors.push(m));
    legs[0]?.ready();
    legs[0]?.say("AUDIO_CHUCK_ACK", { ack_id: 1 });
    expect(errors).toEqual([]);
  });
});

describe("the audio fan-out point", () => {
  it("refuses a write through the transcriber, so both providers cannot diverge", () => {
    const { session } = setup();
    expect(() => session.transcripts.write(audio(10))).toThrow(/through the session/);
  });
});

describe("the 300 second ceiling", () => {
  it("rotates when the server says the session expired", () => {
    const { legs } = setup();
    legs[0]?.ready();
    legs[0]?.say("SESSION_TIME_LIMIT_EXCEEDED", {});
    // The pre-opened leg is promoted and another is warmed behind it.
    expect(legs).toHaveLength(3);
  });

  it("rotates on age before the server has to, since there is no resume", () => {
    vi.useFakeTimers();
    try {
      const { session, legs } = setup();
      legs[0]?.ready();
      legs[1]?.ready();
      vi.advanceTimersByTime(280_000);
      session.write(audio(MIN_CHUNK_BYTES));
      expect(legs.length).toBeGreaterThan(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
