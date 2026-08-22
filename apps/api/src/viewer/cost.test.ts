import type { CallRecord, MetricEvent } from "@ansa/db";
import { describe, expect, it } from "vitest";

import { priceUsage, readCostRates, usageOf, usageOverCalls } from "./cost";
import { scenario } from "../scenarios/harness";

/**
 * What a call cost, and what it is honest to say about it.
 *
 * Two things are being tested and they are different. That the arithmetic over the event
 * log is right, and that an unconfigured or half-configured deployment produces nothing
 * that could be mistaken for a price.
 */

const call = (events: readonly MetricEvent[], durationSeconds: number | null = 60): CallRecord => ({
  callId: "c",
  carrierCallId: "CA-cost",
  createdAt: "2026-01-01T00:00:00.000Z",
  direction: "inbound",
  configVersion: 1,
  endReason: "carrier sent stop",
  durationSeconds,
  callerTurns: 1,
  agentTurns: 1,
  events,
  reviewed: [],
  confidences: [],
});

const configured = (detail: Record<string, unknown>): MetricEvent => ({
  kind: "call configuration",
  detail,
});

describe("what a call used", () => {
  it("bills the whole call to the one provider that listened to it", () => {
    const usage = usageOf(call([configured({ listenProvider: "deepgram" })], 90));

    expect(usage.telephonySeconds).toBe(90);
    expect([...usage.listenSecondsByProvider]).toEqual([["deepgram", 90]]);
  });

  /**
   * R4.1.9. Two connections are open for the whole call and both are metered, whichever
   * one produced the words — that is the entire cost of the composition and the reason it
   * has to be visible per vendor rather than as one "listen" line.
   */
  it("bills both halves of a composite call separately", () => {
    const usage = usageOf(
      call(
        [configured({ listenProvider: "composite", listenWords: "openai", listenTurns: "deepgram" })],
        120,
      ),
    );

    expect(usage.listenSecondsByProvider.get("openai")).toBe(120);
    expect(usage.listenSecondsByProvider.get("deepgram")).toBe(120);
  });

  it("bills one vendor twice when it serves both roles, because two sessions are open", () => {
    const usage = usageOf(
      call(
        [configured({ listenProvider: "composite", listenWords: "deepgram", listenTurns: "deepgram" })],
        60,
      ),
    );

    expect(usage.listenSecondsByProvider.get("deepgram")).toBe(120);
  });

  it("counts a sentence re-synthesised after a failure as a second charge", () => {
    // Hiding the retry would understate the bill on exactly the calls that went worst.
    const usage = usageOf(
      call([
        { kind: "tts_start", detail: { seq: 2, chars: 40 } },
        { kind: "tts_failed", detail: { seq: 2, attempt: 0 } },
        { kind: "tts_start", detail: { seq: 2, chars: 40 } },
      ]),
    );

    expect(usage.ttsCharacters).toBe(80);
  });

  it("counts only the model's own turns, not readbacks and recovery lines", () => {
    const usage = usageOf(
      call([
        { kind: "llm_start", detail: { seq: 2, promptChars: 900 } },
        { kind: "agent said", detail: { seq: 2, text: "It renews in May.", action: "answer" } },
        // A readback and an apology cost a synthesis and no completion at all.
        { kind: "agent said", detail: { seq: 3, reason: "readback", text: "Four one seven?" } },
      ]),
    );

    expect(usage.llmTurns).toBe(1);
    expect(usage.llmPromptCharacters).toBe(900);
    expect(usage.llmReplyCharacters).toBe("It renews in May.".length);
  });

  it("says how many calls had no duration rather than treating them as zero", () => {
    const usage = usageOverCalls([call([], 30), call([], null)]);

    expect(usage.calls).toBe(2);
    expect(usage.telephonySeconds).toBe(30);
    expect(usage.callsWithoutDuration).toBe(1);
  });

  /**
   * The wiring, not the arithmetic.
   *
   * Every number above is read out of event details the orchestrator writes, so a rename
   * on either side would leave this file passing and the dashboard reading zero. Driving a
   * real conversation is the only way to catch that.
   */
  it("reads a real conversation's own event log", () => {
    const s = scenario();
    s.greetingPlays();
    s.says("When does my policy renew?");
    s.agentAnswers("It renews in May.");

    const usage = usageOf(s.asRecord());

    expect(usage.llmTurns).toBe(1);
    expect(usage.llmPromptCharacters).toBeGreaterThan(0);
    expect(usage.llmReplyCharacters).toBe("It renews in May.".length);
    // The greeting and the answer, both synthesised live in a scenario.
    expect(usage.ttsCharacters).toBeGreaterThan("It renews in May.".length);
  });
});

