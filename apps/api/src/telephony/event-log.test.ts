import { describe, expect, it, vi } from "vitest";

import { asOrganizationId } from "@ansa/shared";

import { createCallRecorder, nullRecorder } from "./event-log";

const ORGANIZATION = asOrganizationId("11111111-1111-4111-8111-111111111111");

const silentLog = () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return log;
};

/** withOrganization drives a transaction, so the fake has to honour that shape. */
const fakeDb = (onQuery: (sql: string) => unknown = () => []) => {
  const seen: string[] = [];
  const run = async (sql: string) => {
    seen.push(sql);
    return onQuery(sql);
  };
  return {
    seen,
    ds: {
      query: run,
      createQueryRunner: () => ({
        connect: async () => undefined,
        startTransaction: async () => undefined,
        commitTransaction: async () => undefined,
        rollbackTransaction: async () => undefined,
        release: async () => undefined,
        isTransactionActive: true,
        manager: {},
        query: run,
      }),
    },
  };
};

const started = {
  organizationId: ORGANIZATION,
  carrierCallId: "CA1",
  direction: "outbound" as const,
  dialled: "+234",
  caller: "+1",
  configVersion: 2,
};

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("call recorder", () => {
  it("does nothing at all without a database", () => {
    const r = createCallRecorder({ dataSource: null, log: silentLog() as never });
    expect(r).toBe(nullRecorder);
    // Must be safe to call regardless: the call path cannot care which it has.
    expect(() => {
      r.started(started);
      r.event("anything");
      r.ended("done");
    }).not.toThrow();
  });

  it("never throws when the database is broken", async () => {
    // The one property that outranks everything this module stores. A caller is
    // mid-conversation and a database hiccup is not their problem.
    const log = silentLog();
    const db = fakeDb(() => {
      throw new Error("connection reset");
    });
    const r = createCallRecorder({ dataSource: db.ds as never, log: log as never });

    expect(() => {
      r.started(started);
      for (let i = 0; i < 40; i += 1) r.event("turn", { i });
      r.ended("carrier sent stop");
    }).not.toThrow();

    await settle();
    // Swallowed, but never silently: this is the one place where swallowing is correct.
    expect(log.error).toHaveBeenCalled();
  });

  it("keeps events that happened before the call row existed", async () => {
    // The first seconds are the ones worth having. Dropping them because the insert had
    // not returned yet would lose the greeting and the first caller turn on every call.
    let resolveInsert: (v: unknown) => void = () => undefined;
    const db = fakeDb((sql) =>
      sql.includes("insert into calls")
        ? new Promise((res) => { resolveInsert = res; })
        : [],
    );
    const r = createCallRecorder({ dataSource: db.ds as never, log: silentLog() as never });

    r.started(started);
    r.event("conversation started");
    r.event("agent turn played");

    // withOrganization runs set_config before the insert, so the chain has to get there before
    // there is anything to resolve.
    await settle();
    resolveInsert([{ id: "row-1" }]);
    await settle();

    const inserts = db.seen.filter((s) => s.includes("insert into call_events"));
    expect(inserts).toHaveLength(1);
    // Both, in one statement.
    expect(inserts[0]).toContain("($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)");
  });

  it("batches rather than paying a round trip per event", async () => {
    const db = fakeDb((sql) => (sql.includes("insert into calls") ? [{ id: "row-1" }] : []));
    const r = createCallRecorder({ dataSource: db.ds as never, log: silentLog() as never });
    r.started(started);
    await settle();

    for (let i = 0; i < 25; i += 1) r.event("latency", { i });
    await settle();

    // Twenty-five events, one insert. A round trip to Ohio is a fifth of a second and
    // the recorder must never be on the conversation's critical path.
    expect(db.seen.filter((s) => s.includes("insert into call_events"))).toHaveLength(1);
  });

  it("flushes what is buffered when the call ends", async () => {
    const db = fakeDb((sql) => (sql.includes("insert into calls") ? [{ id: "row-1" }] : []));
    const r = createCallRecorder({ dataSource: db.ds as never, log: silentLog() as never });
    r.started(started);
    await settle();

    r.event("caller said", { text: "hello" });
    r.ended("carrier sent stop", "completed", 37);
    await settle();

    expect(db.seen.some((s) => s.includes("insert into call_events"))).toBe(true);
    expect(db.seen.some((s) => s.includes("update calls"))).toBe(true);
  });

  it("stops accumulating when the call row never appeared", async () => {
    // A failed insert must not turn into unbounded memory growth for the whole call.
    const db = fakeDb((sql) => {
      if (sql.includes("insert into calls")) throw new Error("nope");
      return [];
    });
    const r = createCallRecorder({ dataSource: db.ds as never, log: silentLog() as never });
    r.started(started);
    for (let i = 0; i < 5_000; i += 1) r.event("noise", { i });
    await settle();

    expect(() => r.ended("done")).not.toThrow();
  });

  it("writes final transcripts to their own table", async () => {
    const db = fakeDb((sql) => (sql.includes("insert into calls") ? [{ id: "row-1" }] : []));
    const r = createCallRecorder({ dataSource: db.ds as never, log: silentLog() as never });
    r.started(started);
    await settle();

    r.transcript({ text: "my policy number", confidence: 0.82, offsetMs: 1200, provider: "openai" });
    r.ended("carrier sent stop");
    await settle();

    // Its own table, not an event: corrected_text sits beside it, and that pair is the
    // R9.2 loop.
    expect(db.seen.some((s) => s.includes("insert into transcripts"))).toBe(true);
  });

  it("does not lose a transcript when the event buffer is empty", async () => {
    // flush() used to return early on an empty event buffer, which would have stranded
    // every transcript on a call that produced no other events.
    const db = fakeDb((sql) => (sql.includes("insert into calls") ? [{ id: "row-1" }] : []));
    const r = createCallRecorder({ dataSource: db.ds as never, log: silentLog() as never });
    r.started(started);
    await settle();

    r.transcript({ text: "hello", confidence: null, offsetMs: 0, provider: "openai" });
    r.ended("done");
    await settle();

    expect(db.seen.some((s) => s.includes("insert into transcripts"))).toBe(true);
  });

  it("writes stage timings to their own table as well as to the event log", async () => {
    /* Both, deliberately. The event log keeps this call's story; `latencies` keeps the bare
       number where a range across a week can index it. The recorder is the join: two writes
       off one `measure()` cannot drift, two measurements would. */
    const db = fakeDb((sql) => (sql.includes("insert into calls") ? [{ id: "row-1" }] : []));
    const r = createCallRecorder({ dataSource: db.ds as never, log: silentLog() as never });
    r.started(started);
    await settle();

    r.event("latency", { stage: "turn_to_audio", ms: 740, seq: 2 });
    r.latency({ stage: "turn_to_audio", ms: 740, provider: null });
    r.ended("carrier sent stop");
    await settle();

    expect(db.seen.some((q) => q.includes("insert into latencies"))).toBe(true);
    expect(db.seen.some((q) => q.includes("insert into call_events"))).toBe(true);
  });

  it("survives a latency write failing", async () => {
    // Same rule as every other write here: the caller is mid-conversation and a broken
    // metrics table is not their problem.
    const log = silentLog();
    const db = fakeDb((sql) => {
      if (sql.includes("insert into calls")) return [{ id: "row-1" }];
      if (sql.includes("insert into latencies")) throw new Error("relation gone");
      return [];
    });
    const r = createCallRecorder({ dataSource: db.ds as never, log: log as never });
    r.started(started);
    await settle();

    expect(() => {
      r.latency({ stage: "llm_first_token", ms: 310, provider: null });
      r.ended("done");
    }).not.toThrow();
    await settle();
    expect(log.error).toHaveBeenCalled();
  });

  it("survives a transcript write failing", async () => {
    const log = silentLog();
    const db = fakeDb((sql) => {
      if (sql.includes("insert into calls")) return [{ id: "row-1" }];
      if (sql.includes("insert into transcripts")) throw new Error("column gone");
      return [];
    });
    const r = createCallRecorder({ dataSource: db.ds as never, log: log as never });
    r.started(started);
    await settle();

    expect(() => {
      r.transcript({ text: "x", confidence: null, offsetMs: 0, provider: "openai" });
      r.ended("done");
    }).not.toThrow();
    await settle();
    expect(log.error).toHaveBeenCalled();
  });

  it("closes a call that ended before its row existed", async () => {
    // Found by driving the real recorder against the real database, not by a unit test:
    // the ending was dropped outright and the row stayed open forever. Every other test
    // here awaited the insert first, which is the kindness that hid it.
    let resolveInsert: (v: unknown) => void = () => undefined;
    const db = fakeDb((sql) =>
      sql.includes("insert into calls")
        ? new Promise((res) => { resolveInsert = res; })
        : [],
    );
    const r = createCallRecorder({ dataSource: db.ds as never, log: silentLog() as never });

    r.started(started);
    r.event("conversation started");
    r.ended("carrier sent stop", "completed", 37);

    await settle();
    resolveInsert([{ id: "row-1" }]);
    await settle();

    const update = db.seen.find((s) => s.includes("update calls"));
    expect(update, "the call was never closed").toBeDefined();
  });
});
