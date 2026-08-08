import { describe, expect, it, vi } from "vitest";

import { asCallId, asTenantId, createLogger } from "@ansa/shared";
import type { TransferRequest } from "@ansa/telephony";

import type { CallRecorder } from "../telephony/event-log";
import { createHandoff, WHISPER_PATH } from "./handoff";
import { withHandoffJournal } from "./journal";
import type { LoggedEvent } from "./summary";
import { createWhisperRegistry } from "./whisper";

const TENANT = asTenantId("22222222-2222-2222-2222-222222222222");

const silentLog = () => {
  const log = createLogger();
  return { ...log, info: () => undefined, warn: () => undefined, error: () => undefined,
    debug: () => undefined, child: () => silentLog() };
};

const recorder = () => {
  const events: { kind: string; detail: Record<string, unknown> }[] = [];
  const record: CallRecorder = {
    started: () => undefined,
    event: (kind, detail) => {
      events.push({ kind, detail: (detail ?? {}) as Record<string, unknown> });
    },
    transcript: () => undefined,
    turn: () => undefined,
    ended: () => undefined,
  };
  return { record, events, kinds: () => events.map((e) => e.kind) };
};

const setup = (
  options: {
    transfer?: (request: TransferRequest) => Promise<void>;
    destination?: { to: string; from: string; ringSeconds: number } | null;
    events?: readonly LoggedEvent[];
    /** null means "nowhere the carrier can reach us", which is a cold transfer. */
    whisperBaseUrl?: string | null;
  } = {},
) => {
  const said: string[] = [];
  const transferToNumber = vi.fn<(request: TransferRequest) => Promise<void>>(
    options.transfer ?? (async () => undefined),
  );
  const hangUp = vi.fn();
  const log = recorder();
  const whisper = createWhisperRegistry();

  const handoff = createHandoff({
    telephony: { transferToNumber },
    callId: asCallId("CA1"),
    tenantId: TENANT,
    callerNumber: "+2348138178550",
    destination:
      options.destination === undefined
        ? { to: "+2348000000001", from: "+18148592625", ringSeconds: 25 }
        : options.destination,
    events: () => options.events ?? [],
    record: log.record,
    log: silentLog(),
    say: async (text) => {
      said.push(text);
    },
    hangUp,
    whisper,
    ...(options.whisperBaseUrl === null
      ? {}
      : { whisperBaseUrl: options.whisperBaseUrl ?? "https://ansa.test" }),
    sayTimeoutMs: 50,
  });

  return { handoff, said, transferToNumber, hangUp, log, whisper };
};

const ASKED = { kind: "asked-for-a-person", detail: "the caller asked for a person" } as const;

