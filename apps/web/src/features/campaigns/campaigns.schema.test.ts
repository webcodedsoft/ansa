import { describe, expect, it } from "vitest";

import { callingWindowSchema, createCampaignSchema, paceSchema } from "./campaigns.schema";

const AGENT = "11111111-1111-4111-8111-111111111111";

const errorsOn = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }, field: string) =>
  result.success ? [] : (result.error?.issues ?? []).filter((issue) => issue.path[0] === field);

/**
 * This schema is not a copy of the API's rules — the API clamps the window to 08:00–20:00 WAT
 * and checks agent ownership. These are the few shapes worth catching before a round trip, so
 * the API's own refusal has a field to land on when it says no anyway.
 */
describe("the calling window", () => {
  it("takes a sane window and sorts and dedupes its days", () => {
    const result = callingWindowSchema.safeParse({
      startHour: 9,
      endHour: 17,
      weekdays: [3, 1, 1, 5],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.weekdays).toEqual([1, 3, 5]);
  });

  it("refuses a window that ends before it starts", () => {
    const result = callingWindowSchema.safeParse({ startHour: 18, endHour: 9, weekdays: [1] });
    expect(errorsOn(result, "endHour").length).toBeGreaterThan(0);
  });

  it("refuses a window with no days", () => {
    const result = callingWindowSchema.safeParse({ startHour: 9, endHour: 17, weekdays: [] });
    expect(errorsOn(result, "weekdays").length).toBeGreaterThan(0);
  });

  it("holds the hours to their bounds", () => {
    expect(callingWindowSchema.safeParse({ startHour: -1, endHour: 17, weekdays: [1] }).success).toBe(false);
    expect(callingWindowSchema.safeParse({ startHour: 9, endHour: 25, weekdays: [1] }).success).toBe(false);
  });
});

describe("creating a campaign", () => {
  it("needs a name and a real agent id", () => {
    const named = createCampaignSchema.safeParse({ name: "", agentId: AGENT });
    expect(errorsOn(named, "name").length).toBeGreaterThan(0);

    const agent = createCampaignSchema.safeParse({ name: "Follow-up", agentId: "not-a-uuid" });
    expect(errorsOn(agent, "agentId").length).toBeGreaterThan(0);
  });

  it("accepts a campaign with no window — the API applies the default", () => {
    const result = createCampaignSchema.safeParse({ name: "Follow-up", agentId: AGENT });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.callingWindow).toBeUndefined();
  });
});

describe("the pace", () => {
  const id = "0b6c97e2-b3f8-493f-81a2-1d0cff42d42f";

  it("reads an empty box as no cap, not as zero", () => {
    /* A form posts "" for an untouched number input. Coercing that to 0 would produce a cap
       the API refuses; null is what "no cap" is on the wire. */
    const parsed = paceSchema.safeParse({ campaignId: id, maxConcurrentCalls: "", maxCallsPerHour: "" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.maxConcurrentCalls).toBeNull();
      expect(parsed.data.maxCallsPerHour).toBeNull();
    }
  });

  it("takes the numbers as typed, and holds them to the shared bounds", () => {
    const ok = paceSchema.safeParse({ campaignId: id, maxConcurrentCalls: "2", maxCallsPerHour: "30" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toMatchObject({ maxConcurrentCalls: 2, maxCallsPerHour: 30 });

    const zero = paceSchema.safeParse({ campaignId: id, maxConcurrentCalls: "0", maxCallsPerHour: "" });
    expect(zero.success).toBe(false);
    const flood = paceSchema.safeParse({ campaignId: id, maxConcurrentCalls: "", maxCallsPerHour: "5000" });
    expect(flood.success).toBe(false);
  });
});
