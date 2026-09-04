import { validateFlow } from "@ansa/shared/flow-validate";
import { describe, expect, it } from "vitest";

import { capturedFieldsSchema, type CapturedField } from "./agents.schema";
import { flowFromTemplate } from "./flow.schema";
import { AGENT_TEMPLATES, allFields, formPolicies, servicesOf, TEMPLATE_SECTORS, type AgentTemplate, type TemplateBranch } from "./templates";

/**
 * Every template is held to the same standard: pick it, name the agent, publish. If a
 * template needs its questions fixed before the publish gate lets it through, it is not
 * a template, it is homework. So every one is drawn as the flow it describes and put
 * through the same validator the gate runs, and every one's form is put through the same
 * schema the API applies — with the API's limits on the text around them.
 */

/** The API's caps on the configuration document, mirrored so a template cannot exceed them. */
const LIMITS = { greeting: 500, persona: 400, instructions: 2000, keyterms: 100, keyterm: 100, policies: 12, policyName: 60, policyLine: 200, policyLines: 8 };

const each = AGENT_TEMPLATES.map((template) => [template.id, template] as const);
const catalogue = AGENT_TEMPLATES.filter((template) => template.id !== "blank");

/** Every fork in a template, with the questions in scope where it is asked. */
const forks = (
  branch: TemplateBranch | undefined,
  inScope: readonly CapturedField[],
): readonly { readonly branch: TemplateBranch; readonly inScope: readonly CapturedField[] }[] => {
  if (branch === undefined) return [];
  return [
    { branch, inScope },
    ...Object.values(branch.arms).flatMap((arm) => forks(arm.branch, [...inScope, ...arm.fields])),
  ];
};