describe("escalate", () => {
  it("tells the caller before it dials, not after", async () => {
    const s = setup();
    await s.handoff.escalate(ASKED);

    // The transfer replaces the carrier instruction, which ends the media stream this
    // sentence plays through. Queued audio would simply be deleted.
    expect(s.said).toHaveLength(1);
    expect(s.said[0]).toContain("put you through");
    expect(s.transferToNumber).toHaveBeenCalledOnce();
  });

  it("matches the line to why the caller is going", async () => {
    const failed = setup();
    await failed.handoff.escalate({ kind: "capture-failed", detail: "could not get details" });
    // A caller the assistant failed must not be told "of course" as though they had asked.
    expect(failed.said[0]).toContain("colleague");

    const stuck = setup();
    await stuck.handoff.escalate({ kind: "repeated-misunderstanding", detail: "three turns" });
    expect(stuck.said[0]).toContain("not getting this right");

    const barred = setup();
    await barred.handoff.escalate({ kind: "needs-a-person", detail: "an irreversible change" });
    // Not "I cannot reach that": nothing was unreachable, the assistant is not allowed to
    // do it, and a caller can hear the difference.
    expect(barred.said[0]).toContain("not something I can do myself");
    expect(barred.said[0]).not.toContain("cannot reach");
  });

  it("hands the person answering a summary of what is already established", async () => {
    const s = setup({
      events: [
        { kind: "caller said", detail: { text: "I want to renew my motor policy" }, offsetMs: 1 },
        { kind: "entity_candidate", detail: { subject: "name", value: "Kim Woo" }, offsetMs: 2 },
        { kind: "value confirmed", detail: { chars: 7 }, offsetMs: 3 },
      ],
    });
    await s.handoff.escalate(ASKED);

    const url = s.transferToNumber.mock.calls[0]?.[0]?.whisperUrl ?? "";
    expect(url).toContain(WHISPER_PATH);

    // Single use, and the token is the only credential.
    const token = url.slice(url.lastIndexOf("/") + 1);
    const line = s.whisper.take(token);
    expect(line).toContain("Kim Woo");
    expect(line).toContain("renew my motor policy");
    expect(s.whisper.take(token)).toBeNull();
  });

  it("writes the summary to the event log before it dials", async () => {
    const s = setup({
      events: [{ kind: "caller said", detail: { text: "I need my renewal date" }, offsetMs: 1 }],
    });
    await s.handoff.escalate(ASKED);

    // After the instruction is replaced the media stream is gone, and so is any chance to
    // write down what was handed over.
    expect(s.log.kinds()).toEqual(["handoff_started", "handoff_transferred"]);
    expect(String(s.log.events[0]?.detail["summary"])).toContain("renewal date");
  });

  it("asks the carrier to say something if nobody answers", async () => {
    const s = setup();
    await s.handoff.escalate(ASKED);

    // A document that ends at the dial hangs up on a caller already failed once.
    const request = s.transferToNumber.mock.calls[0]?.[0];
    expect(request?.noAnswerLine).toBeTruthy();
    expect(request?.ringSeconds).toBe(25);
  });

  it("says so and hangs up when there is nowhere to transfer to", async () => {
    const s = setup({ destination: null });
    await s.handoff.escalate(ASKED);

    // Today the agent says a line and transfers nowhere. Still a dead end, but the caller
    // is told and the log can be searched for it.
    expect(s.said[0]).toContain("cannot put you through");
    expect(s.transferToNumber).not.toHaveBeenCalled();
    expect(s.log.kinds()).toContain("handoff_unavailable");
    expect(s.hangUp).toHaveBeenCalledOnce();
  });

  it("apologises out loud when the carrier refuses", async () => {
    const s = setup({
      transfer: async () => {
        throw new Error("callerId is not a Twilio number");
      },
    });
    await s.handoff.escalate(ASKED);

    // The instruction was not replaced, so the caller is still on our stream and can be
    // told the truth. This is why transferToNumber rejects rather than swallowing.
    expect(s.said[1]).toContain("could not connect you");
    expect(s.log.kinds()).toContain("handoff_failed");
    expect(s.hangUp).toHaveBeenCalledOnce();
  });

  it("transfers cold, and records that it was cold, with no reachable url", async () => {
    const s = setup({ whisperBaseUrl: null });
    await s.handoff.escalate(ASKED);

    expect(s.transferToNumber.mock.calls[0]?.[0]?.whisperUrl).toBeUndefined();
    expect(s.log.events.at(-1)?.detail["withSummary"]).toBe(false);
  });

  it("only ever transfers once", async () => {
    const s = setup();
    await s.handoff.escalate(ASKED);
    await s.handoff.escalate({ kind: "tool-failed", detail: "lookup failed" });
    expect(s.transferToNumber).toHaveBeenCalledOnce();
  });

  it("goes anyway when the caller never acknowledges the line", async () => {
    const stalled = { ...setup(), said: [] as string[] };
    const transferToNumber = vi.fn<(request: TransferRequest) => Promise<void>>(
      async () => undefined,
    );
    const handoff = createHandoff({
      telephony: { transferToNumber },
      callId: asCallId("CA1"),
      tenantId: TENANT,
      callerNumber: null,
      destination: { to: "+2348000000001", from: "+1", ringSeconds: 25 },
      events: () => [],
      record: recorder().record,
      log: silentLog(),
      // A mark that never arrives must not strand a caller in silence forever.
      say: () => new Promise<void>(() => undefined),
      hangUp: () => undefined,
      whisper: createWhisperRegistry(),
      sayTimeoutMs: 10,
    });

    await handoff.escalate(ASKED);
    expect(transferToNumber).toHaveBeenCalledOnce();
    expect(stalled.said).toHaveLength(0);
  });
});

describe("withHandoffJournal", () => {
  it("keeps the events the summary needs and passes everything through", () => {
    const inner = recorder();
    const journal = withHandoffJournal(inner.record);

    journal.recorder.event("caller said", { text: "hello" });
    journal.recorder.event("latency", { stage: "tts_first_byte", ms: 300 });
    journal.recorder.event("entity_candidate", { subject: "name", value: "Ada" });

    // Everything still reaches the real recorder and so the real table.
    expect(inner.kinds()).toHaveLength(3);
    // The journal holds only what a handoff reads, so a long call's memory stays flat.
    expect(journal.events().map((e) => e.kind)).toEqual(["caller said", "entity_candidate"]);
  });

  it("drops old chatter before it drops a confirmed value", () => {
    const journal = withHandoffJournal(recorder().record);
    journal.recorder.event("entity_candidate", { subject: "name", value: "Ada" });
    journal.recorder.event("value confirmed", { chars: 3 });
    for (let i = 0; i < 500; i += 1) journal.recorder.event("caller said", { text: `turn ${i}` });

    // The name the caller spelled at minute one is the oldest event in the call and the
    // one a handoff must not lose.
    const kinds = journal.events().map((e) => e.kind);
    expect(kinds).toContain("entity_candidate");
    expect(kinds).toContain("value confirmed");
    expect(journal.events().length).toBeLessThanOrEqual(401);
  });
});

describe("createWhisperRegistry", () => {
  it("forgets a summary that was never collected", () => {
    let clock = 0;
    const registry = createWhisperRegistry({ ttlMs: 1000, now: () => clock });
    const token = registry.offer("a summary");
    clock = 1001;
    expect(registry.take(token)).toBeNull();
  });

  it("mints an unguessable token per transfer", () => {
    const registry = createWhisperRegistry();
    const a = registry.offer("one");
    const b = registry.offer("two");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
});
