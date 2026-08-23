import { describe, expect, it } from "vitest";

import { asCallId, asOrganizationId, type BusinessHours, type LogFields, type Logger } from "@ansa/shared";

import { createToolDispatcher, modelMessage } from "../dispatch";
import { createToolRegistry } from "../registry";
import { registerInternalTools } from "./adapter";
import {
  answerHours,
  CALL_CONTROL_DEFINITIONS,
  callControlTools,
  type CallControlOptions,
} from "./call-control";

const ORGANIZATION = asOrganizationId("11111111-1111-4111-8111-111111111111");
const CALL = asCallId("call-1");

const silent = (): Logger => {
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: (_fields: LogFields) => log,
  };
  return log;
};

/**
 * Wall-clock times are written as UTC and read as WAT throughout.
 *
 * 08:30Z is 09:30 WAT — the offset direction that `consent.ts` already depends on, and
 * the one an hour-out bug hides in. Written this way rather than with a local Date so the
 * test says the same thing on a machine in any timezone.
 */
const at = (iso: string): Date => new Date(iso);

/** 2026-08-03 was a Monday, so weekdays in these fixtures are stated, not assumed. */
const MONDAY = "2026-08-03";
const SATURDAY = "2026-08-08";
const SUNDAY = "2026-08-09";

const setup = (options: Partial<CallControlOptions> = {}) => {
  const ended: string[] = [];
  const registry = createToolRegistry();
  registerInternalTools(
    registry,
    callControlTools({
      endCall: (reason) => ended.push(reason),
      businessHours: null,
      ...options,
    }),
  );
  const dispatcher = createToolDispatcher({ registry, log: silent() });
  const call = (name: string, args: Record<string, unknown> = {}) =>
    dispatcher.dispatch({ organizationId: ORGANIZATION, callId: CALL, direction: "inbound", name, args });

  return { ended, registry, call };
};

describe("the platform tool set", () => {
  it("registers exactly the three tools the prompt is told about", () => {
    const { registry } = setup();

    expect(registry.listFor(ORGANIZATION).map((d) => d.name)).toEqual(
      CALL_CONTROL_DEFINITIONS.map((d) => d.name),
    );
  });

  it("registers no tool that could answer from data nobody has written", () => {
    const { registry } = setup();

    // The decision this test exists to hold: only non-data tools ship. A lookup tool
    // appearing here means something is answering a caller from a fixture.
    expect(registry.listFor(ORGANIZATION).map((d) => d.name).sort()).toEqual([
      "business_hours",
      "end_call",
      "transfer_to_human",
      // Also a non-data tool: it hands the call to a person, at a number the operator
      // configured, and answers nothing from a fixture.
      "transfer_urgently",
    ]);
  });

  it("registers every definition with a handler behind it", () => {
    // Construction throws rather than failing the first time a caller needs the tool.
    expect(() => callControlTools({ endCall: () => undefined, businessHours: null })).not.toThrow();
  });
});

describe("end_call", () => {
  it("asks for the call to end and says the goodbye comes first", async () => {
    const { call, ended } = setup();

    const outcome = await call("end_call", { reason: "the caller said goodbye" });

    expect(outcome.kind).toBe("ok");
    expect(ended).toEqual(["the caller said goodbye"]);
    expect(outcome.speech).toContain("said goodbye");
  });

  it("still ends the call when the model gives no reason", async () => {
    const { call, ended } = setup();

    await call("end_call", {});

    expect(ended).toHaveLength(1);
    expect(ended[0]).not.toBe("");
  });

  it("runs freely, with no confirmation in the way of a caller who is leaving", async () => {
    const { call } = setup();

    const outcome = await call("end_call", {});

    expect(outcome.kind).not.toBe("confirm");
    expect(outcome.tier).toBe("read");
  });
});

describe("transfer_to_human", () => {
  it("never executes and asks for a person instead", async () => {
    const { call } = setup();

    const outcome = await call("transfer_to_human", { reason: "the caller asked" });

    expect(outcome.kind).toBe("transfer");
    expect(outcome.tier).toBe("irreversible");
  });

  it("carries a reason for whoever picks up", async () => {
    const { call } = setup();

    const outcome = await call("transfer_to_human", {});

    expect(outcome.kind === "transfer" ? outcome.reason.length : 0).toBeGreaterThan(0);
  });

  it("tells the model it did not happen, so the next sentence cannot claim it did", async () => {
    const { call } = setup();

    const outcome = await call("transfer_to_human", {});

    expect(modelMessage(outcome)).toContain("NOT run");
  });
});

