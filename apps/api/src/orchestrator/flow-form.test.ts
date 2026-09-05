import type { Flow, FlowEdge, FlowField, FlowNode } from "@ansa/shared";
import { FLOW_VERSION, emptyFlow } from "@ansa/shared";
import { describe, expect, it } from "vitest";

import type { CollectedField } from "../tenancy/captured-fields";

import { createFlowForm } from "./flow-form";
import type { FormDirector } from "./form";
import { createForm } from "./form";

/**
 * The graph director, held against the list director wherever the two can be compared.
 *
 * The single most important test in this file is `walks a straight line exactly as the list
 * director does`. Branching is worth nothing if it changes what an agent that does not branch
 * does, and the only way to know is to build one configuration twice — once as a list, once
 * as a graph — and drive both through the same script. Everything else here is a case that
 * only exists because there is a graph: a branch taken, a branch abandoned mid-call, a value
 * given for a branch nobody is on, and four ways for a graph to be unwalkable.
 */

const question = (over: Partial<FlowField> = {}): FlowField => ({
  key: "policyNumber",
  type: "reference",
  prompt: "What is your policy number?",
  capture: "speech",
  confirm: "readback",
  required: true,
  pattern: "",
  attempts: 3,
  options: [],
  ...over,
});

/** The same question, said to the list director. One source, so parity means something. */
const asCollected = (field: FlowField): CollectedField => ({
  key: field.key,
  type: field.type,
  prompt: field.prompt,
  capture: field.capture,
  confirm: field.confirm,
  required: field.required,
  pattern: field.pattern,
  attempts: field.attempts,
  options: field.options,
});

const at = (id: string, kind: FlowNode["kind"], over: Partial<FlowNode> = {}): FlowNode => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...over,
});

const collect = (field: FlowField): FlowNode => at(field.key, "collect", { field });

const flow = (nodes: readonly FlowNode[], edges: readonly FlowEdge[]): Flow => ({
  version: FLOW_VERSION,
  nodes,
  edges,
});

/** Straight through, one node to the next, ending at a hangup. */
const chain = (nodes: readonly FlowNode[]): Flow => {
  const edges: FlowEdge[] = [];
  for (let index = 0; index + 1 < nodes.length; index += 1) {
    const from = nodes[index];
    const to = nodes[index + 1];
    if (from === undefined || to === undefined) continue;
    edges.push({ from: from.id, to: to.id });
  }
  return flow(nodes, edges);
};

/**
 * One line of what a director did, at one point in a call.
 *
 * Recorded rather than asserted step by step so a parity failure says which turn diverged
 * instead of only that something did.
 */
interface Beat {
  readonly asked: string | null;
  readonly asking: string | null;
  readonly complete: boolean;
  readonly wantsReference: string | null;
}

/** Drive a director the way `armNextField` does, answering from a script. */
const run = (director: FormDirector, answers: Readonly<Record<string, string>>): Beat[] => {
  const beats: Beat[] = [];
  for (let guard = 0; guard < 12; guard += 1) {
    const next = director.outstanding();
    if (next !== null) director.beginAsking(next);
    beats.push({
      asked: next?.key ?? null,
      asking: director.asking()?.key ?? null,
      complete: director.complete(),
      wantsReference: director.forVolunteered("reference")?.key ?? null,
    });
    if (next === null) break;
    const answer = answers[next.key];
    if (answer === undefined) director.skip(next.key);
    else director.satisfy(next.key, answer, true);
  }
  return beats;
};

