import { describe, expect, it } from "vitest";

import type { KnowledgeHit } from "@ansa/db";
import { asAgentId, asCallId, asOrganizationId, type AgentId, type OrganizationId } from "@ansa/shared";
import { createToolDispatcher, createToolRegistry, modelMessage, registerInternalTools } from "@ansa/tools";

import { silentLog } from "./fakes";
import {
  hasKnowledge,
  knowledgeDefinitions,
  knowledgeTools,
  KNOWLEDGE_TOOL_NAME,
  MAX_PASSAGES,
  type SearchKnowledge,
} from "./knowledge";

const ORGANIZATION = asOrganizationId("5c3d0a5e-1f6d-4f6f-9b3a-0f2d7c8a4e11");
const OTHER_ORGANIZATION = asOrganizationId("11111111-1111-4111-8111-111111111111");
const AGENT = asAgentId("2b9f4c1e-77aa-4b2d-9a0c-3d5e6f7a8b90");
const OTHER_AGENT = asAgentId("99999999-9999-4999-8999-999999999999");
const CALL = asCallId("call-1");

const hit = (partial: Partial<KnowledgeHit> = {}): KnowledgeHit => ({
  sourceId: "source-1",
  sourceName: "Delivery FAQ.docx",
  question: null,
  body: "We deliver anywhere in Oyo State for two thousand naira.",
  rank: 1,
  ...partial,
});

interface Asked {
  readonly organizationId: OrganizationId;
  readonly agentId: AgentId;
  readonly query: string;
  readonly limit: number;
}

const setup = (
  options: {
    readonly hits?: readonly KnowledgeHit[];
    readonly agentId?: AgentId | null;
    readonly hasSources?: boolean;
    readonly limit?: number;
    readonly search?: SearchKnowledge;
  } = {},
) => {
  const asked: Asked[] = [];
  const search: SearchKnowledge =
    options.search ??
    (async (organizationId, agentId, query, limit) => {
      asked.push({ organizationId, agentId, query, limit });
      return options.hits ?? [];
    });

  const availability = {
    agentId: options.agentId === undefined ? AGENT : options.agentId,
    hasSources: options.hasSources ?? true,
  };

  const registry = createToolRegistry();
  registerInternalTools(registry, knowledgeTools({ ...availability, search, limit: options.limit }));

  // What the wiring sees, and the only route the raw passages take out of the dispatcher.
  const results: unknown[] = [];
  const dispatcher = createToolDispatcher({
    registry,
    log: silentLog,
    onResult: (_call, value) => results.push(value),
  });

  const call = (args: Record<string, unknown> = { query: "do you deliver to Ibadan" }) =>
    dispatcher.dispatch({
      organizationId: ORGANIZATION,
      callId: CALL,
      direction: "inbound",
      name: KNOWLEDGE_TOOL_NAME,
      args,
    });

  return { asked, availability, registry, results, call };
};

describe("what gets registered", () => {
  it("registers nothing at all for an agent with no sources", () => {
    // Not "registers a search that always comes back empty". The model is never told it
    // can look anything up, so it never spends a turn and three seconds finding out.
    const { registry } = setup({ hasSources: false });

    expect(registry.listFor(ORGANIZATION)).toEqual([]);
    expect(knowledgeDefinitions({ agentId: AGENT, hasSources: false })).toEqual([]);
  });

  it("registers nothing for an unregistered number", () => {
    // No agent answered, so there is nobody's knowledge base to read.
    const { registry } = setup({ agentId: null });

    expect(registry.listFor(ORGANIZATION)).toEqual([]);
    expect(hasKnowledge({ agentId: null, hasSources: true })).toBe(false);
  });

  it("registers exactly the definition the prompt is told about, at read tier", () => {
    const { registry } = setup();

    const registered = registry.listFor(ORGANIZATION);
    expect(registered.map((d) => d.name)).toEqual([KNOWLEDGE_TOOL_NAME]);
    expect(registered.map((d) => d.name)).toEqual(
      knowledgeDefinitions({ agentId: AGENT, hasSources: true }).map((d) => d.name),
    );
    expect(registered[0]?.riskTier).toBe("read");
  });

  it("offers the model no way to name the agent whose sources it reads", () => {
    // The isolation is the absence of the parameter. If it ever appears here, a caller's
    // phrasing can choose whose knowledge base to open.
    const { registry } = setup();

    const parameters = registry.listFor(ORGANIZATION)[0]?.parameters;
    expect(Object.keys((parameters as { properties: object }).properties)).toEqual(["query"]);
  });
});

describe("scoping", () => {
  it("searches the call's organization and the agent resolved at ingress", async () => {
    const { asked, call } = setup({ hits: [hit()] });

    await call({ query: "delivery to Ibadan" });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.organizationId).toBe(ORGANIZATION);
    expect(asked[0]?.agentId).toBe(AGENT);
    expect(asked[0]?.query).toBe("delivery to Ibadan");
  });

  it("ignores an agent id the model tries to pass in the arguments", async () => {
    const { asked, call } = setup({ hits: [hit()] });

    await call({ query: "delivery", agentId: OTHER_AGENT, organizationId: OTHER_ORGANIZATION });

    expect(asked[0]?.agentId).toBe(AGENT);
    expect(asked[0]?.organizationId).toBe(ORGANIZATION);
  });
});

