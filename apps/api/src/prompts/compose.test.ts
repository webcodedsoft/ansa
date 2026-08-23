import { describe, expect, it } from "vitest";

import { BASE_CONDUCT, identityLine } from "./base";
import type { CollectedField } from "../tenancy/captured-fields";
import { composeSystemPrompt, DEFAULT_SYSTEM_PROMPT } from "./compose";
import { ENFORCED_IN_CODE, GUARANTEES_LAYER } from "./guarantees";
import { LOCALE_LAYER } from "./locale";
import { compileOrganizationLayer } from "./organization-layer";

const layerFor = (persona: string | null, instructions: string | null = null) =>
  compileOrganizationLayer({ name: "Kano General Insurance", persona, instructions });

describe("the composition", () => {
  it("keeps every line of the prompt that was tuned on live calls", () => {
    // The old single prompt was split, not rewritten. If a line of it stopped being sent,
    // that is a behaviour change nobody asked for, and it would show up as a call getting
    // worse for no reason anyone could point at.
    for (const line of [
      "You're Ansa, answering the phone for a company in Nigeria.",
      "You're on a phone call, not in a chat. That changes everything:",
      "- Use contractions. I'll, you're, that's, don't — the way people actually talk.",
      "- One sentence. Two only if you truly cannot answer in one. Around 12 words.",
      "- Answer the question. Don't restate it back first.",
      "- Your words are spoken aloud. No lists, no bullet points, no markdown, no emoji,",
      "- Say numbers the way a Nigerian speaker says them out loud.",
      "- Reading back details? One item per turn.",
      "- Didn't catch it? Say so plainly and ask one short question.",
      // Added 2026-08-23 off calls where the caller's audio arrived in fragments: the
      // agent apologised three times running while the caller asked whether it was still
      // there. Both lines are here so neither can be dropped without a test saying so.
      "- Twice in a row and it isn't you, it's the line. Say that instead of apologising a",
      "— they think the call has dropped.",
      "The line is 8kHz and the transcription is imperfect.",
      "Never invent a reference number, an amount, a date or a name.",
      "If someone asks directly whether you're an AI, say yes. Always.",
    ]) {
      expect(DEFAULT_SYSTEM_PROMPT).toContain(line);
    }
  });

  it("names no example word, name or identifier in the layers every organization shares", () => {
    // A model given a sample reaches for it. The old prompt listed five insurance terms
    // and the ordinary words they come back as, which is the same mechanism that made a
    // keyterm list corrupt an unrelated surname 3/3 on Deepgram — one level up the stack.
    // Domain vocabulary belongs in the organization's layer and in per-organization keyterms.
    const shared = composeSystemPrompt({ organization: null, tools: [] });
    for (const instance of [
      "policy",
      "premium",
      "claim",
      "renewal",
      "penalty",
      "puppy",
      // Not "naira": the currency is a fact about the locale, which is what the locale
      // layer is for. The line the doc draws is between describing the place and
      // listing instances of a business's vocabulary.
      "Sikiru",
      "Ikeja",
    ]) {
      expect(shared.toLowerCase()).not.toContain(instance.toLowerCase());
    }
    // What the locale layer may still quote is the language itself. "Sorry" meaning
    // sympathy rather than apology is a fact about Nigerian English and a failure seen on
    // a real call — describing a dialect means quoting it, and that is not the same thing
    // as handing the model one business's words to reach for.
    expect(shared).toContain("\"Sorry?\" on its own means they didn't hear you.");
  });

  it("puts the layers in the order the design specifies", () => {
    const prompt = composeSystemPrompt({ organization: layerFor("Warm, not chatty.").layer, tools: [] });
    const at = (needle: string) => prompt.indexOf(needle);

    expect(at(identityLine("Kano General Insurance"))).toBe(0);
    expect(at(BASE_CONDUCT)).toBeGreaterThan(0);
    expect(at(LOCALE_LAYER)).toBeGreaterThan(at(BASE_CONDUCT));
    expect(at("Warm, not chatty.")).toBeGreaterThan(at(LOCALE_LAYER));
    // The guarantees are last, after the organization's own words, on purpose.
    expect(at(GUARANTEES_LAYER)).toBeGreaterThan(at("Warm, not chatty."));
  });

  it("still carries every guarantee when a organization has configured a persona", () => {
    const prompt = composeSystemPrompt({
      organization: layerFor("Very brief. Nigerian English. Get them off the line fast.").layer,
      tools: [],
    });
    for (const guarantee of ENFORCED_IN_CODE) {
      if (guarantee.spoken !== null) expect(prompt).toContain(guarantee.spoken);
    }
  });

  it("names the organisation instead of 'a company in Nigeria'", () => {
    const prompt = composeSystemPrompt({ organization: layerFor(null).layer, tools: [] });
    // Quoted, and added as a value rather than spliced into our sentence. See base.ts.
    expect(prompt).toContain('Its name is "Kano General Insurance".');
  });

  it("does not open an empty fence when a organization configured nothing", () => {
    const prompt = composeSystemPrompt({ organization: layerFor(null).layer, tools: [] });
    // An organisation block with nothing in it reads as an instruction to invent rules.
    expect(prompt).not.toContain("--- end");
  });

  it("tells the agent it cannot look anything up while no tools are registered", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("You can't look anything up on this call.");
  });

  it("describes a registered tool and what its risk tier will do to it", () => {
    const prompt = composeSystemPrompt({
      organization: null,
      tools: [
        { name: "policy_status", description: "current status of a policy", riskTier: "read" },
        { name: "cancel_policy", description: "cancels a policy", riskTier: "irreversible" },
      ],
    });
    expect(prompt).toContain("policy_status: current status of a policy (runs straight away)");
    expect(prompt).toContain("never by you — this one goes to a person");
    expect(prompt).not.toContain("You can't look anything up");
  });
});

