import { describe, expect, it } from "vitest";

import { createWarmScheduler, type WarmRun } from "./warm-scheduler";

/**
 * The rule these hold is one measured call: a warm that started at ingress was still
 * rendering after the media socket opened, and the first 6.6 seconds of caller audio were
 * discarded by the carrier while this process synthesised greetings nobody was waiting
 * for. Every test here is that call in miniature.
 */

/** A render that reports each batch it reached and honours the yield signal. */
const batches = (
  count: number,
  reached: string[],
  label = "phrase",
): { run: WarmRun; release: () => Promise<void> } => {
  let unblock: (() => void) | null = null;
  const gate = (): Promise<void> =>
    new Promise<void>((resolve) => {
      unblock = resolve;
    });

  /* Parks first, then checks. That is the order the real render has: it is sitting in an
     ElevenLabs round trip when a call arrives, and consults the signal on the way into the
     next batch. Checking before parking instead lets one batch through after the signal,
     which is what the first version of this fake did and why it read as a scheduler bug. */
  const run: WarmRun = async (keepGoing) => {
    for (let at = 0; at < count; at += 1) {
      await gate();
      if (!keepGoing()) return false;
      reached.push(`${label}-${at}`);
    }
    return true;
  };

  return {
    run,
    release: async () => {
      unblock?.();
      unblock = null;
      await Promise.resolve();
      await Promise.resolve();
    },
  };
};

describe("warming while somebody is on the line", () => {
  it("does not start a render during a call", () => {
    const scheduler = createWarmScheduler();
    const reached: string[] = [];

    scheduler.callStarted();
    scheduler.submit({ key: "voice-a", run: batches(3, reached).run });

    expect(scheduler.runningCount()).toBe(0);
    expect(scheduler.deferredCount()).toBe(1);
    expect(reached).toEqual([]);
  });

  it("starts the deferred render once the last call ends", async () => {
    const scheduler = createWarmScheduler();
    const reached: string[] = [];
    const job = batches(1, reached);

    scheduler.callStarted();
    scheduler.submit({ key: "voice-a", run: job.run });
    scheduler.callEnded();

    expect(scheduler.runningCount()).toBe(1);
    await job.release();
    expect(reached).toEqual(["phrase-0"]);
  });

  it("keeps deferring while a second call is still up", () => {
    /* Two overlapping calls. The first hanging up must not release the warm onto the one
       still talking, which is the bug a bare boolean would have. */
    const scheduler = createWarmScheduler();

    scheduler.callStarted();
    scheduler.callStarted();
    scheduler.submit({ key: "voice-a", run: batches(2, []).run });
    scheduler.callEnded();

    expect(scheduler.runningCount()).toBe(0);
    expect(scheduler.deferredCount()).toBe(1);

    scheduler.callEnded();
    expect(scheduler.runningCount()).toBe(1);
  });

  it("stops a render already in flight when a call arrives", async () => {
    const scheduler = createWarmScheduler();
    const reached: string[] = [];
    const job = batches(5, reached);

    scheduler.submit({ key: "voice-a", run: job.run });
    await job.release();
    expect(reached).toEqual(["phrase-0"]);

    scheduler.callStarted();
    await job.release();

    // It reached the yield check before the second batch and stopped there.
    expect(reached).toEqual(["phrase-0"]);
  });

  it("re-queues the part it did not reach rather than calling it done", async () => {
    /* Without this an interrupted warm looks finished forever, and every phrase it never
       reached is synthesised live on every later call. */
    const scheduler = createWarmScheduler();
    const reached: string[] = [];
    const first = batches(5, reached);

    scheduler.submit({ key: "voice-a", run: first.run });
    await first.release();
    scheduler.callStarted();
    await first.release();

    expect(scheduler.deferredCount()).toBe(1);

    scheduler.callEnded();
    expect(scheduler.runningCount()).toBe(1);
  });

  it("does not render the same voice twice at once", async () => {
    /* Asserted on what the second job rendered, not on `runningCount`: `running` is keyed
       by voice, so a duplicate start leaves the count at one either way and the first
       version of this test could not fail. */
    const scheduler = createWarmScheduler();
    const reached: string[] = [];
    const first = batches(3, reached);
    const second = batches(3, reached, "second");

    scheduler.submit({ key: "voice-a", run: first.run });
    scheduler.submit({ key: "voice-a", run: second.run });

    await first.release();
    await second.release();

    expect(reached).toEqual(["phrase-0"]);
    expect(scheduler.deferredCount()).toBe(0);
  });

  it("renders when nothing is on the line", async () => {
    /* The other half. A scheduler that never runs anything would pass every test above. */
    const scheduler = createWarmScheduler();
    const reached: string[] = [];
    const job = batches(2, reached);

    scheduler.submit({ key: "voice-a", run: job.run });
    await job.release();
    await job.release();

    expect(reached).toEqual(["phrase-0", "phrase-1"]);
    expect(scheduler.deferredCount()).toBe(0);
  });

  it("survives a render that throws", async () => {
    const scheduler = createWarmScheduler();

    scheduler.submit({
      key: "voice-a",
      run: () => Promise.reject(new Error("elevenlabs said no")),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduler.runningCount()).toBe(0);
    expect(scheduler.deferredCount()).toBe(0);
  });
});
