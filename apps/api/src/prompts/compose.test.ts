import { describe, expect, it } from "vitest";

import { BASE_CONDUCT, identityLine } from "./base";
import { composeSystemPrompt, DEFAULT_SYSTEM_PROMPT } from "./compose";
import { ENFORCED_IN_CODE, GUARANTEES_LAYER } from "./guarantees";
import { LOCALE_LAYER } from "./locale";
import { compileTenantLayer } from "./tenant-layer";

const layerFor = (persona: string | null, instructions: string | null = null) =>
  compileTenantLayer({ name: "Kano General Insurance", persona, instructions });

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
      "The line is 8kHz and the transcription is imperfect.",
      "Never invent a reference number, an amount, a date or a name.",
      "If someone asks directly whether you're an AI, say yes. Always.",
    ]) {
      expect(DEFAULT_SYSTEM_PROMPT).toContain(line);
    }
  });

  it("names no example word, name or identifier in the layers every tenant shares", () => {
    // A model given a sample reaches for it. The old prompt listed five insurance terms
    // and the ordinary words they come back as, which is the same mechanism that made a
    // keyterm list corrupt an unrelated surname 3/3 on Deepgram — one level up the stack.
    // Domain vocabulary belongs in the tenant's layer and in per-tenant keyterms.
    const shared = composeSystemPrompt({ tenant: null, tools: [] });
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
    const prompt = composeSystemPrompt({ tenant: layerFor("Warm, not chatty.").layer, tools: [] });
    const at = (needle: string) => prompt.indexOf(needle);

    expect(at(identityLine("Kano General Insurance"))).toBe(0);
    expect(at(BASE_CONDUCT)).toBeGreaterThan(0);
    expect(at(LOCALE_LAYER)).toBeGreaterThan(at(BASE_CONDUCT));
    expect(at("Warm, not chatty.")).toBeGreaterThan(at(LOCALE_LAYER));
    // The guarantees are last, after the tenant's own words, on purpose.
    expect(at(GUARANTEES_LAYER)).toBeGreaterThan(at("Warm, not chatty."));
  });

  it("still carries every guarantee when a tenant has configured a persona", () => {
    const prompt = composeSystemPrompt({
      tenant: layerFor("Very brief. Nigerian English. Get them off the line fast.").layer,
      tools: [],
    });
    for (const guarantee of ENFORCED_IN_CODE) {
      if (guarantee.spoken !== null) expect(prompt).toContain(guarantee.spoken);
    }
  });

  it("names the organisation instead of 'a company in Nigeria'", () => {
    const prompt = composeSystemPrompt({ tenant: layerFor(null).layer, tools: [] });
    expect(prompt).toContain("You're Ansa, answering the phone for Kano General Insurance.");
  });

  it("does not open an empty fence when a tenant configured nothing", () => {
    const prompt = composeSystemPrompt({ tenant: layerFor(null).layer, tools: [] });
    // An organisation block with nothing in it reads as an instruction to invent rules.
    expect(prompt).not.toContain("--- end");
  });

  it("tells the agent it cannot look anything up while no tools are registered", () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("You can't look anything up on this call.");
  });

  it("describes a registered tool and what its risk tier will do to it", () => {
    const prompt = composeSystemPrompt({
      tenant: null,
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
