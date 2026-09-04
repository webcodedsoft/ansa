import { describe, expect, it } from "vitest";

import type { CollectedField } from "../tenancy/captured-fields";

import { createForm, renderGuidance, type Guidance } from "./form";
import { FACT_FIELD_FOR } from "./orchestrator";

/**
 * The form director, and mostly its edges.
 *
 * The happy path — ask, answer, next — is two assertions. Everything else here is a case
 * that only shows up on a real call: a caller who answers a question nobody asked, two
 * fields the engine cannot tell apart, a value given after being declined. Those are what
 * turn into a caller asked the same thing twice, or an agent waiting forever on something
 * optional.
 */

const field = (over: Partial<CollectedField> = {}): CollectedField => ({
  key: "policyNumber",
  type: "reference",
  prompt: "What is your policy number?",
  capture: "speech",
  confirm: "readback",
  required: true,
  pattern: "",
  attempts: 3,
  options: [],
  ...over,
});

describe("an agent with no form", () => {
  /**
   * The most important case, because it is every agent that exists today. Adding a
   * director must not change a call that was already working, and an inert one is how
   * that holds.
   */
  it("asks for nothing and is already complete", () => {
    const form = createForm([]);
    expect(form.outstanding()).toBeNull();
    expect(form.forVolunteered("reference")).toBeNull();
    expect(form.complete()).toBe(true);
  });
});

describe("what the engine cannot capture", () => {
  it("leaves a choice and free text to the model rather than blocking on them", () => {
    const form = createForm([
      field({ key: "reasonForCall", type: "text", required: true }),
      field({ key: "branch", type: "choice", required: true }),
    ]);

    // Required, and still complete: nothing can capture them, so waiting would be waiting
    // forever. The model asks, and the answer stays in the transcript.
    expect(form.outstanding()).toBeNull();
    expect(form.complete()).toBe(true);
  });

  it("still collects the fields around them, in order", () => {
    const form = createForm([
      field({ key: "reasonForCall", type: "text" }),
      field({ key: "policyNumber", type: "reference" }),
    ]);
    expect(form.outstanding()?.key).toBe("policyNumber");
  });
});

describe("order", () => {
  it("is the order the operator put them in", () => {
    const form = createForm([
      field({ key: "dateOfBirth", type: "date" }),
      field({ key: "policyNumber", type: "reference" }),
    ]);
    expect(form.outstanding()?.key).toBe("dateOfBirth");
    form.satisfy("dateOfBirth", "1988-03-04", true);
    expect(form.outstanding()?.key).toBe("policyNumber");
  });

  it("ignores a duplicate key rather than giving two questions one answer slot", () => {
    const form = createForm([
      field({ key: "policyNumber", prompt: "First wording" }),
      field({ key: "policyNumber", prompt: "Second wording" }),
    ]);
    expect(form.outstanding()?.prompt).toBe("First wording");
    form.satisfy("policyNumber", "PM8592625", true);
    expect(form.outstanding()).toBeNull();
  });
});

describe("a value the caller volunteers", () => {
  it("satisfies the outstanding field of that kind, so it is not asked for again", () => {
    const form = createForm([field()]);
    expect(form.forVolunteered("reference")?.key).toBe("policyNumber");

    form.satisfy("policyNumber", "PM8592625", true);
    expect(form.outstanding()).toBeNull();
    expect(form.forVolunteered("reference")).toBeNull();
  });

  it("goes to the first outstanding field when two share a kind", () => {
    const form = createForm([field({ key: "policyNumber" }), field({ key: "claimNumber" })]);

    /* The ambiguity is real and cannot be resolved from a value: two references look
       identical. First outstanding is the only defensible guess, and it is exactly why a
       directed answer — where the agent asked a specific question — is consulted first. */
    expect(form.forVolunteered("reference")?.key).toBe("policyNumber");
    form.satisfy("policyNumber", "PM8592625", true);
    expect(form.forVolunteered("reference")?.key).toBe("claimNumber");
  });

  it("is not wanted when nothing of that kind is outstanding", () => {
    const form = createForm([field({ type: "date", key: "dateOfBirth" })]);
    expect(form.forVolunteered("reference")).toBeNull();
  });
});

