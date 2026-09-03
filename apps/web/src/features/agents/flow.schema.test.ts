import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MAX_CAPTURED_FIELDS } from "./agents.schema";

import {
  FLOW_FIELD_TYPES,
  FLOW_LIMITS,
  FLOW_NODE_KINDS,
  FLOW_VERSION,
  emptyFlow,
  flowFromFields,
  flowEdgeSchema,
  flowFieldSchema,
  flowNodeSchema,
  flowSchema,
  readFlow,
} from "./flow.schema";
import {
  FLOW_FIELD_TYPES as SHARED_FIELD_TYPES,
  FLOW_LIMITS as SHARED_LIMITS,
  FLOW_NODE_KINDS as SHARED_NODE_KINDS,
  FLOW_VERSION as SHARED_VERSION,
} from "@ansa/shared/flow";

/**
 * The console's half of a contract, and the test that keeps it a mirror.
 *
 * `packages/shared/src/flow.ts` is the shape both halves agree on, and the risk is that the
 * two drift: the canvas draws a field the API has never heard of, and nobody finds out until
 * a publish is rejected.
 *
 * Two instruments, because the two halves of the contract survive compilation differently.
 * The *values* — the field types, the node kinds, the limits — are imported from the shared
 * module and compared directly, which is exact and says where a mismatch is. The *interfaces*
 * cannot be: types erase at build time, so there is nothing left at runtime to compare
 * against, and the shared source is read as text instead. That half is not elegant. It is the
 * only thing that fails when somebody adds a property to `FlowNode` and this schema does not
 * grow one, which is precisely the change nothing else would catch.
 */

const SHARED = readFileSync(
  fileURLToPath(new URL("../../../../../packages/shared/src/flow.ts", import.meta.url)),
  "utf8",
);

/** The property names an exported interface declares, in source order. */
const propertiesOf = (source: string, name: string): readonly string[] => {
  const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1];
  if (body === undefined) throw new Error(`${name} is not in packages/shared/src/flow.ts any more.`);
  return [...body.matchAll(/^\s*readonly (\w+)\??:/gm)].map((match) => match[1] ?? "");
};

describe("the shared contract", () => {
  it("declares the same node properties this schema parses", () => {
    /* An added property is the drift that costs most: the API stores it, the console strips
       it on the way back through, and a round trip through this tab silently deletes it. */
    expect([...propertiesOf(SHARED, "FlowNode")]).toEqual(Object.keys(flowNodeSchema.shape));
  });

  it("declares the same edge properties this schema parses", () => {
    expect([...propertiesOf(SHARED, "FlowEdge")]).toEqual(Object.keys(flowEdgeSchema.shape));
  });

  it("declares the same field properties this schema parses", () => {
    expect([...propertiesOf(SHARED, "FlowField")]).toEqual(Object.keys(flowFieldSchema.shape));
  });

  it("names the same field types and node kinds", () => {
    expect([...FLOW_FIELD_TYPES]).toEqual([...SHARED_FIELD_TYPES]);
    expect([...FLOW_NODE_KINDS]).toEqual([...SHARED_NODE_KINDS]);
  });

  it("sets the same limits and the same version", () => {
    expect(FLOW_VERSION).toBe(SHARED_VERSION);
    expect(FLOW_LIMITS).toEqual(SHARED_LIMITS);
  });
});

describe("what a new canvas starts as", () => {
  it("is answered, wired to the end of the call, and parses", () => {
    const flow = emptyFlow();
    expect(flowSchema.safeParse(flow).success).toBe(true);
    expect(flow.nodes.map((node) => node.kind)).toEqual(["start", "hangup"]);
    expect(flow.edges).toEqual([{ from: "start", to: "end" }]);
  });

  it("is what an agent with no graph gets", () => {
    /* A new agent has no `flow` column value at all, and an operator opening the tab must see
       a valid flow rather than an empty rectangle with no way in. */
    expect(readFlow(undefined)).toEqual(emptyFlow());
    expect(readFlow(null)).toEqual(emptyFlow());
  });
});

describe("reading a stored graph", () => {
  it("keeps a graph it understands", () => {
    const stored = {
      version: 1,
      nodes: [
        { id: "start", kind: "start", x: 0, y: 0 },
        { id: "ask", kind: "collect", x: 200, y: 0, field: { key: "policyNumber", type: "reference", prompt: "Your policy number?", capture: "keypad", confirm: "readback", pattern: "", attempts: 3, required: true, options: [] } },
        { id: "end", kind: "hangup", x: 400, y: 0 },
      ],
      edges: [
        { from: "start", to: "ask" },
        { from: "ask", to: "end", port: "got" },
      ],
    };
    expect(readFlow(stored)).toEqual(stored);
  });

  it("strips what the contract does not name", () => {
    /* The canvas sends back what it read. A property carried through would be one the API
       never agreed to store, arriving on a publish nobody thought was carrying it. */
    const read = readFlow({
      version: 1,
      nodes: [{ id: "start", kind: "start", x: 0, y: 0, colour: "red" }],
      edges: [],
    });
    expect(read?.nodes[0]).toEqual({ id: "start", kind: "start", x: 0, y: 0 });
  });

  it("refuses a graph it cannot draw rather than replacing it", () => {
    /* Null, never `emptyFlow()`. Substituting an empty graph would put two nodes on screen and
       overwrite the operator's real one on the next save with the failure to read it. */
    expect(readFlow("not a graph")).toBeNull();
    expect(readFlow({})).toBeNull();
    expect(readFlow({ version: 2, nodes: [], edges: [] })).toBeNull();
    expect(readFlow({ version: 1, nodes: [{ id: "x", kind: "wave", x: 0, y: 0 }], edges: [] })).toBeNull();
    expect(readFlow({ version: 1, nodes: [{ id: "x", kind: "say", x: "left", y: 0 }], edges: [] })).toBeNull();
  });

  it("refuses a graph past the limits both validators enforce", () => {
    const node = { id: "n", kind: "say" as const, x: 0, y: 0 };
    const nodes = Array.from({ length: FLOW_LIMITS.nodes + 1 }, (_, at) => ({ ...node, id: `n${at}` }));
    expect(readFlow({ version: 1, nodes, edges: [] })).toBeNull();
  });
});

