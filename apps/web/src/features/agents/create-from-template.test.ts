import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What creating an agent from a template actually sends.
 *
 * The API is mocked at the service boundary and every call recorded, because the point is
 * the wiring: a template's keyterms and policies reach the agent only through a draft
 * saved after the create, and a form agent is given one policy more than a flow. Both are
 * the kind of seam that passes every other test with the wiring deleted.
 */
const calls: Record<string, unknown[]> = { createAgent: [], setAgentFields: [], setAgentFlow: [], saveDraft: [], stageAgentBehaviour: [] };

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/lib/api/server", () => ({ failureMessage: (e: unknown) => String(e), readSessionToken: async () => "t" }));
vi.mock("./agents.service", () => ({
  createAgent: async (body: unknown) => {
    calls.createAgent?.push(body);
    return { agentId: "agent-1" };
  },
  setAgentFields: async (id: string, fields: unknown) => calls.setAgentFields?.push({ id, fields }),
  setAgentFlow: async (id: string, body: unknown) => calls.setAgentFlow?.push({ id, body }),
  stageAgentBehaviour: async (id: string, body: unknown) => calls.stageAgentBehaviour?.push({ id, body }),
  currentConfiguration: async () => ({
    version: 1,
    config: {
      name: "Agent",
      voiceId: "voice-9",
      speakingRate: 0.95,
      greeting: "Hello",
      persona: "P",
      instructions: "I",
      keyterms: ["Lagos", "already-there"],
      escalation: { toNumber: "+2348000000000", fromNumber: "+2348000000001", ringSeconds: 20 },
      policyBlocks: [],
    },
  }),
  saveDraft: async (id: string, body: unknown) => {
    calls.saveDraft?.push({ id, body });
    return { updatedAt: "now" };
  },
}));

const { createAgentFromTemplate } = await import("./agents.actions");
const { findTemplate, formPolicies } = await import("./templates");

const draft = () => (calls.saveDraft?.[0] as { body: { keyterms: string[]; policyBlocks: { name: string }[]; voiceId: string; escalation: unknown } }).body;

describe("creating an agent from a template", () => {
  beforeEach(() => {
    for (const key of Object.keys(calls)) calls[key] = [];
  });

  it("stages the template's keyterms on top of the ones the agent already has", async () => {
    const result = await createAgentFromTemplate({ name: "Front desk", templateId: "estate-agency", authoringMode: "flow" });
    expect(result.ok).toBe(true);
    const body = draft();
    expect(body.keyterms).toContain("already-there");
    expect(body.keyterms).toContain("caution fee");
    // Merged, not duplicated: "Lagos" is in both.
    expect(body.keyterms.filter((k) => k === "Lagos")).toHaveLength(1);
  });

  it("keeps what the create set — voice, rate, escalation — rather than blanking it", async () => {
    await createAgentFromTemplate({ name: "Front desk", templateId: "estate-agency", authoringMode: "flow" });
    expect(draft().voiceId).toBe("voice-9");
    expect(draft().escalation).toEqual({ toNumber: "+2348000000000", fromNumber: "+2348000000001", ringSeconds: 20 });
  });

  it("gives a flow agent the template's policies, and a form agent one more that routes the questions", async () => {
    const template = findTemplate("estate-agency");
    if (template === null) throw new Error("template missing");

    await createAgentFromTemplate({ name: "Flow", templateId: "estate-agency", authoringMode: "flow" });
    expect(draft().policyBlocks.map((p) => p.name)).toEqual(template.policies.map((p) => p.name));

    calls.saveDraft = [];
    await createAgentFromTemplate({ name: "Form", templateId: "estate-agency", authoringMode: "form" });
    expect(draft().policyBlocks.map((p) => p.name)).toEqual(formPolicies(template).map((p) => p.name));
    expect(draft().policyBlocks.map((p) => p.name)).toContain("Which questions to ask");
  });

  it("asks a form agent every service's questions and a flow agent only the opening, with the rest drawn", async () => {
    await createAgentFromTemplate({ name: "Form", templateId: "estate-agency", authoringMode: "form" });
    const formFields = (calls.setAgentFields?.[0] as { fields: { key: string }[] }).fields.map((f) => f.key);
    expect(formFields).toContain("viewingDate");
    expect(calls.setAgentFlow).toHaveLength(0);

    calls.setAgentFields = [];
    await createAgentFromTemplate({ name: "Flow", templateId: "estate-agency", authoringMode: "flow" });
    const flowFields = (calls.setAgentFields?.[0] as { fields: { key: string }[] }).fields.map((f) => f.key);
    expect(flowFields).not.toContain("viewingDate");
    const drawn = (calls.setAgentFlow?.[0] as { body: { flow: { nodes: { kind: string }[] } } }).body.flow;
    expect(drawn.nodes.some((n) => n.kind === "transfer")).toBe(true);
  });

  it("saves no draft for a blank template, which has nothing to stage", async () => {
    await createAgentFromTemplate({ name: "Blank", templateId: "blank", authoringMode: "form" });
    expect(calls.saveDraft).toHaveLength(0);
  });
});
