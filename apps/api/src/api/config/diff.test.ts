import type { TenantConfigFields } from "@ansa/db";
import { describe, expect, it } from "vitest";

import { diffConfigurations } from "./diff";

/**
 * The comparison behind "it was working yesterday".
 *
 * Every case here is a shape of change somebody would actually be looking for on a call
 * that went wrong, and the ones that assert *nothing* changed matter as much as the others:
 * a diff that reports a reordering or a capitalisation edit as a change to the agent is a
 * diff whose real changes stop being read.
 */

const base: TenantConfigFields = {
  name: "First Organisation",
  voiceId: null,
  greeting: null,
  persona: null,
  instructions: null,
  keyterms: [],
  businessHours: null,
  escalation: null,
};

const changed = (fields: Partial<TenantConfigFields>): TenantConfigFields => ({ ...base, ...fields });

describe("two versions of a configuration", () => {
  it("reports nothing when they are the same", () => {
    const diff = diffConfigurations(base, { ...base });
    expect(diff.identical).toBe(true);
    expect(diff.fields).toEqual([]);
    expect(diff.keyterms).toEqual({ added: [], removed: [] });
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

  it("descends into business hours rather than reporting an object", () => {
    const hours = { opensAtHour: 9, closesAtHour: 17, openDays: [1, 2, 3, 4, 5] };
    const diff = diffConfigurations(
      changed({ businessHours: hours }),
      changed({ businessHours: { ...hours, closesAtHour: 18 } }),
    );
    expect(diff.fields).toEqual([
      { field: "businessHours.closesAtHour", before: "17", after: "18" },
    ]);
  });

  /**
   * Turning hours off is three fields clearing, not one shape change. The reader is
   * answering "why is the agent answering at nine at night", and "businessHours: null" is
   * one step further from that answer than the hours themselves.
   */
  it("reads hours being turned off as every one of their fields clearing", () => {
    const diff = diffConfigurations(
      changed({ businessHours: { opensAtHour: 8, closesAtHour: 20, openDays: [1, 7] } }),
      base,
    );
    expect(diff.fields).toEqual([
      { field: "businessHours.opensAtHour", before: "8", after: null },
      { field: "businessHours.closesAtHour", before: "20", after: null },
      { field: "businessHours.openDays", before: "1, 7", after: null },
    ]);
  });

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
