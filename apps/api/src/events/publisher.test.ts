import { asCallId, asOrganizationId } from "@ansa/shared";
import {
  NO_EVENTS,
  type EventSubscription,
  type PreparedEvents,
} from "@ansa/tools";
import { describe, expect, it, vi } from "vitest";

import { createCallFacts } from "../conversation/call-facts";
import type { CallRecorder } from "../telephony/event-log";

import { withEventPublisher } from "./publisher";

const ORGANIZATION = asOrganizationId("11111111-1111-4111-8111-111111111111");
const CALL = "CA-test-1";

const silentLog = () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return log;
};

/** withOrganization drives a transaction, so the fake has to honour that shape. */
const fakeDb = () => {
  const inserted: { sql: string; params: readonly unknown[] }[] = [];
  const run = async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("insert into event_deliveries")) inserted.push({ sql, params });
    return [{ id: `row-${inserted.length}` }];
  };
  return {
    inserted,
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

/** Counts what reached the real recorder, so the tee can be proved transparent. */
const countingRecorder = () => {
  const calls: string[] = [];
  const recorder: CallRecorder = {
    started: () => calls.push("started"),
    event: (kind) => calls.push(`event:${kind}`),
    transcript: () => calls.push("transcript"),
    turn: () => calls.push("turn"),
    ended: () => calls.push("ended"),
  };
  return { calls, recorder };
};

const subscription = (name: string): EventSubscription => ({
  name,
  url: "https://hooks.example.test/ansa",
  events: ["call.ended", "call.transferred"],
  signingSecretRef: "hook",
  timeoutMs: 10_000,
  maxAttempts: 8,
});

const preparedWith = (...subscriptions: EventSubscription[]): PreparedEvents => ({
  transport: { send: async () => ({ status: 204, headers: {}, body: "" }) },
  subscribersTo: () =>
    subscriptions.map((s) => ({
      subscription: s,
      signer: { sign: () => "x", toJSON: () => "[redacted]", toString: () => "[redacted]" },
      credential: null,
    })),
  empty: false,
});

const identity = {
  callId: CALL,
  direction: "inbound" as const,
  dialled: "+2340000000",
  caller: "+2341111111",
  startedAt: new Date(0).toISOString(),
  configVersion: 4,
};

const publisherOver = (
  inner: CallRecorder,
  events: PreparedEvents,
  db: ReturnType<typeof fakeDb>,
  facts = createCallFacts({ organizationId: ORGANIZATION, callId: asCallId(CALL), callDirection: "inbound" }),
) => ({
  facts,
  recorder: withEventPublisher(inner, {
    dataSource: db.ds as never,
    log: silentLog() as never,
    organizationId: ORGANIZATION,
    events,
    call: identity,
    facts: () => facts.facts,
    journal: () => [],
    callerNumber: identity.caller,
  }),
});

const settle = () => new Promise((r) => setTimeout(r, 20));

const bodyOf = (db: ReturnType<typeof fakeDb>, index = 0): Record<string, unknown> =>
  JSON.parse(String(db.inserted[index]?.params[5])) as Record<string, unknown>;

describe("nothing happens unless a organization configured a receiver", () => {
  it("returns the recorder untouched when no receiver is configured", () => {
    const { recorder } = countingRecorder();
    const db = fakeDb();
    const wrapped = withEventPublisher(recorder, {
      dataSource: db.ds as never,
      log: silentLog() as never,
      organizationId: ORGANIZATION,
      events: NO_EVENTS,
      call: identity,
      facts: () => null,
      journal: () => [],
      callerNumber: null,
    });
    expect(wrapped).toBe(recorder);
  });

  it("returns the recorder untouched when there is no database to queue into", () => {
    const { recorder } = countingRecorder();
    const wrapped = withEventPublisher(recorder, {
      dataSource: null,
      log: silentLog() as never,
      organizationId: ORGANIZATION,
      events: preparedWith(subscription("crm")),
      call: identity,
      facts: () => null,
      journal: () => [],
      callerNumber: null,
    });
    expect(wrapped).toBe(recorder);
  });
});

describe("the call path only ever writes a row", () => {
  it("passes every recorder call straight through", async () => {
    const inner = countingRecorder();
    const db = fakeDb();
    const { recorder } = publisherOver(inner.recorder, preparedWith(subscription("crm")), db);

    recorder.started({
      organizationId: ORGANIZATION,
      carrierCallId: CALL,
      direction: "inbound",
      dialled: "+234",
      caller: null,
      configVersion: 4,
    });
    recorder.event("agent said", { text: "Good afternoon." }, 10);
    recorder.transcript({ text: "hello", confidence: 0.9, offsetMs: 20, provider: "test" });
    recorder.turn({ seq: 1, speaker: "caller", startedOffsetMs: 0, endedOffsetMs: 5, bargedInAtMs: null });
    recorder.ended("caller hung up", null, 12);
    await settle();

    expect(inner.calls).toEqual([
      "started",
      "event:agent said",
      "transcript",
      "turn",
      "ended",
    ]);
  });

  it("does not throw or reject when the insert fails", async () => {
    const inner = countingRecorder();
    const exploding = {
      query: async () => {
        throw new Error("database is on fire");
      },
      createQueryRunner: () => ({
        connect: async () => {
          throw new Error("database is on fire");
        },
        startTransaction: async () => undefined,
        commitTransaction: async () => undefined,
        rollbackTransaction: async () => undefined,
        release: async () => undefined,
        isTransactionActive: false,
        manager: {},
        query: async () => {
          throw new Error("database is on fire");
        },
      }),
    };
    const recorder = withEventPublisher(inner.recorder, {
      dataSource: exploding as never,
      log: silentLog() as never,
      organizationId: ORGANIZATION,
      events: preparedWith(subscription("crm")),
      call: identity,
      facts: () => null,
      journal: () => [],
      callerNumber: null,
    });

    expect(() => recorder.ended("caller hung up", null, 3)).not.toThrow();
    await settle();
    // The call still ended, as far as everything that matters is concerned.
    expect(inner.calls).toEqual(["ended"]);
  });

  it("queues one call.ended and no more, however often the call is closed", async () => {
    const inner = countingRecorder();
    const db = fakeDb();
    const { recorder } = publisherOver(inner.recorder, preparedWith(subscription("crm")), db);

    recorder.ended("caller hung up", null, 12);
    // The carrier's status callback arrives after the media stream already closed.
    recorder.ended("completed", "completed", 13);
    await settle();

    expect(db.inserted).toHaveLength(1);
  });
});

describe("the payload", () => {
  it("carries the conversation in order, with both speakers", async () => {
    const db = fakeDb();
    const { recorder } = publisherOver(countingRecorder().recorder, preparedWith(subscription("crm")), db);

    recorder.event("agent said", { text: "Good afternoon." }, 100);
    recorder.transcript({ text: "I want my renewal date", confidence: 0.8, offsetMs: 50, provider: "t" });
    recorder.event("tool_call", { tool: "policy_lookup", outcome: "ok" }, 300);
    recorder.ended("caller hung up", null, 30);
    await settle();

    const body = bodyOf(db);
    expect(body.event).toBe("call.ended");
    const transcript = body.transcript as { speaker: string; text: string }[];
    expect(transcript.map((line) => line.speaker)).toEqual(["caller", "agent"]);
    expect(body.actions).toEqual([{ name: "policy_lookup", outcome: "ok" }]);
    expect(body.transferredToHuman).toBe(false);
  });

  it("marks an identifier the caller never confirmed", async () => {
    const db = fakeDb();
    const facts = createCallFacts({
      organizationId: ORGANIZATION,
      callId: asCallId(CALL),
      callDirection: "inbound",
    });
    facts.observe({ field: "policyNumber", value: "RT-88213", source: "stt", atMs: 1 });
    facts.observe({ field: "callerName", value: "Ngozi Abara", source: "caller-confirmation", atMs: 2 });

    const { recorder } = publisherOver(
      countingRecorder().recorder,
      preparedWith(subscription("crm")),
      db,
      facts,
    );
    recorder.ended("caller hung up", null, 30);
    await settle();

    const identifiers = bodyOf(db).identifiers as Record<string, { value: string; confirmed: boolean }>;
    expect(identifiers.policyNumber).toEqual({
      value: "RT-88213",
      confirmed: false,
      status: "UNCERTAIN",
    });
    expect(identifiers.callerName?.confirmed).toBe(true);
  });

  it("says it was handed to a person when it was", async () => {
    const db = fakeDb();
    const { recorder } = publisherOver(countingRecorder().recorder, preparedWith(subscription("crm")), db);

    recorder.event("handoff_transferred", { reason: "asked-for-a-person" });
    recorder.ended("transferred", null, 30);
    await settle();

    expect(db.inserted).toHaveLength(2);
    expect(bodyOf(db, 0).event).toBe("call.transferred");
    const ended = bodyOf(db, 1);
    expect(ended.event).toBe("call.ended");
    expect(ended.transferredToHuman).toBe(true);
  });
});

/**
 * What leaves the process, now that R5.2.4 is withdrawn.
 *
 * These tests used to prove the opposite — that two receivers of one organisation could be
 * sent different bytes, and that an identifier heard one way and settled another was masked
 * in both forms. That whole capability was removed on 2026-08-15. What is worth keeping is
 * the boundary: the caller's data goes complete, and secret material still never goes.
 */
describe("payloads leave complete", () => {
  it("sends the organisation its own data complete", async () => {
    const db = fakeDb();
    const { recorder } = publisherOver(countingRecorder().recorder, preparedWith(subscription("crm")), db);

    recorder.transcript({ text: "my number is 08031234567", confidence: 0.9, offsetMs: 1, provider: "t" });
    recorder.ended("caller hung up", null, 30);
    await settle();

    expect(String(db.inserted[0]?.params[5])).toContain("08031234567");
  });

  it("gives two receivers of the same organisation identical bytes", async () => {
    const db = fakeDb();
    const facts = createCallFacts({
      organizationId: ORGANIZATION,
      callId: asCallId(CALL),
      callDirection: "inbound",
    });
    facts.observe({ field: "policyNumber", value: "QX7K2M", source: "dtmf", atMs: 1 });

    const { recorder } = publisherOver(
      countingRecorder().recorder,
      preparedWith(subscription("crm"), subscription("analytics")),
      db,
      facts,
    );
    recorder.transcript({ text: "it is QX7K2M on 08031234567", confidence: 0.9, offsetMs: 1, provider: "t" });
    recorder.ended("caller hung up", null, 30);
    await settle();

    expect(db.inserted).toHaveLength(2);
    const crm = String(db.inserted[0]?.params[5]);
    const analytics = String(db.inserted[1]?.params[5]);

    // There is no longer any rule that could make these differ. Asserted rather than
    // assumed, because a delivery still stores its own body and the two must not drift.
    expect(crm).toBe(analytics);
    expect(crm).toContain("QX7K2M");
    expect(crm).toContain("08031234567");
  });

  it("carries an identifier in every form the transcript holds", async () => {
    const db = fakeDb();
    const facts = createCallFacts({
      organizationId: ORGANIZATION,
      callId: asCallId(CALL),
      callDirection: "inbound",
    });
    // Heard one way, settled another. Both are in the transcript and both stay.
    facts.observe({ field: "policyNumber", value: "RT 88213", source: "stt", atMs: 1 });
    facts.observe({ field: "policyNumber", value: "RT-88213", source: "dtmf", atMs: 2 });

    const { recorder } = publisherOver(
      countingRecorder().recorder,
      preparedWith(subscription("analytics")),
      db,
      facts,
    );
    recorder.transcript({ text: "RT 88213, or was it RT-88213", confidence: 0.7, offsetMs: 1, provider: "t" });
    recorder.ended("caller hung up", null, 30);
    await settle();

    const sent = String(db.inserted[0]?.params[5]);
    expect(sent).toContain("RT 88213");
    expect(sent).toContain("RT-88213");
  });
});
