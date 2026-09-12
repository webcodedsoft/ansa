import { describe, expect, it } from "vitest";

import { describeAudit, kindLabelOf, subjectHref } from "./audit.display";

describe("an audit row as a sentence", () => {
  it("names the version and the note on a publish", () => {
    expect(
      describeAudit({ action: "agent_published", subjectLabel: "Front desk", detail: { version: "4", note: "Shorter greeting" } }).text,
    ).toBe("published version 4 of Front desk — “Shorter greeting”");
  });

  it("says somebody when the subject was never recorded", () => {
    expect(describeAudit({ action: "member_removed", subjectLabel: null, detail: {} }).text).toBe("removed somebody");
  });

  it("counts the other sessions a password change ended", () => {
    expect(describeAudit({ action: "password_changed", subjectLabel: null, detail: { otherSessionsEnded: "2" } }).text).toBe(
      "changed their password and signed out 2 other sessions",
    );
    expect(describeAudit({ action: "password_changed", subjectLabel: null, detail: { otherSessionsEnded: "0" } }).text).toBe(
      "changed their password",
    );
  });

  it("falls back to the slug for an action it has not learned", () => {
    expect(describeAudit({ action: "something_new", subjectLabel: null, detail: {} }).text).toBe("something new");
  });

  it("files each action under the chip that lists it", () => {
    expect(kindLabelOf("recording_listened")).toBe("Calls");
    expect(kindLabelOf("signed_in")).toBe("Sign-ins & accounts");
    expect(kindLabelOf("brand_new")).toBe("brand");
  });

  it("links the subjects that still have a page", () => {
    expect(subjectHref({ subjectKind: "agent", subjectId: "a1" })).toBe("/agents/a1");
    expect(subjectHref({ subjectKind: "member", subjectId: "u1" })).toBe("/organisation?s=people");
    expect(subjectHref({ subjectKind: "credential", subjectId: "crm" })).toBeNull();
    expect(subjectHref({ subjectKind: "call", subjectId: null })).toBeNull();
  });
});