describe("business_hours", () => {
  const NINE_TO_FIVE: BusinessHours = {
    opensAtHour: 9,
    closesAtHour: 17,
    openDays: [1, 2, 3, 4, 5],
  };

  it("says it does not know when nobody has configured any", async () => {
    const { call } = setup({ businessHours: null });

    const outcome = await call("business_hours");

    expect(outcome.kind).toBe("ok");
    expect(outcome.speech).toContain("do not have the opening hours");
  });

  it("reads the clock in WAT, not in UTC", () => {
    // 08:30Z is 09:30 WAT, which is inside a 9-5 window. Read as UTC it would be closed.
    const answer = answerHours(NINE_TO_FIVE, at(`${MONDAY}T08:30:00Z`));

    expect(answer).toEqual({ known: true, open: true, closesAtHour: 17 });
  });

  it("is closed at 08:30 WAT, one hour before opening", () => {
    const answer = answerHours(NINE_TO_FIVE, at(`${MONDAY}T07:30:00Z`));

    expect(answer.known && answer.open).toBe(false);
  });

  it("closes on the exclusive hour", () => {
    // 16:00Z is 17:00 WAT. The window is [9, 17), so this is shut.
    const answer = answerHours(NINE_TO_FIVE, at(`${MONDAY}T16:00:00Z`));

    expect(answer.known && answer.open).toBe(false);
  });

  it("offers tomorrow when the day is over", () => {
    const answer = answerHours(NINE_TO_FIVE, at(`${MONDAY}T18:00:00Z`));

    expect(answer).toEqual({
      known: true,
      open: false,
      next: { hour: 9, weekday: 2, ahead: 1 },
    });
  });

  it("offers later today when the line has not opened yet", () => {
    const answer = answerHours(NINE_TO_FIVE, at(`${MONDAY}T05:00:00Z`));

    expect(answer).toEqual({
      known: true,
      open: false,
      next: { hour: 9, weekday: 1, ahead: 0 },
    });
  });

  it("skips the closed days rather than promising a Sunday", () => {
    // Saturday evening on a Monday-to-Friday week: the next opening is Monday.
    const answer = answerHours(NINE_TO_FIVE, at(`${SATURDAY}T12:00:00Z`));

    expect(answer).toEqual({
      known: true,
      open: false,
      next: { hour: 9, weekday: 1, ahead: 2 },
    });
  });

  /**
   * Parameterised, because a rota that only works for one shape is a rota that will be
   * wrong for the second organization. None of these values appears in a branch.
   */
  const ROTAS: readonly {
    readonly label: string;
    readonly hours: BusinessHours;
    readonly nowUtc: string;
    readonly open: boolean;
  }[] = [
    {
      label: "a seven-day support line, mid-morning",
      hours: { opensAtHour: 8, closesAtHour: 20, openDays: [1, 2, 3, 4, 5, 6, 7] },
      nowUtc: `${SUNDAY}T09:00:00Z`,
      open: true,
    },
    {
      label: "a seven-day support line, after close",
      hours: { opensAtHour: 8, closesAtHour: 20, openDays: [1, 2, 3, 4, 5, 6, 7] },
      nowUtc: `${SUNDAY}T19:30:00Z`,
      open: false,
    },
    {
      label: "a weekend-only line, on a Saturday",
      hours: { opensAtHour: 10, closesAtHour: 14, openDays: [6, 7] },
      nowUtc: `${SATURDAY}T10:00:00Z`,
      open: true,
    },
    {
      label: "a weekend-only line, on a Monday",
      hours: { opensAtHour: 10, closesAtHour: 14, openDays: [6, 7] },
      nowUtc: `${MONDAY}T10:00:00Z`,
      open: false,
    },
    {
      label: "a single-hour clinic slot, inside it",
      hours: { opensAtHour: 13, closesAtHour: 14, openDays: [3] },
      nowUtc: "2026-08-05T12:30:00Z",
      open: true,
    },
    {
      label: "a round-the-clock line at 3am",
      hours: { opensAtHour: 0, closesAtHour: 24, openDays: [1, 2, 3, 4, 5, 6, 7] },
      nowUtc: `${MONDAY}T02:00:00Z`,
      open: true,
    },
  ];

  for (const rota of ROTAS) {
    it(`is ${rota.open ? "open" : "closed"} for ${rota.label}`, () => {
      const answer = answerHours(rota.hours, at(rota.nowUtc));

      expect(answer.known && answer.open).toBe(rota.open);
    });
  }

  const BAD: readonly { readonly label: string; readonly hours: BusinessHours }[] = [
    { label: "no open days", hours: { opensAtHour: 9, closesAtHour: 17, openDays: [] } },
    { label: "closing before opening", hours: { opensAtHour: 17, closesAtHour: 9, openDays: [1] } },
    { label: "an overnight window", hours: { opensAtHour: 22, closesAtHour: 2, openDays: [1] } },
    { label: "a zero-length window", hours: { opensAtHour: 9, closesAtHour: 9, openDays: [1] } },
    { label: "an hour off the clock", hours: { opensAtHour: 9, closesAtHour: 25, openDays: [1] } },
    { label: "a weekday off the week", hours: { opensAtHour: 9, closesAtHour: 17, openDays: [9] } },
    { label: "a fractional hour", hours: { opensAtHour: 9.5, closesAtHour: 17, openDays: [1] } },
  ];

  for (const bad of BAD) {
    it(`refuses to guess at ${bad.label}`, () => {
      // Configuration is a database row, so it is input. Answering "closed" on a bad row
      // would turn a typo into a caller being told to ring back tomorrow.
      expect(answerHours(bad.hours, at(`${MONDAY}T10:00:00Z`))).toEqual({ known: false });
    });
  }

  it("speaks a sentence and never a stringified object", async () => {
    const { call } = setup({
      businessHours: NINE_TO_FIVE,
      now: () => at(`${MONDAY}T10:00:00Z`),
    });

    const outcome = await call("business_hours");

    expect(outcome.kind).toBe("ok");
    expect(outcome.speech.startsWith("{")).toBe(false);
    expect(outcome.speech).toContain("open now");
    expect(outcome.speech).toContain("5:00 pm");
  });

  it("names midnight and noon rather than saying twelve", async () => {
    const { call } = setup({
      businessHours: { opensAtHour: 12, closesAtHour: 24, openDays: [1, 2, 3, 4, 5, 6, 7] },
      now: () => at(`${MONDAY}T05:00:00Z`),
    });

    const outcome = await call("business_hours");

    expect(outcome.speech).toContain("noon");
  });

  it("tells a closed caller when to ring back", async () => {
    const { call } = setup({
      businessHours: NINE_TO_FIVE,
      now: () => at(`${SATURDAY}T12:00:00Z`),
    });

    const outcome = await call("business_hours");

    expect(outcome.speech).toContain("closed");
    expect(outcome.speech).toContain("Monday");
    expect(outcome.speech).toContain("9:00 am");
  });
});
