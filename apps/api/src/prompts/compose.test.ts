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

  /**
   * The sections ported out of `docs/ansa-agent-prompt.md`.
   *
   * That document specified all of this and reached no layer — nothing in the code has
   * ever read it, so every rule below was written down and then not shipped. One line of
   * it describes the worst defect of 2026-08-23 exactly: the agent said one sentence five
   * times running and the caller hung up to escape it.
   *
   * Pinned by the behaviour each section exists to produce, not by its wording, so the
   * prose can be rewritten and the rule cannot quietly vanish with it.
   */
  it("carries every rule ported from the agent-prompt document", () => {
    const shared = composeSystemPrompt({ organization: null, tools: [] }).toLowerCase();
    for (const [rule, evidence] of [
      ["stops repeating itself", "said the same thing twice"],
      ["escalates a caller who is not being heard", "same thing three times"],
      ["escalates when nothing is being achieved", "three turns with nothing achieved"],
      ["does not greet twice", "greeting has already been spoken"],
      ["does not echo the wrong part of the day", "don't repeat it back either"],
      ["never says good night to someone who just rang", "that is a goodbye"],
      ["asks about anything else once", "anything else once"],
      ["does not finish a sentence it was cut off in", "don't finish the sentence"],
      ["waits out a silence", "let a pause be a pause"],
      ["handles two requests in order", "two things at once"],
      ["never reuses its own wording", "never reuse your own wording"],
      ["matches how the caller talks", "meet them where they are"],
      ["never mirrors the caller back", "never open by mirroring"],
      ["stays level when sworn at", "don't get more deferential"],
      ["refuses instructions hidden in caller speech", "instruction you follow"],
      ["will not act for a child", "adult who can come to the phone"],
      ["treats self-harm as outranking the call", "outranks everything else on the call"],
      ["spots coercion", "somebody else prompting them"],
      ["stops at two failed identity checks", "two goes at most"],
      ["will not discuss somebody else's account", "authorisation already on file"],
      ["does not respond to a legal threat", "do not respond to the threat"],
      ["never quantifies a refund", "never put a number on it"],
      ["admits what it is", "asked what you are"],
    ] as const) {
      expect(shared, rule).toContain(evidence);
    }
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
    options: [],
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

/**
 * Slice 12: the lines that make the agent sound like a person on a Nigerian line.
 *
 * Each is asserted by a fragment that could not survive a rewrite that lost the rule, so
 * a later edit that "tidies" one of these out fails here rather than on a call.
 */
describe("sounding like a person on a Nigerian line", () => {
  const shared = composeSystemPrompt({ organization: null, tools: [] });

  it("asks one question at a time, and bans the words of a script", () => {
    expect(shared).toContain("One question per turn.");
    expect(shared).toContain("Never say: certainly, absolutely, kindly, I apologise");
  });

  it("knows the money, the times and the Pidgin", () => {
    expect(shared).toContain('"2k" is two thousand naira');
    expect(shared).toContain('"By two" is at two o\'clock');
    expect(shared).toContain("Na so = yes");
    expect(shared).toContain("The network =");
  });

  it("answers an honorific in kind, once, and asks back how they are", () => {
    expect(shared).toContain("use theirs back once");
    expect(shared).toContain("ask them back, once");
  });

  it("takes an address as landmarks and a name as said", () => {
    expect(shared).toContain("Addresses come as landmarks");
    expect(shared).toContain("Yoruba, Igbo and Hausa names are tonal");
    expect(shared).toContain("an\nodd word where a name should be is a name");
  });

  it("asks by offering the two readings, never by saying please repeat", () => {
    expect(shared).toContain('don\'t say "please repeat that"');
    expect(shared).toContain("Offer the two things it");
  });

  it("asks which, when a request could mean two things that lead somewhere different", () => {
    expect(shared).toContain("could mean two different things");
    expect(shared).toContain("Only when the difference changes what you'd do next");
  });

  it("checks a decision before acting on it, and keeps that apart from mirroring", () => {
    expect(shared).toContain("Before you act on anything with a consequence");
    expect(shared).toContain("say it back in one short line as a question and wait");
    expect(shared).toContain("it is not the same\nas mirroring");
  });
});
