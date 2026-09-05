import type { DueCall } from "@ansa/db";
import { asOrganizationId } from "@ansa/shared";
import { describe, expect, it, vi } from "vitest";

import { sweepOrganization } from "./dialer";
import { ConsentError } from "./place";

/* The dialler's decisions are pure; what is not pure is the database around them. Rather than
   stand a database up, the two functions that decide — whether a failure earns another attempt,
   and whether a refusal ever does — are exercised through `sweepOrganization` with the database
   calls stubbed. What is being asserted is the policy, which is the part that would hurt
   somebody if it were wrong. */
const { claimed, recorded, reset } = vi.hoisted(() => {
  const claimed: string[] = [];
  const recorded: { id: string; status: string; outcome: string | null; next: Date | null }[] = [];
  return {
    claimed,
    recorded,
    reset: (): void => {
      claimed.length = 0;
      recorded.length = 0;
    },
  };
});

let dueRows: DueCall[] = [];
let claimSucceeds = true;

vi.mock("@ansa/db", () => ({
  withOrganization: async <T>(_ds: unknown, _org: unknown, work: (scope: unknown) => Promise<T>) =>
    work({}),
  readDueScheduledCalls: async () => dueRows,
  claimScheduledCall: async (_scope: unknown, id: string) => {
    claimed.push(id);
    return claimSucceeds;
  },
  recordAttempt: async (
    _scope: unknown,
    id: string,
    result: { status: string; outcome?: string | null; nextAttemptAt?: Date | null },
  ) => {
    recorded.push({
      id,
      status: result.status,
      outcome: result.outcome ?? null,
      next: result.nextAttemptAt ?? null,
    });
    return true;
  },
}));


const ORG = asOrganizationId("d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1");
const NOW = new Date("2026-09-07T10:00:00Z");

const due = (over: Partial<DueCall> = {}): DueCall =>
  ({
    id: "row-1",
    campaignId: "cp-1",
    contactId: "ct-1",
    phone: "+2348030000001",
    displayName: null,
    status: "pending",
    attempts: 0,
    nextAttemptAt: NOW,
    lastAttemptAt: null,
    outcome: null,
    callId: null,
    facts: null,
    fromNumber: "+2348148592625",
    createdAt: NOW,
    updatedAt: NOW,
    campaignPurpose: "to confirm your viewing",
    campaignOpening: null,
    campaignOutcomes: null,
    campaignFlow: null,
    campaignVoicemail: null,
    callingWindow: null,
    maxAttempts: 3,
    retryAfterMinutes: 240,
    ...over,
  }) as DueCall;

const silent = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

const run = async (rows: DueCall[], place: () => Promise<{ callId: string | null }>) => {
  reset();
  dueRows = rows;
  claimSucceeds = true;
  return sweepOrganization(
    {
      dataSource: {} as never,
      log: silent() as never,
      place,
      organizationsWithWork: async () => [ORG],
      now: () => NOW,
    },
    ORG,
  );
};

describe("what the dialler does with a refusal", () => {
  it("never retries one", async () => {
    /* A number on the do-not-call list is not a transient failure. "Try again in four hours"
       applied to a suppression is the exact behaviour the suppression exists to prevent. */
    const report = await run([due()], async () => {
      throw new ConsentError("number is on the do-not-call list");
    });

    expect(report).toMatchObject({ placed: 0, suppressed: 1, failed: 0 });
    expect(recorded[0]).toMatchObject({
      status: "suppressed",
      outcome: "number is on the do-not-call list",
      next: null,
    });
  });

  it("records why, so the row says what refused it", async () => {
    await run([due()], async () => {
      throw new ConsentError("outside calling hours (21:00 WAT, allowed 8-20)");
    });
    expect(recorded[0]?.outcome).toContain("outside calling hours");
  });
});

describe("what it does with a failure", () => {
  it("tries again later, once, and not sooner than the campaign said", async () => {
    const report = await run([due({ attempts: 0, maxAttempts: 3, retryAfterMinutes: 240 })], async () => {
      throw new Error("carrier rejected the call");
    });

    expect(report).toMatchObject({ placed: 0, suppressed: 0, failed: 1 });
    expect(recorded[0]?.next).toEqual(new Date("2026-09-07T14:00:00Z"));
  });

  it("gives up when the attempt that just failed was the last one", async () => {
    /* `attempts` was incremented by the claim, so 2 here means this call was the third. */
    await run([due({ attempts: 2, maxAttempts: 3 })], async () => {
      throw new Error("no answer");
    });
    expect(recorded[0]).toMatchObject({ status: "failed", next: null });
  });
});

describe("what it does when the call goes out", () => {
  it("records the call it placed against the row", async () => {
    const report = await run([due()], async () => ({ callId: "call-77" }));

    expect(report).toMatchObject({ considered: 1, placed: 1 });
    expect(recorded[0]).toMatchObject({ status: "answered", next: null });
  });

  it("claims before it dials, so two sweeps cannot both place the same call", async () => {
    reset();
    dueRows = [due()];
    claimSucceeds = false;
    const place = vi.fn();

    const report = await sweepOrganization(
      {
        dataSource: {} as never,
        log: silent() as never,
        place: place as never,
        organizationsWithWork: async () => [ORG],
        now: () => NOW,
      },
      ORG,
    );

    expect(claimed).toEqual(["row-1"]);
    expect(place).not.toHaveBeenCalled();
    expect(report).toMatchObject({ considered: 1, placed: 0 });
  });

  it("keeps going when one row in the batch fails", async () => {
    let first = true;
    const report = await run([due({ id: "a" }), due({ id: "b" })], async () => {
      if (first) {
        first = false;
        throw new Error("carrier hiccup");
      }
      return { callId: "call-2" };
    });

    expect(report).toMatchObject({ considered: 2, placed: 1, failed: 1 });
  });
});

describe("what it refuses to dial at all", () => {
  it("will not ring from a number that does not exist", async () => {
    /* The caller ID has to be a number the person can ring back. A call from nowhere is the
       shape of a nuisance call whatever is said on it — and no amount of waiting gives an
       agent a number, so it is terminal rather than retried. */
    const place = vi.fn();
    reset();
    dueRows = [due({ fromNumber: null })];
    claimSucceeds = true;

    const report = await sweepOrganization(
      {
        dataSource: {} as never,
        log: silent() as never,
        place: place as never,
        organizationsWithWork: async () => [ORG],
        now: () => NOW,
      },
      ORG,
    );

    expect(place).not.toHaveBeenCalled();
    expect(report).toMatchObject({ suppressed: 1, placed: 0 });
    expect(recorded[0]).toMatchObject({ status: "suppressed", next: null });
    expect(recorded[0]?.outcome).toContain("no number to call from");
  });
});
