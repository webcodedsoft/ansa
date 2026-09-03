import type { AgentConfigFields } from "@ansa/db";
import type { Flow } from "@ansa/shared";
import { describe, expect, it } from "vitest";

import { diffConfigurations, diffFlows } from "./diff";

/**
 * The comparison behind "it was working yesterday".
 *
 * Every case here is a shape of change somebody would actually be looking for on a call
 * that went wrong, and the ones that assert *nothing* changed matter as much as the others:
 * a diff that reports a reordering or a capitalisation edit as a change to the agent is a
 * diff whose real changes stop being read.
 */

const base: AgentConfigFields = {
  name: "First Organisation",
  voiceId: null,
  speakingRate: null,
  greeting: null,
  persona: null,
  instructions: null,
  policyBlocks: null,
  keyterms: [],
  escalation: null,
};

const changed = (fields: Partial<AgentConfigFields>): AgentConfigFields => ({ ...base, ...fields });

describe("two versions of a configuration", () => {
  it("reports nothing when they are the same", () => {
    const diff = diffConfigurations(base, { ...base });
    expect(diff.identical).toBe(true);
    expect(diff.fields).toEqual([]);
    expect(diff.keyterms).toEqual({ added: [], removed: [] });
  });

  it("reports a change of pace", () => {
    // The pace an operator sets is one of the few settings whose effect is audible on
    // every second of every call, and it was absent from the flattened leaves: changing it
    // published a version whose diff said nothing had changed.
    const diff = diffConfigurations(base, changed({ speakingRate: 0.85 }));
    expect(diff.identical).toBe(false);
    expect(diff.fields).toEqual([{ field: "speakingRate", before: null, after: "0.85" }]);
  });

  /**
   * The guarantee `diff.ts` describes, enforced rather than asserted in a comment.
   *
   * `leaves()` is written out by hand so nothing is walked generically, and the return type
   * is keyed by `string` — so a field added to `AgentConfigFields` and forgotten there
   * compiles, ships, and quietly stops being reported. That is how `speakingRate` came to be
   * missing. Changing one field at a time and demanding the diff name it is the only check
   * that scales with the shape.
   */
  it("names every field of a configuration, so none can be added and forgotten", () => {
    // Keyterms are excluded deliberately: they are reported as added/removed terms rather
    // than as a flattened leaf, which the test below this one pins.
    const somethingElse: Readonly<Record<string, unknown>> = {
      name: "Second Organisation",
      voiceId: "voice-other",
      speakingRate: 0.85,
      greeting: "Good afternoon.",
      persona: "Brisk.",
      instructions: "Transfer billing questions.",
      policyBlocks: [{ name: "Refunds", applies: "money back", canDo: [], cannotDo: [], escalateWhen: [] }],
      businessHours: { opensAtHour: 8, closesAtHour: 18, openDays: [1, 2] },
      escalation: { toNumber: "+2348000000000", fromNumber: "+2348000000001", ringSeconds: 20 },
    };

    for (const field of Object.keys(base)) {
      if (field === "keyterms") continue;
      const other = somethingElse[field];
      expect(other, `the fixture above has no different value for ${field}`).toBeDefined();

      const diff = diffConfigurations(base, changed({ [field]: other } as Partial<AgentConfigFields>));
      expect(diff.identical, `${field} changed and the diff called the versions identical`).toBe(
        false,
      );
    }
  });

  it("names the field that moved, and only that one", () => {
    const diff = diffConfigurations(base, changed({ greeting: "Good afternoon." }));
    expect(diff.identical).toBe(false);
    expect(diff.fields).toEqual([{ field: "greeting", before: null, after: "Good afternoon." }]);
  });

  /**
   * Null and empty are different states of a greeting — one is "the platform's" and the
   * other is "say nothing" — so a diff that collapsed them would hide the more surprising
   * of the two.
   */
  it("distinguishes a field that was cleared from one that was set to nothing", () => {
    const diff = diffConfigurations(changed({ greeting: "Hello." }), changed({ greeting: "" }));
    expect(diff.fields).toEqual([{ field: "greeting", before: "Hello.", after: "" }]);
  });

  /*
   * The two hours tests that were here are gone with the fields they covered.
   *
   * They asserted that a diff descends into `businessHours` rather than reporting an object,
   * and that turning hours off reads as three fields clearing. Both were true of the shape and
   * neither was ever reachable: `CONFIG_COLUMNS` has never snapshotted hours, so a version
   * loaded from `agent_prompt_versions` always had them null on both sides and the rows could
   * only ever say "unchanged". Migration 0053 took hours out of the configuration document
   * altogether — they are the organisation's and are set through `PUT /organization/hours`,
   * which is not versioned and has no diff.
   *
   * Deleted rather than skipped. A passing test for a field that cannot appear is worse than
   * no test: it reads as coverage of the diff and covers nothing.
   */

  it("does the same for escalation, in both directions", () => {
    const escalation = { toNumber: "+10000000001", fromNumber: "+10000000002", ringSeconds: null };
    const added = diffConfigurations(base, changed({ escalation }));
    expect(added.fields.map((field) => field.field)).toEqual([
      "escalation.toNumber",
      "escalation.fromNumber",
    ]);
    // ringSeconds was null on both sides: absent and absent is not a change.
    const removed = diffConfigurations(changed({ escalation }), base);
    expect(removed.fields.map((field) => field.after)).toEqual([null, null]);
  });

  it("reports several fields at once, in a stable order", () => {
    const diff = diffConfigurations(
      base,
      changed({ name: "Second Organisation", voiceId: "voice-two", instructions: "Be brief." }),
    );
    expect(diff.fields.map((field) => field.field)).toEqual(["name", "voiceId", "instructions"]);
  });
});