describe("bounding the result", () => {
  it("asks the store for no more passages than a turn has room for", async () => {
    const { asked, call } = setup({ hits: [hit()] });

    await call();

    expect(asked[0]?.limit).toBe(MAX_PASSAGES);
  });

  it("refuses to raise the ceiling when the wiring asks for more", async () => {
    const { asked, call } = setup({ hits: [hit()], limit: 25 });

    await call();

    expect(asked[0]?.limit).toBe(MAX_PASSAGES);
  });

  it("speaks only the first three when the store hands back ten", async () => {
    // A store that ignores the limit must not be able to put ten passages into a turn
    // with room for two sentences.
    const bodies = Array.from({ length: 10 }, (_, i) => `Passage number ${String(i)} says something.`);
    const { call } = setup({ hits: bodies.map((body, i) => hit({ body, sourceId: `s${String(i)}`, rank: i })) });

    const outcome = await call();

    expect(outcome.kind).toBe("ok");
    for (const body of bodies.slice(0, MAX_PASSAGES)) expect(outcome.speech).toContain(body);
    for (const body of bodies.slice(MAX_PASSAGES)) expect(outcome.speech).not.toContain(body);
  });

  it("cuts a long passage at a sentence rather than mid-clause", async () => {
    // Half a sentence is worse than a short one: the model finishes it, and finishing it
    // is the invention this tool exists to stop.
    const body = `${"We open at nine in the morning. ".repeat(20)}The last line nobody reads.`;
    const { call } = setup({ hits: [hit({ body })] });

    const outcome = await call();

    expect(outcome.speech.length).toBeLessThan(600);
    expect(outcome.speech).toMatch(/[.!?]$/);
    expect(outcome.speech).not.toContain("The last line nobody reads");
  });

  it("bounds the query it sends to the store", async () => {
    const { asked, call } = setup({ hits: [hit()] });

    await call({ query: "a".repeat(5000) });

    expect(asked[0]?.query.length).toBeLessThanOrEqual(300);
  });
});

describe("what the model is told", () => {
  it("never hands back raw JSON", async () => {
    // R5.4.3, and the dispatcher enforces it too — this proves the summary does not lean
    // on that.
    const { call } = setup({ hits: [hit({ question: "Do you deliver to Ibadan?" })] });

    const outcome = await call();

    expect(outcome.kind).toBe("ok");
    expect(outcome.speech.startsWith("{")).toBe(false);
    expect(outcome.speech).not.toContain("sourceId");
    expect(outcome.speech).not.toContain("Delivery FAQ.docx");
  });

  it("leads with the question a passage answers, so three passages are told apart", async () => {
    const { call } = setup({
      hits: [
        hit({ question: "Do you deliver to Ibadan?", body: "Yes, for two thousand naira." }),
        hit({ question: "How long does it take?", body: "Two working days." }),
      ],
    });

    const outcome = await call();

    expect(outcome.speech).toContain("Do you deliver to Ibadan? Yes, for two thousand naira.");
    expect(outcome.speech).toContain("How long does it take? Two working days.");
  });

  it("marks where the organisation's own words start", async () => {
    const { call } = setup({ hits: [hit()] });

    const outcome = await call();

    expect(outcome.speech).toContain("From what's on file.");
  });

  it("carries the source ids out for the bookkeeping, and none of them into the speech", async () => {
    // `recordKnowledgeRetrieval` needs the ids of the sources that answered, and the
    // dispatcher's `onResult` is the only way they leave. Dropping them from the result
    // would make "which source is earning its keep" unanswerable.
    const { call, results } = setup({ hits: [hit({ sourceId: "src-7", sourceName: "Delivery FAQ.docx" })] });

    const outcome = await call();

    expect(results).toEqual([
      {
        query: "do you deliver to Ibadan",
        passages: [
          {
            sourceId: "src-7",
            sourceName: "Delivery FAQ.docx",
            question: null,
            body: "We deliver anywhere in Oyo State for two thousand naira.",
          },
        ],
      },
    ]);
    expect(outcome.speech).not.toContain("src-7");
  });

  it("says it has nothing rather than saying nothing, when retrieval comes back empty", async () => {
    // An empty search is an answer, not a failure. Reported as a failure it becomes an
    // apology; reported as silence it becomes the model's own guess in the next sentence.
    const { call } = setup({ hits: [] });

    const outcome = await call();

    expect(outcome.kind).toBe("ok");
    expect(outcome.speech).toBe("I don't have anything on file about that.");
    expect(modelMessage(outcome)).toContain("I don't have anything on file about that.");
  });
});

describe("when it goes wrong", () => {
  it("degrades into speech when the model asks with no query", async () => {
    const { call } = setup();

    const outcome = await call({});

    expect(outcome.kind).toBe("failed");
    expect(outcome.speech.trim()).not.toBe("");
  });

  it("degrades into speech when the store is down", async () => {
    const { call } = setup({
      search: async () => {
        throw new Error("connection refused");
      },
    });

    const outcome = await call();

    expect(outcome.kind).toBe("failed");
    expect(outcome.speech.trim()).not.toBe("");
    // And the model is told it failed, so the next turn cannot report an answer it
    // never got.
    expect(modelMessage(outcome)).toContain("FAILED");
  });

  it("runs freely, with nothing to confirm in front of a question", async () => {
    const { call } = setup({ hits: [hit()] });

    const outcome = await call();

    expect(outcome.kind).toBe("ok");
    expect(outcome.tier).toBe("read");
  });
});
