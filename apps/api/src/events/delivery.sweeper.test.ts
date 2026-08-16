import type { LogFields, Logger } from "@ansa/shared";
import { describe, expect, it } from "vitest";

import { EventDeliverySweeper } from "./delivery.sweeper";

/**
 * What the log says while the database is unreachable, and when it comes back.
 *
 * Written after a laptop lost its network for four minutes and the sweeper wrote eighteen
 * identical `getaddrinfo ENOTFOUND` lines and then, on recovering, wrote nothing at all. It
 * had recovered — the sweep is inside a catch precisely so an outage is not a restart — but
 * the only way to establish that was to compare the last timestamp against the clock.
 *
 * Two properties: an outage costs one line, and coming back costs one line.
 */

interface Line {
  readonly level: string;
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

const recordingLog = (): { lines: Line[]; log: Logger } => {
  const lines: Line[] = [];
  const at = (level: string) => (message: string, fields?: LogFields) => {
    lines.push({ level, message, fields: { ...(fields ?? {}) } });
  };
  const log: Logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: () => log,
  };
  return { lines, log };
};

/**
 * A data source whose every query fails with `reason`, or succeeds when it is null.
 *
 * `claimDueEventDeliveries` is the sweeper's first call, so failing the query is the same
 * shape as the database being unreachable — which is what an ENOTFOUND actually is.
 */
const dbThatFails = (reason: () => string | null) =>
  ({
    query: async () => {
      const failure = reason();
      if (failure !== null) throw new Error(failure);
      return [];
    },
    createQueryRunner: () => ({
      connect: async () => undefined,
      startTransaction: async () => undefined,
      commitTransaction: async () => undefined,
      rollbackTransaction: async () => undefined,
      release: async () => undefined,
      isTransactionActive: true,
      manager: {},
      query: async () => {
        const failure = reason();
        if (failure !== null) throw new Error(failure);
        return [];
      },
    }),
  }) as never;

const sweeperOver = (reason: () => string | null) => {
  const recorder = recordingLog();
  const sweeper = new EventDeliverySweeper(
    dbThatFails(reason),
    { resolve: async () => null } as never,
    recorder.log,
  );
  return { sweeper, lines: recorder.lines };
};

const errors = (lines: readonly Line[]) => lines.filter((line) => line.level === "error");

describe("the sweeper during an outage", () => {
  it("writes one line for a hundred failed sweeps, not a hundred", async () => {
    const { sweeper, lines } = sweeperOver(() => "getaddrinfo ENOTFOUND db.example.test");
    for (let i = 0; i < 100; i += 1) await sweeper.sweep();

    /* Fifteen seconds apart, an hour of this is two hundred and forty identical lines and
       the next real failure is somewhere in the middle of them. */
    expect(errors(lines)).toHaveLength(1);
    expect(errors(lines)[0]?.fields["error"]).toContain("ENOTFOUND");
  });

  it("writes again when the reason changes, because that is news", async () => {
    let reason = "getaddrinfo ENOTFOUND db.example.test";
    const { sweeper, lines } = sweeperOver(() => reason);

    await sweeper.sweep();
    await sweeper.sweep();
    reason = "password authentication failed";
    await sweeper.sweep();

    // A second failure arriving during the first is a different problem, not a repeat.
    expect(errors(lines)).toHaveLength(2);
    expect(errors(lines)[1]?.fields["error"]).toContain("password");
  });

  it("says when it comes back, and how long it was out", async () => {
    let down = true;
    const { sweeper, lines } = sweeperOver(() => (down ? "getaddrinfo ENOTFOUND db" : null));

    for (let i = 0; i < 5; i += 1) await sweeper.sweep();
    down = false;
    await sweeper.sweep();

    /* Without this the log ends on an error and stays there, so "is it still broken" can
       only be answered against the clock. Deliveries queued while it was down are still
       due, so recovery means they go out. */
    const recovered = lines.filter((line) => line.message === "event delivery sweep recovered");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.fields["after"]).toBe(5);
  });

  it("says nothing on a healthy sweep that followed a healthy one", async () => {
    const { sweeper, lines } = sweeperOver(() => null);
    await sweeper.sweep();
    await sweeper.sweep();

    // Recovery is only news after a failure. A quiet sweeper stays quiet.
    expect(lines.filter((line) => line.message.includes("recovered"))).toHaveLength(0);
    expect(errors(lines)).toHaveLength(0);
  });

  it("never throws, so an outage is not a restart", async () => {
    const { sweeper } = sweeperOver(() => "getaddrinfo ENOTFOUND db");
    await expect(sweeper.sweep()).resolves.toMatchObject({ delivered: 0, failed: 0 });
  });
});
