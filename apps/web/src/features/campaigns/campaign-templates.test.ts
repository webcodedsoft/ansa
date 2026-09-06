import { CAMPAIGN_LIMITS } from "@ansa/shared";
import { validateFlow } from "@ansa/shared/flow-validate";
import { describe, expect, it } from "vitest";

import { flowFromTemplate } from "@/features/agents/flow.schema";

import { CAMPAIGN_SECTORS, CAMPAIGN_TEMPLATES, campaignTemplateById } from "./campaign-templates";

/**
 * Every template is held to one standard: pick it, name the campaign, add people, start.
 *
 * If a template's conversation fails the validator that Start runs, the campaign it makes
 * cannot start, and the operator finds out on the day they meant to ring people. So every
 * one is drawn as the graph it describes and put through the same validator, and every one's
 * brief is held to the same caps the API enforces. A template that needs fixing before it
 * works is not a template, it is homework.
 */

const each = CAMPAIGN_TEMPLATES.map((template) => [template.id, template] as const);

describe("the campaign catalogue", () => {
  it("has unique ids and a sector on every template", () => {
    const ids = CAMPAIGN_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of CAMPAIGN_TEMPLATES) expect(CAMPAIGN_SECTORS).toContain(template.sector);
  });

  it("is findable by id, and says null for an id it does not hold", () => {
    expect(campaignTemplateById("viewing-confirmation")?.name).toBe("Viewing confirmation");
    expect(campaignTemplateById("nope")).toBeNull();
  });

  it.each(each)("%s stays within the brief's caps", (_, template) => {
    expect(template.purpose.length).toBeLessThanOrEqual(CAMPAIGN_LIMITS.purposeLength);
    if (template.opening !== null) {
      expect(template.opening.length).toBeLessThanOrEqual(CAMPAIGN_LIMITS.openingLength);
    }
    expect(template.outcomes.length).toBeLessThanOrEqual(CAMPAIGN_LIMITS.outcomes);
    for (const outcome of template.outcomes) {
      expect(outcome.length).toBeLessThanOrEqual(CAMPAIGN_LIMITS.outcomeLength);
    }
    expect(template.maxAttempts).toBeGreaterThanOrEqual(CAMPAIGN_LIMITS.attempts.min);
    expect(template.maxAttempts).toBeLessThanOrEqual(CAMPAIGN_LIMITS.attempts.max);
    expect(template.retryAfterMinutes).toBeGreaterThanOrEqual(CAMPAIGN_LIMITS.retryMinutes.min);
    expect(template.retryAfterMinutes).toBeLessThanOrEqual(CAMPAIGN_LIMITS.retryMinutes.max);
  });

  it.each(each)("%s reads as the tail of \"I'm calling…\"", (_, template) => {
    /* The agent says "I'm calling" and then this, in one breath. "just to check" and "ahead
       of your stay" are as much the tail of that sentence as "to confirm" is; what is refused
       is a capital letter or a noun phrase, which produces "I'm calling. We wanted to…" —
       the sound of a script being read. */
    expect(template.purpose).toMatch(/^(to|because|with|about|following|ahead of|just|on behalf of)\b/);
    expect(template.purpose.endsWith(".")).toBe(false);
  });

  it.each(each)("%s names every fact its purpose uses, and no others", (_, template) => {
    /* The placeholders are what a list has to carry. A purpose that uses `{amount}` on a
       template that does not declare it would read the braces out loud to every person on
       the list — and a declared fact nothing uses is a column somebody imports for nothing. */
    const used = new Set(
      [...`${template.purpose} ${template.opening ?? ""}`.matchAll(/\{([^{}]+)\}/g)]
        .map((match) => match[1])
        // `{name}` and `{organisation}` are always known and never a fact the list carries.
        .filter((key) => key !== "name" && key !== "organisation"),
    );
    const declared = new Set(template.facts.map((fact) => fact.key));
    expect([...used].sort()).toEqual([...declared].sort());
  });

  it.each(each)("%s has verdicts that are distinct and short enough to say", (_, template) => {
    expect(new Set(template.outcomes).size).toBe(template.outcomes.length);
    expect(template.outcomes.length).toBeGreaterThan(0);
  });

  it.each(each)("%s draws a conversation the Start gate would let through", (_, template) => {
    if (template.conversation === null) return;
    const flow = flowFromTemplate(template.conversation);
    const blocking = validateFlow(flow).filter((problem) => problem.blocking);
    expect(blocking, blocking.map((problem) => problem.message).join("\n")).toEqual([]);
  });

  it.each(each)("%s forks only on a choice it asked", (_, template) => {
    /* A branch on a key nobody asked is a fork with no way to decide it. The validator reports
       it structurally, but this says which template and why, which is what somebody editing
       one needs. */
    const conversation = template.conversation;
    if (conversation === null || conversation.branch === undefined) return;
    const asked = conversation.fields.find((field) => field.key === conversation.branch?.on);
    expect(asked, `branch on "${conversation.branch.on}" but no such question`).toBeDefined();
    expect(asked?.type).toBe("choice");
    for (const arm of Object.keys(conversation.branch.arms)) {
      expect(asked?.options, `arm "${arm}" is not one of the choice's options`).toContain(arm);
    }
  });

  it("keeps money and medicine off the answerphone", () => {
    /* The one rule every template must agree on. An amount owed, a clinic's name, a claim's
       stage: none of it belongs on a machine that plays out loud in a room. The templates
       whose rationale says so must also say so in their setting. */
    const privateOnes = [
      // money
      "rent-reminder", "loan-repayment", "school-fees", "service-charge", "premium-due",
      "bill-overdue", "savings-maturity", "dormant-account",
      // medicine
      "appointment-reminder", "results-ready", "medication-refill", "post-discharge",
      "immunisation-due",
      // anything else that is somebody's private business
      "claim-status", "claim-documents", "exam-results", "document-signing", "tax-deadline",
      "consultation-followup", "complaint-followup", "suspicious-activity", "sim-swap-check",
      "kyc-update", "welfare-check", "lease-renewal", "quote-followup",
    ];
    for (const id of privateOnes) {
      expect(campaignTemplateById(id)?.voicemail, id).toBe("hang_up");
    }
  });

  it("never asks a caller for anything the outbound rules forbid", () => {
    /* `prompts/outbound.ts` forbids asking for a card number, a PIN, a code, a date of birth
       or an ID on a call we placed. No template's conversation may ask for one, because a
       template is exactly the place such a question would be typed in good faith. */
    const forbidden = /\b(pin|otp|one[- ]time|card number|cvv|bvn|nin|date of birth|password)\b/i;
    for (const template of CAMPAIGN_TEMPLATES) {
      if (template.conversation === null) continue;
      const fields = [
        ...template.conversation.fields,
        ...Object.values(template.conversation.branch?.arms ?? {}).flatMap((arm) => arm.fields),
      ];
      for (const field of fields) {
        expect(field.prompt, `${template.id}: "${field.prompt}"`).not.toMatch(forbidden);
        expect(["otp", "nin", "bvn"], `${template.id} captures ${field.type}`).not.toContain(field.type);
      }
    }
  });
});