describe("the template catalogue", () => {
  it("has at least fifty organisations, across at least ten sectors", () => {
    expect(catalogue.length).toBeGreaterThanOrEqual(50);
    expect(TEMPLATE_SECTORS.length).toBeGreaterThanOrEqual(10);
  });

  it("gives every template its own id", () => {
    const ids = AGENT_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(each)("%s publishes as a flow with nothing to fix", (_id, template) => {
    const flow = flowFromTemplate(template);
    const blocking = validateFlow(flow).filter((problem) => problem.blocking);
    expect(blocking, blocking.map((problem) => problem.message).join("\n")).toEqual([]);
    // Every node on its own spot: two steps drawn on top of each other is a fork that
    // widened into its neighbour, which the validator cannot see and a person cannot untangle.
    const spots = flow.nodes.map((node) => `${node.x},${node.y}`);
    expect(new Set(spots).size, "nodes drawn on top of each other").toBe(spots.length);
  });

  it.each(each)("%s publishes as a form the API accepts", (_id, template) => {
    const parsed = capturedFieldsSchema.safeParse(allFields(template));
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
    // One key, one question. A form cannot ask "budget" twice with two prompts and the
    // collected-data page cannot show two columns with one name.
    const keys = allFields(template).map((field) => field.key);
    expect(new Set(keys).size, `duplicate keys in ${keys.join(", ")}`).toBe(keys.length);
  });

  it.each(each)("%s forks only on a choice it has already asked, with an arm for every option", (_id, template) => {
    for (const { branch, inScope } of forks(template.branch, template.fields)) {
      const on = inScope.find((field) => field.key === branch.on);
      expect(on?.type, `${branch.on} must be a choice asked before the fork`).toBe("choice");
      // Every option leads somewhere, and every arm is an option — a caller who says
      // "buy" must not fall off the canvas, and an arm nobody can reach is dead weight.
      expect(new Set(Object.keys(branch.arms))).toEqual(new Set(on?.options ?? []));
      // Ends the call one way or the other, never both.
      for (const arm of Object.values(branch.arms)) {
        expect(arm.closing !== undefined && arm.handover !== undefined, "an arm with a closing and a handover").toBe(false);
      }
    }
  });

  it.each(catalogue.map((template) => [template.id, template] as const))("%s is a whole front desk, not one task", (_id, template) => {
    // An outbound campaign is one call with one purpose; everything inbound is a business
    // that is rung about several things.
    if (template.sector !== "Outbound") expect(servicesOf(template).length).toBeGreaterThanOrEqual(3);
    expect(template.policies.length).toBeGreaterThanOrEqual(1);
    expect(template.keyterms.length).toBeGreaterThanOrEqual(5);
  });

  it.each(each)("%s fits the API's limits on the words around the questions", (_id, template) => {
    expect(template.greeting.length).toBeLessThanOrEqual(LIMITS.greeting);
    expect(template.persona.length).toBeLessThanOrEqual(LIMITS.persona);
    expect(template.instructions.length).toBeLessThanOrEqual(LIMITS.instructions);
    expect(template.keyterms.length).toBeLessThanOrEqual(LIMITS.keyterms);
    for (const term of template.keyterms) expect(term.length).toBeLessThanOrEqual(LIMITS.keyterm);
    // The form gets one policy more than the flow, and both must fit.
    const policies = formPolicies(template);
    expect(policies.length).toBeLessThanOrEqual(LIMITS.policies);
    for (const policy of policies) {
      expect(policy.name.length).toBeLessThanOrEqual(LIMITS.policyName);
      expect(policy.applies.length).toBeLessThanOrEqual(LIMITS.policyLine);
      for (const lines of [policy.canDo, policy.cannotDo, policy.escalateWhen]) {
        expect(lines.length).toBeLessThanOrEqual(LIMITS.policyLines);
        for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(LIMITS.policyLine);
      }
    }
  });

  it("speaks every prompt as a person would, and never as a form label", () => {
    for (const template of AGENT_TEMPLATES) {
      for (const field of allFields(template)) {
        // A colon at the end is a web form. A question mark or a full stop is a sentence.
        expect(field.prompt, `${template.id}.${field.key}`).not.toMatch(/:\s*$/);
        expect(field.prompt.length, `${template.id}.${field.key}`).toBeLessThanOrEqual(300);
      }
    }
  });

  it("never asks a caller for a BVN, NIN, PIN or OTP", () => {
    // Nigerian banks say it on every channel: nobody legitimate asks for these on a call.
    // An agent that did would be indistinguishable from the fraud it warns about.
    for (const template of AGENT_TEMPLATES) {
      for (const field of allFields(template)) {
        expect(["bvn", "nin", "otp"]).not.toContain(field.type);
        expect(field.prompt.toLowerCase(), `${template.id}.${field.key}`).not.toMatch(/\b(bvn|nin|pin|otp|password)\b/);
      }
    }
  });

  it("lets every outbound template hang up on a voicemail", () => {
    for (const template of AGENT_TEMPLATES.filter((t) => t.sector === "Outbound")) {
      expect(template.answeringMachineDetection, template.id).toBe(true);
    }
  });
});

describe("drawing a template", () => {
  const template: AgentTemplate = {
    id: "t", name: "t", sector: "t", summary: "", persona: "", greeting: "", instructions: "", keyterms: [], policies: [],
    fields: [
      { key: "reason", type: "choice", prompt: "Why?", capture: "speech", confirm: "none", pattern: "", attempts: 3, required: true, options: ["a", "b", "c"] },
    ],
    branch: {
      on: "reason",
      arms: {
        a: {
          fields: [{ key: "kind", type: "choice", prompt: "Which?", capture: "speech", confirm: "none", pattern: "", attempts: 3, required: true, options: ["x", "y"] }],
          branch: {
            on: "kind",
            arms: {
              x: { fields: [{ key: "xq", type: "text", prompt: "X?", capture: "speech", confirm: "none", pattern: "", attempts: 3, required: true, options: [] }], closing: "X done." },
              y: { fields: [], handover: "Y goes to a person." },
            },
          },
        },
        b: { fields: [], handover: "B goes to a person." },
        c: { fields: [] },
      },
    },
    closing: "Shared close.",
    bargeIn: true,
    answeringMachineDetection: false,
  };
  const flow = flowFromTemplate(template);
  const node = (id: string) => flow.nodes.find((n) => n.id === id);
  const edge = (from: string, to: string) => flow.edges.find((e) => e.from === from && e.to === to);

  it("forks inside an arm and widens the arm to hold it", () => {
    expect(node("arm-1-fork")?.kind).toBe("decide");
    expect(node("arm-1-fork")?.on).toBe("kind");
    // Arm a took two columns (x and y), so arm b starts in the third.
    expect(node("arm-1-1-q1")?.x).toBe(40);
    expect(node("arm-1-2-why")?.x).toBe(40 + 260);
    expect(node("arm-2-why")?.x).toBe(40 + 2 * 260);
  });

  it("ends a hand-over at a person, after saying why", () => {
    expect(node("arm-2-why")?.kind).toBe("say");
    expect(node("arm-2-person")?.kind).toBe("transfer");
    expect(edge("arm-2-why", "arm-2-person")).toBeDefined();
    expect(flow.edges.some((e) => e.from === "arm-2-person")).toBe(false);
  });

  it("sends an arm with its own closing straight to the end, and the rest through the shared close", () => {
    expect(edge("arm-1-1-close", "end")).toBeDefined();
    expect(edge("arm-3-ack", "close")).toBeDefined();
    expect(edge("close", "end")).toBeDefined();
    expect(node("close")?.text).toBe("Shared close.");
  });

  it("makes the last option the catch-all at every fork", () => {
    expect(edge("branch", "arm-3-ack")?.otherwise).toBe(true);
    expect(edge("branch", "arm-1-q1")?.when).toEqual({ equals: "a" });
    expect(edge("arm-1-fork", "arm-1-2-why")?.otherwise).toBe(true);
  });

  it("publishes clean", () => {
    expect(validateFlow(flow).filter((p) => p.blocking)).toEqual([]);
  });
});
