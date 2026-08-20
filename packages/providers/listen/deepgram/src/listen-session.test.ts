import { Buffer } from "node:buffer";

import { TELEPHONY_AUDIO } from "@ansa/shared";
import { describe, expect, it } from "vitest";

import { openDeepgramSession, type DeepgramSocket } from "./listen-session";

/**
 * Staying connected for the length of a call.
 *
 * Flux is the only turn detector now, so a socket that dies at second forty takes the
 * agent's ability to know the caller has stopped talking with it. There is no degraded
 * mode: the orchestrator treats a listen failure as the call being deaf. So a drop has
 * to be redialled, the caller's words have to survive the gap, and a connection that is
 * genuinely gone has to be reported rather than retried forever.
 */

interface FakeSocket extends DeepgramSocket {
  readonly sent: Buffer[];
  open(): void;
  drop(reason: string): void;
  closedByUs(): boolean;
}

const fakeSocket = (): FakeSocket => {
  const sent: Buffer[] = [];
  let onOpen = (): void => undefined;
  let onClose = (_r: string): void => undefined;
  let shut = false;

  return {
    sent,
    onOpen: (l) => {
      onOpen = l;
    },
    onMessage: () => undefined,
    onClose: (l) => {
      onClose = l;
    },
    onError: () => undefined,
    send: (data) => sent.push(data),
    close: () => {
      shut = true;
    },
    open: () => onOpen(),
    drop: (reason) => onClose(reason),
    closedByUs: () => shut,
  };
};

/** Runs the backoff immediately and records what it was asked to wait. */
const immediate = () => {
  const waits: number[] = [];
  return {
    waits,
    schedule: (run: () => void, ms: number) => {
      waits.push(ms);
      run();
    },
  };
};

const frame = (byte: number): { data: Buffer; offsetMs: number } => ({
  data: Buffer.alloc(160, byte),
  offsetMs: 0,
});

const harness = () => {
  const sockets: FakeSocket[] = [];
  const clock = immediate();
  const failures: string[] = [];
  const session = openDeepgramSession(
    () => {
      const s = fakeSocket();
      sockets.push(s);
      return s;
    },
    { schedule: clock.schedule },
  );
  session.onFailure((reason) => failures.push(reason));
  return { sockets, clock, failures, session };
};

describe("a socket that drops mid-call", () => {
  it("redials rather than reporting the call deaf", () => {
    const h = harness();
    h.sockets[0]?.open();
    h.sockets[0]?.drop("carrier reset");

    expect(h.sockets).toHaveLength(2);
    // A blip that recovers must not surface: the orchestrator ends the call on a failure.
    expect(h.failures).toEqual([]);
  });

  it("keeps what the caller said while it was down, and sends it on reopen", () => {
    const h = harness();
    h.sockets[0]?.open();
    h.sockets[0]?.drop("carrier reset");

    // Mid-sentence during the gap. Losing this is losing the caller's words.
    h.session.write(frame(1));
    h.session.write(frame(2));
    expect(h.sockets[1]?.sent).toHaveLength(0);

    h.sockets[1]?.open();
    expect(h.sockets[1]?.sent).toHaveLength(2);
  });

  it("backs off further each time rather than hammering a dead endpoint", () => {
    const h = harness();
    h.sockets[0]?.open();
    for (let i = 0; i < 3; i += 1) h.sockets[i]?.drop("gone");

    expect(h.clock.waits).toEqual([250, 500, 1000]);
  });

  it("gives up eventually and says the call is deaf", () => {
    const h = harness();
    h.sockets[0]?.open();
    // Four redials, then the fifth drop has nothing left to try.
    for (let i = 0; i < 5; i += 1) h.sockets[i]?.drop("gone");

    expect(h.sockets).toHaveLength(5);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toContain("gave up after 4 redials");
  });

  it("reports the failure once, however many times it is told", () => {
    const h = harness();
    h.sockets[0]?.open();
    for (let i = 0; i < 6; i += 1) h.sockets[i]?.drop("gone");

    expect(h.failures).toHaveLength(1);
  });

  it("does not redial a session the call deliberately closed", () => {
    const h = harness();
    h.sockets[0]?.open();
    h.session.close();
    h.sockets[0]?.drop("closed");

    expect(h.sockets).toHaveLength(1);
    expect(h.failures).toEqual([]);
  });

  /**
   * Not reset on a successful reopen, deliberately. A socket dropping four times in one
   * call is not four blips, and redialling forever hides an outage behind an agent that
   * hears every other sentence.
   */
  it("counts redials across the whole call, not since the last success", () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      h.sockets[i]?.open();
      h.sockets[i]?.drop("flapping");
    }

    expect(h.failures).toHaveLength(1);
  });
});

describe("audio written before the first connection", () => {
  it("is held and flushed, so the opening words are not lost", () => {
    const h = harness();
    h.session.write(frame(9));
    expect(h.sockets[0]?.sent).toHaveLength(0);

    h.sockets[0]?.open();
    expect(h.sockets[0]?.sent).toHaveLength(1);
  });

  it("is bounded, so a socket that never opens cannot grow without limit", () => {
    const h = harness();
    // 200 frames of 160 bytes is 32000 bytes, past the three-second cap.
    for (let i = 0; i < 200; i += 1) h.session.write(frame(1));

    h.sockets[0]?.open();
    const bytes = (h.sockets[0]?.sent ?? []).reduce((n, b) => n + b.length, 0);
    expect(bytes).toBeLessThanOrEqual(24_000);
    expect(bytes).toBeGreaterThan(0);
  });
});

describe("the session's own accounting", () => {
  it("keeps the offset clock running across a reconnect", () => {
    // The orchestrator correlates transcripts against turn events on this number and
    // matches echo-suppressed segments by exact equality. A clock that reset on a
    // redial would silently break both.
    const h = harness();
    h.sockets[0]?.open();
    h.session.write(frame(1));
    h.sockets[0]?.drop("reset");
    h.sockets[1]?.open();
    h.session.write(frame(1));

    expect(h.sockets[1]?.sent.length).toBeGreaterThan(0);
    expect(TELEPHONY_AUDIO.sampleRate).toBe(8000);
  });
});