describe("a question on the canvas", () => {
  it("takes the keys the captured-field list will accept", () => {
    const field = { key: "policyNumber", type: "reference", prompt: "", capture: "either", confirm: "none", pattern: "", attempts: 3, required: true, options: [] };
    expect(flowFieldSchema.safeParse(field).success).toBe(true);
  });

  it("refuses a key the projection onto capturedFields would reject", () => {
    /* Every collect node becomes an entry in that list on publish. A key accepted here and
       refused there is a graph that draws, saves, and cannot be published. */
    for (const key of ["", "policy-number", "2ndPolicy", "policy number"]) {
      expect(flowFieldSchema.safeParse({ key, type: "text", prompt: "", capture: "either", confirm: "none", pattern: "", attempts: 3, required: true, options: [] }).success).toBe(false);
    }
  });

  it("holds attempts inside the range the caller actually gets", () => {
    const field = { key: "k", type: "text", prompt: "", capture: "either", confirm: "none", pattern: "", attempts: 0, required: true, options: [] };
    expect(flowFieldSchema.safeParse(field).success).toBe(false);
    expect(flowFieldSchema.safeParse({ ...field, attempts: 11 }).success).toBe(false);
    expect(flowFieldSchema.safeParse({ ...field, attempts: 10 }).success).toBe(true);
  });
});

describe("a branch condition", () => {
  it("takes each of the four operators and nothing else", () => {
    for (const when of [{ equals: "renewal" }, { oneOf: ["renewal", "claim"] }, { isEmpty: true }, { greaterThan: 5000 }]) {
      expect(flowEdgeSchema.safeParse({ from: "a", to: "b", when }).success).toBe(true);
    }
    expect(flowEdgeSchema.safeParse({ from: "a", to: "b", when: { matches: "^RE" } }).success).toBe(false);
  });

  it("refuses two operators in one condition rather than keeping the first", () => {
    /* Stripping the second would lose a branch between the canvas and the call, and the
       operator would be looking at an edge that routes on something else. */
    expect(flowEdgeSchema.safeParse({ from: "a", to: "b", when: { equals: "renewal", oneOf: ["claim"] } }).success).toBe(false);
  });

  it("takes otherwise only as true", () => {
    expect(flowEdgeSchema.safeParse({ from: "a", to: "b", otherwise: true }).success).toBe(true);
    expect(flowEdgeSchema.safeParse({ from: "a", to: "b", otherwise: false }).success).toBe(false);
  });
});

/**
 * The seed a flow-authored agent is created with.
 *
 * Its job is not to be pretty, it is to be publishable and to be the questions the operator
 * actually chose. An agent set to run as a graph and holding none is refused at publish, so
 * a seed that came out unreadable or empty would strand somebody on a screen that will not
 * let them go live — with no obvious cause, because the canvas would look fine.
 */
describe("drawing a template's form as a flow", () => {
  const field = (key: string) => ({
    key,
    type: "text" as const,
    prompt: `What is your ${key}?`,
    capture: "either" as const,
    confirm: "none" as const,
    pattern: "",
    attempts: 3,
    required: true,
    options: [] as string[],
  });

  it("produces a graph the contract accepts", () => {
    expect(flowSchema.safeParse(flowFromFields([field("name"), field("reference")])).success).toBe(
      true,
    );
  });

  /* The order a caller is asked in is the order the operator put the questions in. A graph
     that reordered them would be a different conversation wearing the same name. */
  it("keeps the form's order, one collect per question, start to hangup", () => {
    const drawn = flowFromFields([field("name"), field("reference"), field("amount")]);

    expect(drawn.nodes.map((node) => node.kind)).toEqual([
      "start",
      "collect",
      "collect",
      "collect",
      "hangup",
    ]);
    expect(drawn.nodes.flatMap((node) => (node.field === undefined ? [] : [node.field.key]))).toEqual(
      ["name", "reference", "amount"],
    );
  });

  it("wires every step to the next one and nothing to nowhere", () => {
    const drawn = flowFromFields([field("name"), field("reference")]);
    const ids = new Set(drawn.nodes.map((node) => node.id));

    expect(drawn.edges).toHaveLength(drawn.nodes.length - 1);
    for (const edge of drawn.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });

  /* Several templates open with a greeting and ask nothing. That is a real agent and it must
     still draw as a call that answers and hangs up rather than as an unpublishable stub. */
  it("draws a template with no questions as an empty flow", () => {
    expect(flowFromFields([])).toEqual(emptyFlow());
  });

  it("never draws more questions than the form cap allows", () => {
    const many = Array.from({ length: MAX_CAPTURED_FIELDS + 5 }, (_, i) => field(`k${i}`));

    expect(flowFromFields(many).nodes.filter((node) => node.kind === "collect")).toHaveLength(
      MAX_CAPTURED_FIELDS,
    );
  });

  /* Node ids are positional, so renaming a key on the canvas cannot orphan an edge. */
  it("does not build node ids out of the field keys", () => {
    const drawn = flowFromFields([field("reference")]);

    expect(drawn.nodes.map((node) => node.id)).not.toContain("reference");
  });
});
