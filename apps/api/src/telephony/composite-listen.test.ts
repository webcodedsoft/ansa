import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import type { ListenSession } from "../orchestrator/orchestrator";
import { silentLog } from "../orchestrator/fakes";
import { composeListen } from "./composite-listen";

const fakeSide = (label: string) => {
  const written: number[] = [];
  const finals: ((t: unknown) => void)[] = [];
  const eots: ((e: unknown) => void)[] = [];
  const failures: ((r: string) => void)[] = [];
  const session = {
    write: (c: { data: Buffer }) => written.push(c.data.length),
    transcripts: {
      write: () => undefined,
      onInterim: () => undefined,
      onFinal: (l: (t: unknown) => void) => finals.push(l),
      close: vi.fn(),
    },
    turns: {
      write: () => undefined,
      onSpeechStart: () => undefined,
      onEagerEndOfTurn: () => undefined,
      onEndOfTurn: (l: (e: unknown) => void) => eots.push(l),
      onTurnResumed: () => undefined,
      close: vi.fn(),
    },
    onFailure: (l: (r: string) => void) => failures.push(l),
    onVendorError: () => undefined,
    close: vi.fn(),
  } as unknown as ListenSession;

  return {
    label,
    session,
    written,
    emitFinal: (text: string) => finals.forEach((l) => l({ text, offsetMs: 0 })),
    emitEot: () => eots.forEach((l) => l({ offsetMs: 0 })),
    fail: (reason: string) => failures.forEach((l) => l(reason)),
    closed: () => (session.close as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
  };
};

const compose = () => {
  const words = fakeSide("words");
  const turns = fakeSide("turns");
  return {
    words,
    turns,
    session: composeListen({
      words: words.session,
      turns: turns.session,
      log: silentLog,
      wordsName: "words",
      turnsName: "turns",
    }),
  };
};

describe("composeListen", () => {
  it("sends identical audio to both providers", () => {
    const c = compose();
    c.session.write({ data: Buffer.alloc(160), offsetMs: 0 });
    c.session.write({ data: Buffer.alloc(160), offsetMs: 20 });

    // Correlating a transcript with a turn event by offsetMs only works if both heard
    // exactly the same stream.
    expect(c.words.written).toEqual([160, 160]);
    expect(c.turns.written).toEqual([160, 160]);
  });

  it("takes transcripts from the words provider only", () => {
    const c = compose();
    const heard: string[] = [];
    c.session.transcripts.onFinal((t) => heard.push(t.text));

    c.words.emitFinal("my policy number");
    c.turns.emitFinal("this must be ignored");

    expect(heard).toEqual(["my policy number"]);
  });

  it("takes turn events from the turn provider only", () => {
    const c = compose();
    const ends: number[] = [];
    c.session.turns.onEndOfTurn(() => ends.push(1));

    c.turns.emitEot();
    c.words.emitEot();

    expect(ends).toHaveLength(1);
  });

  it("treats either provider failing as a session failure", () => {
    // No useful degraded mode exists: without words there is nothing to understand, and
    // without turn events the agent never learns the caller stopped.
    for (const failing of ["words", "turns"] as const) {
      const c = compose();
      const reasons: string[] = [];
      c.session.onFailure((r) => reasons.push(r));

      c[failing].fail("socket closed");

      expect(reasons).toEqual([`${failing}: socket closed`]);
    }
  });

  it("closes both, once, even if the first close throws", () => {
    const c = compose();
    (c.words.session.close as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("already gone");
    });

    // A half-closed pair leaks a socket per call.
    expect(() => c.session.close()).toThrow();
    expect(c.turns.closed()).toBe(1);

    c.session.close();
    expect(c.turns.closed()).toBe(1);
  });
});

describe("a transcriber whose final only comes when asked", () => {
  it("commits when the turn detector says the caller stopped", () => {
    /* Intron's COMMIT is what produces a transcript, and this is the only layer holding
       both halves. Without the wiring the agent streams to a socket that never answers
       and the transcript watchdog fires on every turn of every call. */
    const words = fakeSide("words");
    const turns = fakeSide("turns");
    const commits: number[] = [];

    composeListen({
      words: { ...words.session, commit: () => commits.push(1) },
      turns: turns.session,
      log: silentLog,
      wordsName: "intron",
      turnsName: "deepgram",
    });
    turns.emitEot();

    expect(commits).toHaveLength(1);
  });

  it("does not ask a provider that commits on its own", () => {
    // OpenAI ends its own turns. A commit from here would be a second endpointer.
    const words = fakeSide("words");
    const turns = fakeSide("turns");
    composeListen({
      words: words.session,
      turns: turns.session,
      log: silentLog,
      wordsName: "openai",
      turnsName: "deepgram",
    });
    expect(() => turns.emitEot()).not.toThrow();
  });
});
