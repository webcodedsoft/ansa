/**
 * When it is safe to render audio nobody is waiting for.
 *
 * Warming a voice is ~60 ElevenLabs round trips. Run while a call is up they compete with
 * the call for one event loop, and the carrier does not wait for us to catch up: Twilio
 * discards inbound media it cannot deliver rather than buffering it. A measured call lost
 * its first 6.6 seconds of caller audio to a warm that started at ingress and was still
 * running after the socket opened — the agent was rendering "Good afternoon." while the
 * caller was already talking.
 *
 * So the rule is that warming yields, and this owns it. It runs when nothing is on the
 * line, stops when something arrives, and picks up what it dropped once the last call
 * ends. What rendering *means* stays in the gateway; what is safe to run and when lives
 * here, where it can be tested without a WebSocket.
 *
 * The cost is that a voice nobody has used yet stays cold for the call that first needs
 * it, which falls back to live synthesis. That fallback has always existed and is far
 * cheaper than degrading the call that is actually happening.
 */

/**
 * A render, which must consult `keepGoing()` between batches and stop when it answers
 * false. Resolves true when it finished, false when it yielded with work left.
 */
export type WarmRun = (keepGoing: () => boolean) => Promise<boolean>;

export interface WarmJob {
  /** Identifies the voice, so two requests for it do not render it twice. */
  readonly key: string;
  readonly run: WarmRun;
}

export interface WarmScheduler {
  /** A media socket opened. Anything rendering should now stop at its next batch. */
  callStarted(): void;
  /** A media socket closed. When it was the last, deferred work resumes. */
  callEnded(): void;
  /** Render this, now if the line is quiet and later if it is not. */
  submit(job: WarmJob): void;
  /** For assertions and logging: jobs waiting for the line to go quiet. */
  deferredCount(): number;
  /** For assertions and logging: whether anything is rendering. */
  runningCount(): number;
}

export const createWarmScheduler = (): WarmScheduler => {
  let live = 0;
  const deferred = new Map<string, WarmJob>();
  const running = new Set<string>();

  const start = (job: WarmJob): void => {
    running.add(job.key);
    void job
      .run(() => live === 0)
      .then((finished) => {
        /* Unfinished work goes back on the queue rather than being dropped. Without this
           an interrupted warm looks complete for the life of the process, and the phrases
           it never reached are synthesised live on every call from then on. */
        if (!finished) deferred.set(job.key, job);
      })
      .catch(() => {
        // Never fatal: a voice that fails to warm is synthesised live, which is the
        // fallback anyway. Retrying here would spin against a broken vendor.
      })
      .finally(() => running.delete(job.key));
  };

  return {
    callStarted: () => {
      live += 1;
    },
    callEnded: () => {
      live = Math.max(0, live - 1);
      if (live > 0 || deferred.size === 0) return;
      const waiting = [...deferred.values()];
      deferred.clear();
      for (const job of waiting) start(job);
    },
    submit: (job) => {
      // Already rendering it, or already queued. Either way it is accounted for.
      if (running.has(job.key) || deferred.has(job.key)) return;
      if (live > 0) {
        deferred.set(job.key, job);
        return;
      }
      start(job);
    },
    deferredCount: () => deferred.size,
    runningCount: () => running.size,
  };
};