describe("keyterms", () => {
  it("are compared as a set, so a reordering is not a change", () => {
    const diff = diffConfigurations(
      changed({ keyterms: ["premium", "policy"] }),
      changed({ keyterms: ["policy", "premium"] }),
    );
    expect(diff.identical).toBe(true);
  });

  /**
   * The merge that reaches the transcriber de-duplicates without regard to case, so two
   * spellings of one term are one term by the time it matters. Reporting a capitalisation
   * edit as a term added and a term removed would describe a change to the agent's hearing
   * that did not happen.
   */
  it("ignore a change of case, because the transcriber does", () => {
    const diff = diffConfigurations(
      changed({ keyterms: ["Policy"] }),
      changed({ keyterms: ["policy"] }),
    );
    expect(diff.identical).toBe(true);
  });

  it("report what the agent started and stopped listening for", () => {
    const diff = diffConfigurations(
      changed({ keyterms: ["policy", "premium"] }),
      changed({ keyterms: ["policy", "endorsement"] }),
    );
    expect(diff.keyterms).toEqual({ added: ["endorsement"], removed: ["premium"] });
    expect(diff.identical).toBe(false);
    // A keyterm change is not a field change: the list is not one of the flattened leaves.
    expect(diff.fields).toEqual([]);
  });
});

describe("what changed in a graph", () => {
  const field = (key: string) => ({
    key, type: "choice" as const, prompt: `${key}?`, capture: "speech" as const, confirm: "none" as const,
    pattern: "", attempts: 3, required: true, options: ["rent", "buy"],
  });
  const graph = (arm: "rent" | "buy"): Flow => ({
    version: 1,
    nodes: [
      { id: "start", kind: "start", x: 0, y: 0 },
      { id: "intent", kind: "collect", x: 1, y: 0, field: field("intent") },
      { id: "d", kind: "decide", x: 2, y: 0, on: "intent" },
      { id: "deposit", kind: "collect", x: 3, y: 0, field: { ...field("deposit"), type: "amount", options: [] } },
      { id: "end", kind: "hangup", x: 4, y: 0 },
    ],
    edges: [
      { from: "start", to: "intent" },
      { from: "intent", to: "d" },
      { from: "d", to: "deposit", when: { equals: arm } },
      { from: "d", to: "end", otherwise: true },
      { from: "deposit", to: "end" },
    ],
  });

  it("sees a rewiring that leaves every question where it was", () => {
    /* The projection of both is the same list — intent, then deposit — so the field diff
       says nothing. To a caller, the deposit question moved from the renters to the buyers,
       which is the change most worth seeing. */
    const change = diffFlows({ shape: "flow", flow: graph("rent") }, { shape: "flow", flow: graph("buy") });

    expect(change.identical).toBe(false);
    expect(change.steps).toEqual({ added: [], removed: [], changed: [] });
    expect(change.connections.removed).toEqual(['decide "intent" → collect "deposit" (is "rent")']);
    expect(change.connections.added).toEqual(['decide "intent" → collect "deposit" (is "buy")']);
  });

  it("ignores a step that only moved on the canvas", () => {
    const moved: Flow = { ...graph("rent"), nodes: graph("rent").nodes.map((n) => ({ ...n, x: n.x + 100, y: 50 })) };

    expect(diffFlows({ shape: "flow", flow: graph("rent") }, { shape: "flow", flow: moved }).identical).toBe(true);
  });

  it("names steps added, removed and changed", () => {
    const after: Flow = {
      ...graph("rent"),
      nodes: [
        ...graph("rent").nodes.filter((n) => n.id !== "deposit").map((n) =>
          n.id === "intent" ? { ...n, field: { ...field("intent"), prompt: "Rent, or buy?" } } : n,
        ),
        { id: "thanks", kind: "say", x: 5, y: 0, text: "Thank them" },
      ],
    };

    const change = diffFlows({ shape: "flow", flow: graph("rent") }, { shape: "flow", flow: after });

    expect(change.steps.added).toEqual(['say "Thank them"']);
    expect(change.steps.removed).toEqual(['collect "deposit"']);
    expect(change.steps.changed).toEqual(['collect "intent"']);
  });

  it("reports a change of authoring model as a change, whatever else moved", () => {
    const change = diffFlows({ shape: "form", flow: null }, { shape: "flow", flow: graph("rent") });

    expect(change.identical).toBe(false);
    expect(change.shape).toEqual({ before: "form", after: "flow" });
  });

  it("says two form versions are identical, having no graph to compare", () => {
    expect(diffFlows({ shape: "form", flow: null }, { shape: "form", flow: null }).identical).toBe(true);
  });
});