describe("what it is honest to charge for it", () => {
  const usage = usageOverCalls([
    call([
      configured({ listenProvider: "deepgram" }),
      { kind: "tts_start", detail: { chars: 2_000 } },
      { kind: "llm_start", detail: { promptChars: 1_000 } },
    ], 60),
  ]);

  it("reports units and no money at all when nothing is configured", () => {
    const cost = priceUsage(usage, readCostRates({}));

    expect(cost.lines.every((l) => l.amount === null)).toBe(true);
    expect(cost.total).toBeNull();
    // The quantities are still there. Not knowing the price of a minute is no reason not
    // to know how many minutes were used.
    expect(cost.lines.find((l) => l.label === "Telephony")?.quantity).toBe(60);
  });

  it("never invents a price for the model, however much is configured", () => {
    const cost = priceUsage(
      usage,
      readCostRates({
        COST_CURRENCY: "NGN",
        COST_TELEPHONY_PER_MINUTE: "10",
        COST_LISTEN_PER_MINUTE: "deepgram=5",
        COST_TTS_PER_1K_CHARACTERS: "3",
      }),
    );

    const model = cost.lines.find((l) => l.label === "Model");
    expect(model?.amount).toBeNull();
    expect(model?.note).toContain("tokens");
    // And because one line cannot be priced, neither can the total. A figure missing the
    // model looks like a number and is not one, and somebody will quote it.
    expect(cost.total).toBeNull();
  });

  it("prices the components it was given rates for", () => {
    const cost = priceUsage(
      usage,
      readCostRates({
        COST_CURRENCY: "NGN",
        COST_TELEPHONY_PER_MINUTE: "10",
        COST_LISTEN_PER_MINUTE: "deepgram=5",
        COST_TTS_PER_1K_CHARACTERS: "3",
      }),
    );

    expect(cost.currency).toBe("NGN");
    expect(cost.lines.find((l) => l.label === "Telephony")?.amount).toBeCloseTo(10);
    expect(cost.lines.find((l) => l.label === "Listen · deepgram")?.amount).toBeCloseTo(5);
    expect(cost.lines.find((l) => l.label === "Voice")?.amount).toBeCloseTo(6);
  });

  it("leaves a provider with no rate unpriced rather than free", () => {
    const cost = priceUsage(usage, readCostRates({ COST_LISTEN_PER_MINUTE: "openai=5" }));
    const listen = cost.lines.find((l) => l.label === "Listen · deepgram");

    expect(listen?.amount).toBeNull();
    expect(listen?.quantity).toBe(60);
    expect(listen?.note).toContain("no rate");
  });

  it("ignores a rate it cannot read instead of guessing at one", () => {
    const rates = readCostRates({
      COST_TELEPHONY_PER_MINUTE: "free",
      COST_LISTEN_PER_MINUTE: "deepgram=,openai=0.4,=9,malformed",
      COST_TTS_PER_1K_CHARACTERS: "-2",
    });

    expect(rates.telephonyPerMinute).toBeUndefined();
    expect(rates.ttsPer1kCharacters).toBeUndefined();
    expect([...rates.listenPerMinute]).toEqual([["openai", 0.4]]);
  });
});
