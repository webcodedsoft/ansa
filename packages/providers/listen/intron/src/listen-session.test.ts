import type { Logger } from "@ansa/shared";
import { describe, expect, it, vi } from "vitest";

import { openIntronSession, type IntronSocket } from "./listen-session";
import { MIN_CHUNK_BYTES, WARM_BACKLOG_BYTES } from "./protocol";

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

  it("streams only to the live leg, so the warm one costs no bandwidth", () => {
    /* It used to stream to both, which doubled outbound traffic for a socket no transcript
       was ever read from. On a constrained link that is bandwidth taken from the carrier's
       own media stream, and the calls at 12:42 and 12:50 arrived at a tenth of real time. */
    const { session, legs } = setup();
    legs[0]?.ready();
    legs[1]?.ready();
    session.write(audio(MIN_CHUNK_BYTES));
    expect(legs[0]?.sent.length).toBeGreaterThan(0);
    expect(legs[1]?.sent).toHaveLength(0);
  });

  it("keeps the warm leg a couple of seconds of audio, so it is not deaf when promoted", () => {
    const { session, legs } = setup();
    legs[0]?.ready();
    // Four seconds of mu-law, which is eight seconds of PCM16 — past the two-second cap.
    for (let i = 0; i < 200; i += 1) session.write(audio(160));
    legs[0]?.say("SESSION_TIME_LIMIT_EXCEEDED", {});

    // The promoted leg flushes what it kept, and it is bounded rather than the whole call.
    legs[1]?.ready();
    const bytes = (legs[1]?.sent ?? [])
      .map((raw) => Buffer.from(String((JSON.parse(raw) as Record<string, unknown>)["audio_base_64"]), "base64").length)
      .reduce((n, b) => n + b, 0);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(WARM_BACKLOG_BYTES);
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
  it("pads the tail up to the floor rather than sending it short", () => {
    /* Read off the call at 12:37. The tail went out at its real length, came back
       CHUNK_SIZE_TOO_SMALL, and every chunk after it was CHUNK_ID_MISMATCH_WITH_TOTAL —
       the counter never recovers. One short chunk cost the whole session. */
    const { session, legs } = setup();
    legs[0]?.ready();
    session.write(audio(100));
    session.commit();

    const frames = (legs[0]?.sent ?? []).map((raw) => JSON.parse(raw) as Record<string, unknown>);
    expect(frames.map((f) => f["message_type"])).toEqual(["INPUT_AUDIO_CHUNK", "COMMIT"]);
    expect(Buffer.from(String(frames[0]?.["audio_base_64"]), "base64").length).toBe(MIN_CHUNK_BYTES);
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

  it("promotes the warm leg after a final, so turn two is not deaf", () => {
    /* COMMIT closes the socket. Leaving `current` on it made every turn after the first
       end in the transcript watchdog — the call at 13:05 had full audio, Flux ending
       turns, and two "no transcript" recovery lines. */
    const { session, legs } = setup();
    const heard: string[] = [];
    session.transcripts.onFinal((t) => heard.push(t.text));

    legs[0]?.ready();
    session.commit();
    legs[0]?.say("COMMITTED_TRANSCRIPT", { transcript_text: "turn one" });
    expect(legs).toHaveLength(3);

    // The promoted leg is live: it commits and delivers rather than no-opping.
    legs[1]?.ready();
    session.commit();
    legs[1]?.say("COMMITTED_TRANSCRIPT", { transcript_text: "turn two" });
    expect(heard).toEqual(["turn one", "turn two"]);
  });

  it("replaces the leg even when a commit closes without ever sending a final", () => {
    /* The backstop. If the vendor hangs up after COMMIT with nothing to say, `current`
       would otherwise stay dead with nothing to notice it. */
    const { session, legs } = setup();
    legs[0]?.ready();
    session.commit();
    legs[0]?.hangUp("1000");
    expect(legs).toHaveLength(3);
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

describe("promoting the warm leg", () => {
  it("hands over the audio it was holding, rather than stranding it", () => {
    /* `ready` is the only other place that drains the backlog, and for a warm leg it fires
       long before any of it arrives. Without draining on promotion, two seconds of the
       caller stayed in `backlog` for the rest of the call and every turn began deaf to its
       own opening words. */
    const { session, legs } = setup();
    legs[0]?.ready();
    legs[1]?.ready();
    for (let i = 0; i < 20; i += 1) session.write(audio(160));

    expect(legs[1]?.sent).toHaveLength(0);
    legs[0]?.say("SESSION_TIME_LIMIT_EXCEEDED", {});

    const bytes = (legs[1]?.sent ?? [])
      .map((raw) => Buffer.from(String((JSON.parse(raw) as Record<string, unknown>)["audio_base_64"]), "base64").length)
      .reduce((n, b) => n + b, 0);
    expect(bytes).toBeGreaterThan(0);
  });

  it("waits for the session before committing a leg that has just been promoted", () => {
    /* Connecting takes about 660ms. A COMMIT sent before SESSION_CREATED comes back
       INPUT_ERROR, which desynchronises the counter and costs the turn — two of those
       landed on the call at 14:16, right as the first turn ended. */
    const { session, legs } = setup();
    legs[0]?.ready();
    session.commit();
    legs[0]?.say("COMMITTED_TRANSCRIPT", { transcript_text: "one" });

    // legs[1] is now current and has never had SESSION_CREATED.
    session.commit();
    expect(legs[1]?.sent.map((r) => (JSON.parse(r) as { message_type: string }).message_type))
      .not.toContain("COMMIT");

    legs[1]?.ready();
    expect(legs[1]?.sent.map((r) => (JSON.parse(r) as { message_type: string }).message_type))
      .toContain("COMMIT");
  });
});

describe("a chunk the server refuses", () => {
  it("replaces the leg, because the counter never resynchronises", () => {
    /* `ack_id` tracks the server's count of accepted chunks. A rejection desynchronises
       it permanently, so retrying on the same socket sends thirty seconds of audio into
       INPUT_ERROR — which is exactly what the 12:37 call did. */
    const { legs } = setup();
    legs[0]?.ready();
    legs[0]?.say("CHUNK_SIZE_TOO_SMALL", {});
    expect(legs).toHaveLength(3);
  });

  it("reports it as a vendor complaint rather than a dead listener", () => {
    const { session, legs } = setup();
    const failures: string[] = [];
    const complaints: string[] = [];
    session.onFailure((r) => failures.push(r));
    session.onVendorError((m) => complaints.push(m));
    legs[0]?.ready();
    legs[0]?.say("CHUNK_ID_MISMATCH_WITH_TOTAL", {});
    expect(failures).toEqual([]);
    expect(complaints).toHaveLength(1);
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
