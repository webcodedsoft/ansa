import { describe, expect, it } from "vitest";

import { asOrganizationId } from "@ansa/shared";

import { renderSummary, speakSummary, summarise, type LoggedEvent } from "./summary";

const ORGANIZATION = asOrganizationId("11111111-1111-1111-1111-111111111111");

const event = (
  kind: string,
  detail: Record<string, unknown> = {},
  offsetMs: number | null = null,
): LoggedEvent => ({ kind, detail, offsetMs });

const of = (events: readonly LoggedEvent[], escalation?: string) =>
  summarise({
    organizationId: ORGANIZATION,
    carrierCallId: "CA1",
    callerNumber: "+2348138178550",
    events,
    ...(escalation === undefined ? {} : { escalation }),
  });

describe("summarise", () => {
  it("carries the name the caller confirmed, not the ones they rejected", () => {
    // The live call this is taken from: TK was offered and rejected, the caller corrected
    // to Kim Woo, and that was confirmed.
    const summary = of([
      event("caller said", { text: "My name is TK" }),
      event("entity_candidate", { subject: "name", value: "TK" }),
      event("caller said", { text: "No, my name is Kim Woo" }),
      event("entity_candidate", { subject: "name", value: "Kim Woo" }),
      event("caller said", { text: "Yes that is right" }),
      event("value confirmed", { chars: 7 }),
    ]);

    expect(summary.callerName).toBe("Kim Woo");
    expect(summary.confirmed).toHaveLength(1);
  });

  it("never reports a candidate the caller did not agree to as confirmed", () => {
    const summary = of([
      event("caller said", { text: "My policy is A B four one seven" }),
      event("entity_candidate", { subject: "number", value: "AB417" }),
      event("confirmation_requested", { subject: "number", attempt: 1 }),
      event("caller said", { text: "No" }),
    ]);

    expect(summary.confirmed).toHaveLength(0);
    // Still reported, so the person can ask about it rather than starting from nothing.
    expect(summary.unconfirmed[0]?.value).toBe("AB417");
    expect(renderSummary(summary)).toContain("UNCONFIRMED");
  });

  it("pairs a confirmation with the candidate it confirms, by length", () => {
    // Two entities in one call. The confirmation must not attach to the wrong one.
    const summary = of([
      event("entity_candidate", { subject: "name", value: "Ada" }),
      event("value confirmed", { chars: 3 }),
      event("entity_candidate", { subject: "number", value: "AB4179" }),
      event("value confirmed", { chars: 6 }),
    ]);

    expect(summary.confirmed.map((v) => v.value)).toEqual(["Ada", "AB4179"]);
  });

  it("takes a keypad value straight, since the keypad has no readback", () => {
    // Keypad tones are unambiguous, so capture confirms without offering a candidate.
    const summary = of([event("value confirmed", { subject: "number", value: "417820" })]);
    expect(summary.confirmed[0]?.value).toBe("417820");
  });

  it("reports why they rang, skipping the pleasantries", () => {
    const summary = of([
      event("caller said", { text: "Hello" }),
      event("caller said", { text: "Good afternoon, can you hear me" }),
      event("caller said", { text: "I want to renew my motor policy before it lapses" }),
      event("caller said", { text: "Yes" }),
    ]);

    expect(summary.reason).toBe("I want to renew my motor policy before it lapses");
    // The last thing they said is what is still open.
    expect(summary.unresolved).toBe("Yes");
  });

  it("falls back to the first turn when every turn is short", () => {
    const summary = of([event("caller said", { text: "Hello" })]);
    expect(summary.reason).toBe("Hello");
  });

  it("records what the assistant actually did, and what failed", () => {
    const summary = of([
      event("tool_result", { name: "search_knowledge_base", outcome: "ok", summary: "found 2" }),
      event("tool_result", { name: "verify_caller", outcome: "timeout" }),
    ]);

    expect(summary.actions).toHaveLength(2);
    expect(renderSummary(summary)).toContain("verify_caller — timeout");
  });

  it("ignores the noise a call produces by the hundred", () => {
    const summary = of([
      event("latency", { stage: "tts_first_byte", ms: 300 }),
      event("stt_partial", { chars: 12 }),
      event("barge-in", { reason: "caller interrupted" }),
      event("caller said", { text: "I need to change my address please" }),
    ]);

    expect(summary.callerTurns).toBe(1);
    expect(summary.actions).toHaveLength(0);
  });

  it("names the trigger, and falls back to the capture escalation already logged", () => {
    expect(of([], "the caller asked for a person").escalation).toBe(
      "the caller asked for a person",
    );
    expect(of([event("escalated to a human", { text: "..." })]).escalation).toContain("capture");
  });

  it("survives a call with nothing in it", () => {
    const summary = of([]);
    expect(summary.callerName).toBeNull();
    expect(summary.reason).toBeNull();
    expect(renderSummary(summary)).toContain("name not established");
  });
});

describe("speakSummary", () => {
  const spoken = () =>
    speakSummary(
      of(
        [
          event("caller said", { text: "I want to check my policy renewal date" }),
          event("entity_candidate", { subject: "name", value: "Kim Woo" }),
          event("value confirmed", { chars: 7 }),
          event("entity_candidate", { subject: "number", value: "417820" }),
          event("value confirmed", { chars: 6 }),
        ],
        "the caller asked for a person",
      ),
    );

  it("tells the person who is calling and what they want", () => {
    const line = spoken();
    expect(line).toContain("Kim Woo");
    expect(line).toContain("policy renewal date");
    expect(line).toContain("the caller asked for a person");
  });

  it("says what is already confirmed, so nobody asks twice", () => {
    // The whole point. A caller who spent four minutes spelling their name must not be
    // asked for it again.
    expect(spoken()).toContain("Already confirmed");
  });

  it("speaks a reference digit by digit rather than as a quantity", () => {
    // The carrier's own text-to-speech is still text-to-speech: "417820" unnormalized is
    // read as four hundred and seventeen thousand.
    const line = spoken();
    expect(line).toContain("four one seven");
    expect(line).toContain("eight two oh");
    expect(line).not.toContain("417820");
  });

  it("warns about unconfirmed details instead of stating them as fact", () => {
    const line = speakSummary(
      of([
        event("entity_candidate", { subject: "number", value: "AB417" }),
        event("caller said", { text: "No that is not it" }),
      ]),
    );
    expect(line).toContain("never confirmed");
    // Never spoken as though it were established.
    expect(line).not.toContain("Already confirmed");
  });

  it("stays short enough that the caller is not left waiting", () => {
    // Whoever picks up has a live caller on the other side of this.
    const words = spoken().split(/\s+/).filter((w) => w.length > 0).length;
    expect(words).toBeLessThan(70);
  });
});