describe("a graph that does not branch", () => {
  /**
   * The de-risking test. A flow authored as a straight line is the same agent as a form
   * authored as a list, and if the two directors disagree about anything — order, when a
   * call is complete, where a volunteered value goes, which question a directed answer
   * belongs to — then branching has quietly changed every agent, not just the ones that
   * branch.
   */
  it("walks a straight line exactly as the list director does", () => {
    /* Engine-heard questions only. A choice or free text is where the two directors part on
       purpose: the list leaves them to the transcript, the graph waits for the model to record
       them, because a branch may depend on the answer. That difference is tested below, not
       hidden inside a parity claim. */
    const fields = [
      question({ key: "callerName", type: "name" }),
      question({ key: "policyNumber", type: "reference" }),
      question({ key: "claimNumber", type: "reference" }),
      question({ key: "callbackNumber", type: "phone", required: false }),
    ];

    const answers = {
      callerName: "Adaeze Okonkwo",
      policyNumber: "PM8592625",
      claimNumber: "CL4410021",
    };

    const listed = run(createForm(fields.map(asCollected)), answers);
    const walked = run(
      createFlowForm(chain([at("start", "start"), ...fields.map(collect), at("end", "hangup")])),
      answers,
    );

    expect(walked).toEqual(listed);
    // Guards the comparison itself: two directors that both did nothing would also match.
    expect(listed.map((beat) => beat.asked)).toEqual([
      "callerName",
      "policyNumber",
      "claimNumber",
      "callbackNumber",
      null,
    ]);
  });

  it("carries the operator's wording, format and attempts onto the question", () => {
    const director = createFlowForm(
      chain([
        at("start", "start"),
        collect(question({ prompt: "Policy number please", pattern: "PM\\d{7}", attempts: 2 })),
        at("end", "hangup"),
      ]),
    );

    const asked = director.outstanding();
    expect(asked?.prompt).toBe("Policy number please");
    /* Built by `createForm` itself rather than beside it, so anchoring and the length
       ceiling cannot drift between the two directors. */
    expect(asked?.matches("PM8592625")).toBe(true);
    expect(asked?.matches("PM8592625-OLD")).toBe(false);
    expect(director.reject("policyNumber").again).toBe(true);
    expect(director.reject("policyNumber").again).toBe(false);
    expect(director.attemptsFor("policyNumber")).toBe(3);
  });

  it("asks for nothing on the empty flow a new canvas starts as", () => {
    const director = createFlowForm(emptyFlow());
    expect(director.outstanding()).toBeNull();
    expect(director.forVolunteered("reference")).toBeNull();
    expect(director.complete()).toBe(true);
  });
});

/**
 * A claim, routed by how much it is worth.
 *
 * Large claims need a BVN and go to an assessor; small ones take a callback number and end.
 * The smallest graph that has all four of the things only a graph can have: a decide, two
 * branches of different lengths, a required question on each, and a terminal that is not the
 * end of a list.
 */
const claimFlow = (): Flow =>
  flow(
    [
      at("start", "start"),
      collect(question({ key: "claimAmount", type: "amount" })),
      at("size", "decide", { on: "claimAmount" }),
      collect(question({ key: "bvn", type: "bvn" })),
      collect(question({ key: "assessorPhone", type: "phone" })),
      at("assessor", "transfer"),
      collect(question({ key: "callbackNumber", type: "phone" })),
      at("end", "hangup"),
    ],
    [
      { from: "start", to: "claimAmount" },
      { from: "claimAmount", to: "size", port: "got" },
      { from: "size", to: "bvn", when: { greaterThan: 500000 } },
      { from: "size", to: "callbackNumber", otherwise: true },
      { from: "bvn", to: "assessorPhone" },
      { from: "assessorPhone", to: "assessor" },
      { from: "callbackNumber", to: "end" },
    ],
  );

describe("a branch", () => {
  it("is chosen by the value the decide reads", () => {
    const big = createFlowForm(claimFlow());
    expect(big.outstanding()?.key).toBe("claimAmount");
    big.satisfy("claimAmount", "1200000", true);
    expect(big.outstanding()?.key).toBe("bvn");

    const small = createFlowForm(claimFlow());
    small.satisfy("claimAmount", "250000", true);
    expect(small.outstanding()?.key).toBe("callbackNumber");
  });

  it("falls to otherwise when the value is not a number the operator described", () => {
    const director = createFlowForm(claimFlow());
    /* A caller who said something the amount parser could not turn into a figure must not
       be routed by a comparison that silently read it as zero-or-anything. `otherwise` is
       the branch configured for exactly this, and it is the one that cannot be removed. */
    director.satisfy("claimAmount", "not sure yet", true);
    expect(director.outstanding()?.key).toBe("callbackNumber");
  });

  it("does not hold the call open for a required question on the branch not taken", () => {
    const director = createFlowForm(claimFlow());
    director.satisfy("claimAmount", "250000", true);
    // `bvn` is required and unanswered, and it is on the branch this caller is not on.
    expect(director.complete()).toBe(false);
    director.satisfy("callbackNumber", "+2348021184429", true);
    expect(director.complete()).toBe(true);
    expect(director.values.has("bvn")).toBe(false);
  });

  it("is complete the moment the walk reaches a terminal node", () => {
    const director = createFlowForm(claimFlow());
    director.satisfy("claimAmount", "1200000", true);
    director.satisfy("bvn", "22233344455", true);
    expect(director.complete()).toBe(false);
    director.satisfy("assessorPhone", "+2348021184429", true);
    // Transfer, not an emptied list: there is simply nowhere further to walk.
    expect(director.outstanding()).toBeNull();
    expect(director.complete()).toBe(true);
  });
});

