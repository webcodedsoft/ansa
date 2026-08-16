import { describe, expect, it } from "vitest";

import { publishFormInput, publishSchema } from "./agents.schema";

/**
 * When a version has to be explained, and what it is called when it does not.
 *
 * Four buttons drive the agent workspace's one form and all four publish a version, because
 * there is one endpoint and one configuration document. Only Publish is the deliberate act
 * aimed at the whole thing, so only Publish asks what changed. The rest name their own change
 * — that is what the button says — and the note is filled rather than demanded.
 *
 * The invariant underneath is the part worth a test: whichever button was pressed, the
 * version reaches the API carrying a note. A blank line in the history is what the
 * requirement existed to prevent, and it must not come back through a side door.
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

const submit = (intent: string | null, note: string) =>
  publishSchema.safeParse({ ...FILLED, intent, note });

const errorsOn = (result: ReturnType<typeof submit>, field: string) =>
  result.success ? [] : result.error.issues.filter((issue) => issue.path[0] === field);

describe("what changed", () => {
  it("is demanded when the Publish button sent the form", () => {
    const [issue] = errorsOn(submit("publish", ""), "note");
    expect(issue?.message).toBe(
      "Say what changed. A version with no reason explains nothing later.",
    );
  });

  it("is not demanded when a tab's own save button sent the form", () => {
    // The rule this file exists for: saving the voice from the Voice tab has to go through
    // with the field empty.
    expect(submit("voice", "").success).toBe(true);
  });

  it("still reaches the API with a note when nobody typed one", () => {
    const result = submit("voice", "");
    expect(result.success && result.data.note).toBe("Voice and speaking rate updated.");
  });

  it("keeps what was typed rather than replacing it with the button's own words", () => {
    const result = submit("voice", "Swapped to Amara for the Lagos line.");
    expect(result.success && result.data.note).toBe("Swapped to Amara for the Lagos line.");
  });

  it("names every save button, so none of them can publish a blank note", () => {
    for (const intent of ["identity", "instructions", "voice"]) {
      const result = submit(intent, "");
      expect(result.success, intent).toBe(true);
      expect(result.success && result.data.note, intent).not.toBe("");
    }
  });

  it("asks when no button sent the form at all", () => {
    // Pressing return in a text field submits with no submitter, and so with no `intent`.
    // Treated as the deliberate act: the cost of asking is a sentence, and the alternative
    // is a version labelled by a guess.
    expect(errorsOn(submit(null, ""), "note")).toHaveLength(1);
  });

  it("does not send the intent on to the API", () => {
    // `POST /config/versions` rewrites the whole document rather than patching it, so
    // anything that leaks into the body is stored.
    const result = submit("voice", "");
    expect(result.success && "intent" in result.data).toBe(false);
  });
});

describe("reading the form", () => {
  it("takes the intent from the submitting button", () => {
    // A submitter's own name and value are part of the FormData; nothing else in it says
    // which control caused the submit.
    const form = new FormData();
    form.set("intent", "voice");
    expect(publishFormInput(form).intent).toBe("voice");
  });

  it("reports no intent when no button was pressed", () => {
    expect(publishFormInput(new FormData()).intent).toBeNull();
  });
});
