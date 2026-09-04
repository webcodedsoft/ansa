import { describe, expect, it } from "vitest";

import { placeholdersIn, problemsWith, urlParamsIn } from "./http-tool.schema";
import { TEMPLATE_SECTORS } from "./templates";
import { findToolTemplate, TOOL_CATALOGUE, TOOL_SECTORS } from "./tool-catalogue";
import { HOST } from "./tool-templates";

/**
 * A tool template is held to the form's own validator: replace the host, pick a credential,
 * and it saves. Anything the form would refuse — a URL hole with no parameter, a write
 * without a readback, a speech line with nothing from the response in it — is caught here
 * rather than by the person who picked it.
 */
const each = TOOL_CATALOGUE.map((tool) => [tool.id, tool] as const);

describe("the tool catalogue", () => {
  it("has at least fifty tools across every inbound sector the agents have", () => {
    expect(TOOL_CATALOGUE.length).toBeGreaterThanOrEqual(50);
    for (const sector of TEMPLATE_SECTORS) {
      if (sector === "Any business") continue;
      expect(TOOL_SECTORS, `no tools for ${sector}`).toContain(sector);
    }
  });

  it("gives every template its own id and its own tool name", () => {
    const ids = TOOL_CATALOGUE.map((tool) => tool.id);
    const names = TOOL_CATALOGUE.map((tool) => tool.draft.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    expect(findToolTemplate("look-up-policy")?.sector).toBe("Insurance");
  });

  it.each(each)("%s passes the form's own checks with only the host left to change", (_id, tool) => {
    const problems = problemsWith(tool.draft, { takenNames: [], allowPlaintextHttp: false, credentials: [] });
    expect(problems, JSON.stringify(problems)).toEqual({});
    expect(tool.draft.url.startsWith(HOST)).toBe(true);
  });

  it.each(each)("%s describes every parameter for the model, and uses the ones in its URL", (_id, tool) => {
    for (const param of tool.draft.params) {
      expect(param.description.length, `${param.name} has no description`).toBeGreaterThan(10);
    }
    const names = new Set(tool.draft.params.map((param) => param.name));
    for (const hole of urlParamsIn(tool.draft.url)) expect(names.has(hole), `{${hole}} has no parameter`).toBe(true);
  });

  it.each(each)("%s speaks from the response and never raw JSON, and reads a write back from its arguments", (_id, tool) => {
    const { draft } = tool;
    if (draft.riskTier === "irreversible") {
      expect(draft.transferReason.length).toBeGreaterThan(20);
      return;
    }
    expect(tool.expects.length).toBeGreaterThan(10);
    expect(placeholdersIn(draft.speechTemplate).length).toBeGreaterThan(0);
    expect(draft.speechFallback.length).toBeGreaterThan(10);
    // A write's readback quotes the caller's own values, so every hole in it must be an
    // argument the model supplies — a hole from the response would render as nothing and
    // the dispatcher would refuse to fire, correctly, on every call.
    if (draft.riskTier === "write") {
      const args = new Set(draft.params.map((param) => param.name));
      for (const hole of placeholdersIn(draft.readback)) expect(args.has(hole), `readback uses {${hole}}, not an argument`).toBe(true);
      expect(draft.method).not.toBe("GET");
    } else {
      expect(draft.method).toBe("GET");
    }
    // Speech never names the currency: the normalizer says naira from the number, and a
    // template that spelt it out would be right until the first tool that returns kobo.
    expect(draft.speechTemplate).not.toMatch(/₦|NGN/);
  });

  it("puts every destructive action behind a person", () => {
    const irreversible = TOOL_CATALOGUE.filter((tool) => tool.draft.riskTier === "irreversible").map((tool) => tool.draft.name);
    expect(irreversible).toEqual(expect.arrayContaining(["block_card", "cancel_policy", "terminate_tenancy", "cancel_reservation", "issue_authorisation_code"]));
  });
});