describe("a caller who corrects the value a branch was chosen on", () => {
  /**
   * The case most likely to be missed, because a director that remembers where it is has to
   * unwind to handle it and a director that recomputes does not.
   *
   * A caller says twelve hundred thousand, is sent down the assessor branch, gives a BVN, and
   * then says no, it was two fifty. The branch they are on is now the wrong one. What must
   * happen: the decide is re-evaluated, the call moves to the other branch, and the BVN they
   * already read out is kept — they said it — while no longer being something the call waits
   * for.
   */
  it("moves to the other branch, keeping what was collected on the abandoned one", () => {
    const director = createFlowForm(claimFlow());
    director.satisfy("claimAmount", "1200000", true);
    expect(director.outstanding()?.key).toBe("bvn");
    director.satisfy("bvn", "22233344455", true);
    expect(director.outstanding()?.key).toBe("assessorPhone");

    director.satisfy("claimAmount", "250000", true);

    expect(director.outstanding()?.key).toBe("callbackNumber");
    // Kept, because the caller said it. A correction to one answer is not a reason to
    // throw away another, and a tool three nodes on may still want it.
    expect(director.values.get("bvn")?.value).toBe("22233344455");
    // No longer required: `assessorPhone` was never given and is no longer on the path.
    director.satisfy("callbackNumber", "+2348021184429", true);
    expect(director.complete()).toBe(true);
  });

  it("comes back to the branch it left without asking again for what it already has", () => {
    const director = createFlowForm(claimFlow());
    director.satisfy("claimAmount", "1200000", true);
    director.satisfy("bvn", "22233344455", true);
    director.satisfy("claimAmount", "250000", true);
    expect(director.outstanding()?.key).toBe("callbackNumber");

    // Corrected back. The BVN is still in hand, so the walk passes straight through it.
    director.satisfy("claimAmount", "1200000", true);
    expect(director.outstanding()?.key).toBe("assessorPhone");
  });
});

describe("a value volunteered for a branch nobody is on", () => {
  it("is wanted by the reachable question, not refused because the path avoids it", () => {
    const director = createFlowForm(claimFlow());
    director.satisfy("claimAmount", "250000", true);

    /* The caller is on the small-claim branch and reads out their BVN anyway. They said it.
       Refusing it would mean asking for it again if the claim is re-quoted upward, which is
       the agent looking like it was not listening. */
    expect(director.forVolunteered("bvn")?.key).toBe("bvn");
    director.satisfy("bvn", "22233344455", true);

    director.satisfy("claimAmount", "1200000", true);
    // Already answered, so the branch is entered and the question is never put.
    expect(director.outstanding()?.key).toBe("assessorPhone");
  });

  it("prefers a question on the current path over one only reachable elsewhere", () => {
    /* Built so the two answers differ. `assessorPhone` sits one step off the decide and
       `callbackNumber` two steps down the other branch, so the reachable-anywhere fallback
       would pick the wrong one: nearest-first is the tie-break of last resort, and the path
       the caller is actually on beats it. */
    const director = createFlowForm(
      flow(
        [
          at("start", "start"),
          collect(question({ key: "claimAmount", type: "amount" })),
          at("size", "decide", { on: "claimAmount" }),
          collect(question({ key: "assessorPhone", type: "phone" })),
          at("assessor", "transfer"),
          collect(question({ key: "policyNumber", type: "reference" })),
          collect(question({ key: "callbackNumber", type: "phone" })),
          at("end", "hangup"),
        ],
        [
          { from: "start", to: "claimAmount" },
          { from: "claimAmount", to: "size" },
          { from: "size", to: "assessorPhone", when: { greaterThan: 500000 } },
          { from: "size", to: "policyNumber", otherwise: true },
          { from: "assessorPhone", to: "assessor" },
          { from: "policyNumber", to: "callbackNumber" },
          { from: "callbackNumber", to: "end" },
        ],
      ),
    );

    director.satisfy("claimAmount", "250000", true);
    expect(director.forVolunteered("phone")?.key).toBe("callbackNumber");
  });

  it("wants nothing of a kind that is already settled everywhere", () => {
    const director = createFlowForm(claimFlow());
    director.satisfy("claimAmount", "250000", true);
    director.satisfy("callbackNumber", "+2348021184429", true);
    director.satisfy("assessorPhone", "+2348021184429", true);
    expect(director.forVolunteered("phone")).toBeNull();
  });
});

