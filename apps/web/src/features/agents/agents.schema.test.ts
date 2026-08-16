import { describe, expect, it } from "vitest";

import { publishFormInput, publishSchema } from "./agents.schema";

/**
 * Publishing is the one act that makes a configuration real, so it is the one act that has
 * to say why.
 *
 * This briefly depended on which button sent the form: three per-tab "Save" buttons also
 * submitted it, and demanding a sentence for "save the voice" was a toll on the common case,
 * so they filled the note themselves. The buttons were the actual defect — there is one
 * endpoint and one document, so each of them published every tab, live, under a label saying
 * "Save". Removing them removed the exception, and the rule is a rule again.
 */

const FILLED = {
  name: "Support line",
  voiceId: "",
  speakingRate: "",
  greeting: "",
  persona: "",
  instructions: "",
  keyterms: "",
  hoursEnabled: false,
  opensAtHour: 9,
  closesAtHour: 17,
  openDays: [],
  escalationEnabled: false,
  toNumber: "",
  fromNumber: "",
  ringSeconds: "",
};

const withNote = (note: string) => publishSchema.safeParse({ ...FILLED, note });

const errorsOn = (result: ReturnType<typeof withNote>, field: string) =>
  result.success ? [] : result.error.issues.filter((issue) => issue.path[0] === field);

describe("what changed", () => {
  it("is demanded of every publish", () => {
    const [issue] = errorsOn(withNote(""), "note");
    expect(issue?.message).toBe(
      "Say what changed. A version with no reason explains nothing later.",
    );
  });

  it("counts whitespace as nothing said", () => {
    expect(errorsOn(withNote("   "), "note")).toHaveLength(1);
  });

  it("passes a real note through to the body, trimmed", () => {
    const result = withNote("  Slowed the voice for the Lagos line.  ");
    expect(result.success && result.data.note).toBe("Slowed the voice for the Lagos line.");
  });

  it("refuses one longer than the column", () => {
    const [issue] = errorsOn(withNote("x".repeat(501)), "note");
    expect(issue?.message).toBe("That note is too long.");
  });
});

describe("reading the form", () => {
  it("treats a missing note as empty rather than as absent", () => {
    // `POST /config/versions` rewrites the whole document, so a field read as `undefined`
    // and one read as `""` are the difference between a validation error and a silently
    // cleared setting. Every field here defaults rather than being left off.
    expect(publishFormInput(new FormData()).note).toBe("");
  });

  it("reads the note the dialog submitted", () => {
    const form = new FormData();
    form.set("note", "Swapped to Amara.");
    expect(publishFormInput(form).note).toBe("Swapped to Amara.");
  });
});