describe("a directed answer", () => {
  it("belongs to the field the agent asked for, even when another shares its kind", () => {
    const form = createForm([field({ key: "policyNumber" }), field({ key: "claimNumber" })]);

    const claim = {
      key: "claimNumber",
      entity: "reference" as const,
      prompt: "",
      confirm: "readback" as const,
      required: true,
      pattern: "",
      attempts: 3,
      matches: () => true,
    };
    form.beginAsking(claim);

    // Asked for the claim number, so the next reference heard is the claim number — not
    // the first outstanding one, which is what a volunteered value would have matched.
    expect(form.asking()?.key).toBe("claimNumber");
  });

  it("stops being directed once it is answered", () => {
    const form = createForm([field()]);
    const target = form.outstanding();
    expect(target).not.toBeNull();
    if (target === null) return;

    form.beginAsking(target);
    form.satisfy(target.key, "PM8592625", true);
    // Otherwise the caller's *next* sentence is parsed as another answer to a question
    // that is already settled.
    expect(form.asking()).toBeNull();
  });
});

describe("required and optional", () => {
  it("holds the form open for a required field and not for an optional one", () => {
    expect(createForm([field({ required: true })]).complete()).toBe(false);
    expect(createForm([field({ required: false })]).complete()).toBe(true);
  });

  it("counts a skipped field as settled, so a caller who declines is not asked again", () => {
    const form = createForm([field({ key: "callbackNumber", type: "phone", required: false })]);
    form.skip("callbackNumber");
    expect(form.outstanding()).toBeNull();
    expect(form.complete()).toBe(true);
  });

  it("accepts a value the caller first declined and then gave", () => {
    const form = createForm([field({ key: "callbackNumber", type: "phone", required: false })]);
    form.skip("callbackNumber");
    form.satisfy("callbackNumber", "+2348021184429", true);
    expect(form.values.get("callbackNumber")?.value).toBe("+2348021184429");
    expect(form.outstanding()).toBeNull();
  });
});

describe("correction", () => {
  it("overwrites, because a correction is a second answer to the same question", () => {
    const form = createForm([field()]);
    form.satisfy("policyNumber", "PM8592625", true);
    form.satisfy("policyNumber", "PM8592627", true);
    expect(form.values.get("policyNumber")?.value).toBe("PM8592627");
  });
});

describe("confirmation", () => {
  /**
   * The operator decides whether a value is read back, including deciding not to. What
   * that costs is recorded rather than argued with: an unconfirmed value is stored as
   * unconfirmed, and the dispatch path refuses to act on one — a gate that is not
   * configurable and does not consult this module.
   */
  it("records whether the caller actually agreed to the value", () => {
    const form = createForm([
      field({ key: "policyNumber", confirm: "readback" }),
      field({ key: "callerName", type: "name", confirm: "none" }),
    ]);

    form.satisfy("policyNumber", "PM8592625", true);
    form.satisfy("callerName", "Adaeze Okonkwo", false);

    expect(form.values.get("policyNumber")?.confirmed).toBe(true);
    expect(form.values.get("callerName")?.confirmed).toBe(false);
  });

  it("carries the operator's confirmation choice onto the field", () => {
    expect(createForm([field({ confirm: "spellback" })]).outstanding()?.confirm).toBe("spellback");
  });
});

describe("the operator's own format check", () => {
  const shaped = (pattern: string) => createForm([field({ pattern })]).outstanding();

  it("accepts anything when no pattern is set, which is almost every field", () => {
    expect(shaped("")?.matches("anything at all")).toBe(true);
  });

  it("anchors the pattern, so a value with the right start is not enough", () => {
    /* Unanchored, `PM\d{7}` accepts `PM8592625-OLD` — right prefix, wrong record, and the
       agent would go on to look it up. Everyone who writes a format means the whole value,
       which is the same choice HTML's own pattern attribute makes. */
    const field = shaped("PM\\d{7}");
    expect(field?.matches("PM8592625")).toBe(true);
    expect(field?.matches("PM8592625-OLD")).toBe(false);
    expect(field?.matches("OLD-PM8592625")).toBe(false);
  });

  it("still works when the operator anchored it themselves", () => {
    expect(shaped("^PM\\d{7}$")?.matches("PM8592625")).toBe(true);
  });

  it("accepts everything when the pattern does not compile", () => {
    /* One agent's field, typed into a text box. Rejecting every value would turn a stray
       bracket into a call that can never get past its first question — a configuration
       mistake becoming a broken line, which is the outcome this product does not allow. */
    expect(shaped("PM(\\d{7}")?.matches("literally anything")).toBe(true);
  });

  it("fails a value longer than anything a caller says, rather than matching it", () => {
    // The cap is what bounds a backtracking pattern, and an unbounded string is not the
    // policy number the pattern was written to describe.
    expect(shaped(".*")?.matches("x".repeat(257))).toBe(false);
    expect(shaped(".*")?.matches("x".repeat(256))).toBe(true);
  });
});