describe("a caller who declines", () => {
  it("leaves by the gave-up port rather than the one an answer would have taken", () => {
    const director = createFlowForm(
      flow(
        [
          at("start", "start"),
          collect(question({ key: "callbackNumber", type: "phone", required: false })),
          collect(question({ key: "policyNumber", type: "reference" })),
          at("sorry", "hangup"),
        ],
        [
          { from: "start", to: "callbackNumber" },
          { from: "callbackNumber", to: "policyNumber", port: "got" },
          { from: "callbackNumber", to: "sorry", port: "gave-up" },
        ],
      ),
    );

    expect(director.outstanding()?.key).toBe("callbackNumber");
    director.skip("callbackNumber");
    expect(director.outstanding()).toBeNull();
    expect(director.complete()).toBe(true);
  });

  it("takes the got port once they give it after all", () => {
    const director = createFlowForm(
      flow(
        [
          at("start", "start"),
          collect(question({ key: "callbackNumber", type: "phone", required: false })),
          collect(question({ key: "policyNumber", type: "reference" })),
          at("sorry", "hangup"),
        ],
        [
          { from: "start", to: "callbackNumber" },
          { from: "callbackNumber", to: "policyNumber", port: "got" },
          { from: "callbackNumber", to: "sorry", port: "gave-up" },
        ],
      ),
    );

    director.skip("callbackNumber");
    director.satisfy("callbackNumber", "+2348021184429", true);
    expect(director.outstanding()?.key).toBe("policyNumber");
  });
});

