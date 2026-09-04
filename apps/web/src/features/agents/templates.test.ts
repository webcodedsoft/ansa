import { validateFlow } from "@ansa/shared/flow-validate";
import { describe, expect, it } from "vitest";

import { capturedFieldsSchema } from "./agents.schema";
import { flowFromTemplate } from "./flow.schema";
import { AGENT_TEMPLATES, allFields, TEMPLATE_SECTORS } from "./templates";

/**
 * Every template is held to the same standard: pick it, name the agent, publish. If a
 * template needs its questions fixed before the publish gate lets it through, it is not
 * a template, it is homework. So every one is drawn as the flow it describes and put
 * through the same validator the gate runs, and every one's form is put through the same
 * schema the API applies.
 */
describe("the template catalogue", () => {
  it("has at least fifty, across at least ten kinds of business", () => {
    expect(AGENT_TEMPLATES.length).toBeGreaterThanOrEqual(50);
    expect(TEMPLATE_SECTORS.length).toBeGreaterThanOrEqual(10);
  });

  it("gives every template its own id", () => {
    const ids = AGENT_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(AGENT_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s publishes as a flow with nothing to fix",
    (_id, template) => {
      const flow = flowFromTemplate(template);
      const blocking = validateFlow(flow).filter((problem) => problem.blocking);
      expect(blocking, blocking.map((problem) => problem.message).join("\n")).toEqual([]);
    },
  );

  it.each(AGENT_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s publishes as a form the API accepts",
    (_id, template) => {
      expect(capturedFieldsSchema.safeParse(allFields(template)).success).toBe(true);
    },
  );

  it.each(AGENT_TEMPLATES.filter((t) => t.branch !== undefined).map((template) => [template.id, template] as const))(
    "%s branches on a choice it actually asks, with an arm for every option",
    (_id, template) => {
      const branch = template.branch;
      if (branch === undefined) return;
      const on = template.fields.find((field) => field.key === branch.on);
      expect(on?.type, `${branch.on} must be a choice asked before the branch`).toBe("choice");
      // Every option leads somewhere, and every arm is an option — a caller who says
      // "buy" must not fall off the canvas, and an arm nobody can reach is dead weight.
      expect(new Set(Object.keys(branch.arms))).toEqual(new Set(on?.options ?? []));
    },
  );

  it("speaks every prompt as a person would, and never as a form label", () => {
    for (const template of AGENT_TEMPLATES) {
      for (const field of allFields(template)) {
        // A colon at the end is a web form. A question mark or a full stop is a sentence.
        expect(field.prompt, `${template.id}.${field.key}`).not.toMatch(/:\s*$/);
        expect(field.prompt.length, `${template.id}.${field.key}`).toBeLessThanOrEqual(300);
      }
    }
  });

  it("lets every outbound template hang up on a voicemail", () => {
    for (const template of AGENT_TEMPLATES.filter((t) => t.sector === "Outbound")) {
      expect(template.answeringMachineDetection, template.id).toBe(true);
    }
  });
});