describe("attempts", () => {
  it("allows the configured number of wrong values before giving up", () => {
    const form = createForm([field({ key: "policyNumber", attempts: 2 })]);
    expect(form.reject("policyNumber").again).toBe(true);
    // Second rejection is the second attempt, so there is no third.
    expect(form.reject("policyNumber").again).toBe(false);
  });

  it("counts per field, so one difficult value does not shorten the next", () => {
    const form = createForm([
      field({ key: "policyNumber", attempts: 2 }),
      field({ key: "dateOfBirth", type: "date", attempts: 2 }),
    ]);
    form.reject("policyNumber");
    form.reject("policyNumber");
    // A caller who fumbled a policy number has not used up the patience for their date of
    // birth. Carrying the count across would escalate calls that were going fine.
    expect(form.reject("dateOfBirth").again).toBe(true);
  });

  it("gives up immediately on a field the form does not hold", () => {
    // Nothing can be re-asked for a key with no question behind it, so `again` must not
    // send the call round a loop it cannot leave.
    expect(createForm([]).reject("ghost").again).toBe(false);
  });
});

describe("what a tool can be handed without a configured field", () => {
  it("is exactly the set the Tools tab tells operators about", () => {
    /* `apps/web/src/features/agents/components/tools-tab.tsx` holds `WITHOUT_A_FIELD` as
       its own copy, because the web app cannot import from the API. It uses it to say
       which of a tool's `identifiers` this agent will never resolve.

       If a kind is added here and not there, the console tells an operator to add a field
       they do not need. If one is removed here and not there, it stays quiet about a tool
       that will refuse on every call — the silent failure the warning was added to end. */
    expect(new Set(Object.values(FACT_FIELD_FOR))).toEqual(
      new Set(["callerName", "policyNumber"]),
    );
  });
});

/**
 * The steering block, which is the nearest text to the generation and therefore the one the
 * model actually obeys. The permission to take an early answer belongs here as well as in
 * the standing prompt: it has to be true on the turn the caller runs ahead.
 */
describe("the steering the graph writes each turn", () => {
  const asking: Guidance = {
    cover: [],
    tools: [],
    next: {
      kind: "ask",
      field: { key: "callbackNumber", prompt: "What's the best number to reach you on?", entity: "phone", required: true, type: "phone" },
    },
  } as unknown as Guidance;

  const choosing: Guidance = {
    cover: [],
    tools: [],
    next: { kind: "ask-choice", key: "intent", prompt: "Are you looking to rent, or to buy?", options: ["rent", "buy"] },
  };

  it("asks the next question", () => {
    expect(renderGuidance(asking)).toContain(`- Next, ask: "What's the best number to reach you on?"`);
  });

  it("lets an answer arrive early, whichever question it belongs to", () => {
    for (const guidance of [asking, choosing]) {
      const rendered = renderGuidance(guidance);
      expect(rendered).toContain("If they tell you more than you asked for, take it");
      expect(rendered).toContain("whichever question it belongs to");
      expect(rendered).toContain("never ask again for something they have already said");
    }
  });

  it("names the tool and the exact options for a choice", () => {
    const rendered = renderGuidance(choosing);

    expect(rendered).toContain('The answer is one of "rent", "buy"');
    expect(rendered).toContain('record_answer (field "intent")');
  });

  /* Nothing is being asked for on these turns, so the permission would be noise — and the
     end and transfer lines are the two the model must act on rather than read past. */
  it("says nothing about early answers once there is nothing left to ask", () => {
    for (const kind of ["end", "transfer", "free"] as const) {
      const rendered = renderGuidance({ cover: [], tools: [], next: { kind } });
      expect(rendered).not.toContain("more than you asked for");
    }
  });
});