describe("a graph the director cannot walk", () => {
  /**
   * Every one of these returns null and reports complete, and none of them throws.
   *
   * CLAUDE.md's absolute rule: a failure degrades into speech, never silence. A director
   * that held the call open on a question it could never choose would be waiting forever
   * with the line open, which is the one outcome this product does not allow. `outstanding()
   * === null` must always imply `complete()`, or the orchestrator has a state it cannot
   * leave.
   */
  const unwalkable: readonly (readonly [string, Flow])[] = [
    ["no start", chain([collect(question()), at("end", "hangup")])],
    [
      "two starts, with no defensible guess between them",
      flow(
        [at("a", "start"), at("b", "start"), collect(question()), at("end", "hangup")],
        [
          { from: "a", to: "policyNumber" },
          { from: "b", to: "end" },
          { from: "policyNumber", to: "end" },
        ],
      ),
    ],
    [
      "a dead end before the question",
      flow([at("start", "start"), collect(question()), at("end", "hangup")], []),
    ],
    [
      "an edge to a node that is not there",
      flow([at("start", "start")], [{ from: "start", to: "ghost" }]),
    ],
    [
      "a decide that matches nothing and has no otherwise",
      flow(
        [at("start", "start"), at("size", "decide", { on: "claimAmount" }), collect(question())],
        [
          { from: "start", to: "size" },
          { from: "size", to: "policyNumber", when: { equals: "large" } },
        ],
      ),
    ],
    [
      "a cycle that escaped validation",
      flow(
        [at("start", "start"), at("loop", "say", { text: "Thank you for holding." })],
        [
          { from: "start", to: "loop" },
          // The step ceiling is the only thing between this and a spinning event loop.
          { from: "loop", to: "loop" },
        ],
      ),
    ],
  ];

  for (const [name, broken] of unwalkable) {
    it(`asks for nothing and does not throw: ${name}`, () => {
      const director = createFlowForm(broken);
      expect(() => director.outstanding()).not.toThrow();
      expect(director.outstanding()).toBeNull();
      expect(director.complete()).toBe(true);
    });
  }

  it("survives a document that is not a graph at all", () => {
    /* Typed `Flow`, but `flow_document` is jsonb and a row edited by hand in psql is
       whatever somebody typed. The cast is the point of the test: this is the shape the
       director will actually be handed on the day it goes wrong. */
    const rubbish = { version: FLOW_VERSION, nodes: "nodes", edges: null } as unknown as Flow;
    const director = createFlowForm(rubbish);
    expect(director.outstanding()).toBeNull();
    expect(director.complete()).toBe(true);
    expect(director.forVolunteered("reference")).toBeNull();
    expect(director.reject("policyNumber").again).toBe(false);
  });

  it("stops a cycle within the step ceiling rather than spinning", () => {
    const long: FlowNode[] = [at("start", "start")];
    for (let index = 0; index < 40; index += 1) long.push(at(`say-${index}`, "say", { text: "." }));
    const edges: FlowEdge[] = [{ from: "start", to: "say-0" }];
    for (let index = 0; index < 40; index += 1) {
      edges.push({ from: `say-${index}`, to: index === 39 ? "say-0" : `say-${index + 1}` });
    }

    const director = createFlowForm(flow(long, edges));
    const started = Date.now();
    expect(director.outstanding()).toBeNull();
    /* A ceiling and not a wall clock is what bounds this, but the assertion is about the
       thing that matters: the event loop of a process carrying other people's calls was not
       held. A real spin never returns at all and the test times out. */
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("nodes that are not questions", () => {
  it("passes straight through say and tool nodes", () => {
    const director = createFlowForm(
      chain([
        at("start", "start"),
        at("greet", "say", { text: "Greet the caller and say you can look up a claim." }),
        at("lookup", "tool", { tool: "claim_status" }),
        collect(question()),
        at("end", "hangup"),
      ]),
    );
    expect(director.outstanding()?.key).toBe("policyNumber");
  });

  it("holds at a choice for the model to record, arming the engine for nothing", () => {
    const director = createFlowForm(
      chain([
        at("start", "start"),
        collect(question({ key: "branch", type: "choice", prompt: "Which branch?", options: ["Lagos", "Abuja"] })),
        collect(question()),
        at("end", "hangup"),
      ]),
    );
    /* The engine cannot hear "Lagos, I think" as a value with a shape, so nothing is armed —
       but the walk does not move past the question either. Moving past it is what made every
       caller take the `otherwise` arm of a branch that read this answer. */
    expect(director.outstanding()).toBeNull();
    expect(director.complete()).toBe(false);
    expect(director.guidance()?.next).toEqual({
      kind: "ask-choice",
      key: "branch",
      prompt: "Which branch?",
      options: ["Lagos", "Abuja"],
    });
    expect(director.answerable("branch")).toEqual({ type: "choice", options: ["Lagos", "Abuja"] });
    expect(director.answerable("policyNumber")).toBeNull();

    // The model records it, as `record_answer` does, and the walk moves on.
    director.satisfy("branch", "Lagos", false);
    expect(director.outstanding()?.key).toBe("policyNumber");
    expect(director.guidance()?.next).toMatchObject({ kind: "ask", field: { key: "policyNumber" } });
    director.satisfy("policyNumber", "PM8592625", true);
    expect(director.complete()).toBe(true);
    expect(director.guidance()?.next).toEqual({ kind: "end" });
  });

  it("branches on a recorded choice, which is the case every menu is", () => {
    const director = createFlowForm(
      flow(
        [
          at("start", "start"),
          collect(question({ key: "intent", type: "choice", options: ["rent", "buy"] })),
          at("d", "decide", { on: "intent" }),
          collect(question({ key: "budget", type: "amount" })),
          collect(question({ key: "deposit", type: "amount" })),
          at("end", "hangup"),
        ],
        [
          { from: "start", to: "intent" },
          { from: "intent", to: "d" },
          { from: "d", to: "budget", when: { equals: "rent" } },
          { from: "d", to: "deposit", otherwise: true },
          { from: "budget", to: "end" },
          { from: "deposit", to: "end" },
        ],
      ),
    );
    expect(director.outstanding()).toBeNull();
    director.satisfy("intent", "Rent", false);
    expect(director.outstanding()?.key).toBe("budget");
  });

  it("tells the model what to cover and which tools to use on the way to the next question", () => {
    const director = createFlowForm(
      chain([
        at("start", "start"),
        at("greet", "say", { text: "Mention the weekend promotion" }),
        at("look", "tool", { tool: "lookup_policy" }),
        collect(question()),
        at("thanks", "say", { text: "Thank them for waiting" }),
        at("end", "hangup"),
      ]),
    );
    expect(director.guidance()).toEqual({
      cover: ["Mention the weekend promotion"],
      tools: ["lookup_policy"],
      next: { kind: "ask", field: expect.objectContaining({ key: "policyNumber" }) },
    });
    /* Once the question is answered, what came before it has been covered. Only what lies
       between that answer and the end is still owed. */
    director.satisfy("policyNumber", "PM8592625", true);
    expect(director.guidance()).toEqual({ cover: ["Thank them for waiting"], tools: [], next: { kind: "end" } });
  });

  it("steers towards a person when the graph ends in a transfer", () => {
    const director = createFlowForm(chain([at("start", "start"), at("hand", "transfer")]));
    expect(director.guidance()?.next).toEqual({ kind: "transfer" });
    expect(director.complete()).toBe(true);
  });

  it("says nothing about a graph it cannot walk, leaving the standing prompt in charge", () => {
    const director = createFlowForm({ version: 1, nodes: [], edges: [] });
    expect(director.guidance()).toBeNull();
  });

  it("branches a confirm node on whether the caller agreed to the value", () => {
    const confirming = (): Flow =>
      flow(
        [
          at("start", "start"),
          collect(question()),
          at("check", "confirm", { on: "policyNumber" }),
          collect(question({ key: "callerName", type: "name" })),
          collect(question({ key: "dateOfBirth", type: "date" })),
          at("end", "hangup"),
        ],
        [
          { from: "start", to: "policyNumber" },
          { from: "policyNumber", to: "check" },
          { from: "check", to: "callerName", port: "yes" },
          { from: "check", to: "dateOfBirth", port: "no" },
          { from: "callerName", to: "end" },
          { from: "dateOfBirth", to: "end" },
        ],
      );

    const agreed = createFlowForm(confirming());
    agreed.satisfy("policyNumber", "PM8592625", true);
    expect(agreed.outstanding()?.key).toBe("callerName");

    /* A value nothing has confirmed — one the model heard, or one the operator chose not to
       have read back at the time — stops the walk at the confirm step: the model is to read
       it back, and the engine is armed for nothing until the caller has answered. */
    const unconfirmed = createFlowForm(confirming());
    unconfirmed.satisfy("policyNumber", "PM8592625", false);
    expect(unconfirmed.outstanding()).toBeNull();
    expect(unconfirmed.complete()).toBe(false);
    expect(unconfirmed.guidance()?.next).toEqual({ kind: "confirm", key: "policyNumber", value: "PM8592625" });

    // They agree: the step takes "yes", and the value is confirmed from here on.
    expect(unconfirmed.decide("policyNumber", true)).toBe(true);
    expect(unconfirmed.outstanding()?.key).toBe("callerName");
    expect(unconfirmed.values.get("policyNumber")?.confirmed).toBe(true);

    // They say it is wrong: the step takes "no" — and keeps taking it until a new value comes.
    const denied = createFlowForm(confirming());
    denied.satisfy("policyNumber", "PM8592625", false);
    expect(denied.decide("policyNumber", false)).toBe(true);
    expect(denied.outstanding()?.key).toBe("dateOfBirth");
    denied.satisfy("policyNumber", "PM8592626", false);
    expect(denied.guidance()?.next).toEqual({ kind: "confirm", key: "policyNumber", value: "PM8592626" });

    // Nothing to have agreed to: a key with no value cannot be decided, and the step says no.
    const empty = createFlowForm(confirming());
    expect(empty.decide("policyNumber", true)).toBe(false);

    // A question the caller gave up on has no value either, so the step it feeds says no
    // rather than reading back nothing — and the walk does not stop to ask.
    const gaveUp = createFlowForm(confirming());
    gaveUp.skip("policyNumber");
    expect(gaveUp.outstanding()?.key).toBe("dateOfBirth");
    expect(gaveUp.guidance()?.next.kind).toBe("ask");

    // A no from the caller cannot undo what the engine already confirmed with them: the
    // engine's readback is the one that counts, and the step still says yes.
    const engineConfirmed = createFlowForm(confirming());
    engineConfirmed.satisfy("policyNumber", "PM8592625", true);
    expect(engineConfirmed.decide("policyNumber", false)).toBe(true);
    expect(engineConfirmed.outstanding()?.key).toBe("callerName");
  });
});

describe("a directed answer", () => {
  it("belongs to the question the agent asked, not to the one it is now on", () => {
    const director = createFlowForm(claimFlow());
    const first = director.outstanding();
    expect(first).not.toBeNull();
    if (first === null) return;

    director.beginAsking(first);
    expect(director.asking()?.key).toBe("claimAmount");
    director.satisfy("claimAmount", "250000", true);
    // Otherwise the caller's next sentence is parsed as another answer to a settled
    // question, which is the same trap the list director avoids.
    expect(director.asking()).toBeNull();
  });
});