/**
 * The voice form, in the prompt (migrations 0021, 0022).
 *
 * These assert the two things that make the feature real rather than decorative: the
 * operator's own wording reaches the model, and the capture route and confirmation are
 * stated rather than left to be inferred from it.
 */
describe("the collection section", () => {
  const field = (over: Partial<CollectedField> = {}): CollectedField => ({
    key: "policyNumber",
    type: "identifier",
    prompt: "Could you read me your policy number, one digit at a time?",
    capture: "keypad",
    confirm: "readback",
    required: true,
    pattern: "",
    attempts: 3,
    ...over,
  });

  it("says nothing at all when the agent has no form", () => {
    const prompt = composeSystemPrompt({ organization: null, tools: [], fields: [] });
    // Not an empty heading: a section title with nothing under it reads to a model as a
    // list it is expected to have, and inventing its contents is the obvious next step.
    expect(prompt).not.toContain("There are things you need from them");
  });

  it("carries the operator's own wording", () => {
    const prompt = composeSystemPrompt({ organization: null, tools: [], fields: [field()] });
    expect(prompt).toContain("Could you read me your policy number, one digit at a time?");
  });

  it("states the capture route rather than leaving it to be inferred", () => {
    const keyed = composeSystemPrompt({ organization: null, tools: [], fields: [field()] });
    expect(keyed).toContain("key it in on their phone");

    const spoken = composeSystemPrompt({
      organization: null,
      tools: [],
      fields: [field({ capture: "speech" })],
    });
    expect(spoken).toContain("ask them to say it");
  });

  it("tells the model a confirmed value is required before it acts", () => {
    const prompt = composeSystemPrompt({ organization: null, tools: [], fields: [field()] });
    expect(prompt).toContain("say it back to them and get a yes before you use it");
  });

  it("keeps the order the operator put them in, because that is the conversation", () => {
    const prompt = composeSystemPrompt({
      organization: null,
      tools: [],
      fields: [field({ key: "dateOfBirth" }), field({ key: "policyNumber" })],
    });
    expect(prompt.indexOf("dateOfBirth")).toBeLessThan(prompt.indexOf("policyNumber"));
  });

  it("still composes the guarantees after it", () => {
    const prompt = composeSystemPrompt({ organization: null, tools: [], fields: [field()] });
    // The form is in the task layer, so the non-negotiables still land last. A organization
    // cannot reach past them by writing a field, because they did not write this section.
    expect(prompt.indexOf("policyNumber")).toBeLessThan(prompt.lastIndexOf(GUARANTEES_LAYER));
  });
});
