"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { CONTROL, IconButton, Notice, SelectField, TextAreaField, TextField } from "@/components/ui";
import { cn } from "@/lib/cn";

/* The validator itself, from `@ansa/shared`, imported by subpath so a browser bundle does not
   pull the package barrel — which reaches `node:buffer` through the audio helpers.

   Imported rather than mirrored, unlike the zod schemas above it. Those mirror a module of
   types and constants; this is the rule that decides whether a conversation can answer a
   phone, the publish gate runs exactly this function, and a second opinion about that in the
   console would eventually tell somebody their graph was fine while the API refused it. */
import { validateFlow } from "@ansa/shared/flow-validate";

import {
  FLOW_FIELD_TYPES,
  emptyFlow,
  flowSchema,
  readFlow,
  type Flow,
  type FlowCondition,
  type FlowEdge,
  type FlowField,
  type FlowNode,
  type FlowNodeKind,
} from "../flow.schema";
import { FlowProblems } from "./flow-problems";
import { FlowStatus } from "./flow-status";

/**
 * The conversation flow, authored as a graph.
 *
 * The graph is part of the workspace's draft rather than a drawing beside it. Every edit is
 * written into one hidden field on the workspace's own form, bound to it by id: `name="flow"`,
 * carrying JSON in the shape `PUT /agents/{agentId}/flow` takes as its body. That endpoint
 * stages rather than applies — the graph lands in the same unpublished draft that holds the
 * greeting, and a call answered a second later still walks whatever the agent walks today.
 *
 * JSON in one field rather than flat `FormData` keys, for the reason the policy editor gives:
 * a structure expressed as indexed key names needs a convention, and the first dropped index
 * silently merges two steps.
 *
 * So this canvas has no Save, Publish or Test call button of its own. The workspace header
 * carries all three, the graph goes live with everything else on the same publish, and a
 * second save button would be a second answer to "is this live yet".
 *
 * `flow` is a seed rather than a subscription: it is read once, into state. A panel whose
 * underlying values change is remounted with a `key` by the workspace — see `shownAs` in
 * `agent-workspace.tsx` — which is how every other tab here solves the same problem.
 *
 * Nodes are dragged, wired and deleted with pointer events and pointer capture (not mouse
 * events), so a trackpad, a mouse and a touchscreen all behave the same.
 *
 * Port positions are measured from the rendered DOM (`offsetTop` of each out-port element)
 * rather than computed from a fixed layout, because a `collect` node has two outputs, a `say`
 * node has one and a `decide` node has as many as it has branches — a hard-coded offset would
 * wire the wrong one the first time a node with a different output count was dragged in. The
 * cost of that is the reason for the visibility watcher below: `offsetTop` reads 0 for an
 * element inside a `hidden` ancestor, and this canvas lives inside a tab panel that starts
 * hidden.
 */

interface NodeKindSpec {
  readonly title: string;
  readonly colour: string;
  readonly body: (node: FlowNode) => string;
}

const NODE_KINDS: Record<FlowNodeKind, NodeKindSpec> = {
  start: { title: "Call answered", colour: "var(--ok)", body: () => "The caller has picked up, or has dialled in." },
  say: { title: "Say something", colour: "var(--accent)", body: (n) => (n.text ?? "") === "" ? "Nothing to cover here yet." : `“${n.text ?? ""}”` },
  collect: {
    title: "Collect a value",
    colour: "var(--ok)",
    body: (n) => `${n.field?.key === "" || n.field === undefined ? "unnamed" : n.field.key} · ${n.field?.capture ?? "either"} · ${n.field?.confirm ?? "none"}`,
  },
  confirm: { title: "Confirm a value", colour: "var(--ok)", body: (n) => `Read back ${n.on === "" || n.on === undefined ? "a value you have not named" : n.on}` },
  decide: { title: "Branch", colour: "var(--accent)", body: (n) => `On ${n.on === "" || n.on === undefined ? "a value you have not named" : n.on}` },
  tool: { title: "Call a tool", colour: "var(--warn)", body: (n) => (n.tool ?? "") === "" ? "No tool chosen yet." : (n.tool ?? "") },
  transfer: { title: "Transfer to human", colour: "var(--bad)", body: () => "Rings a person. Irreversible tools land here." },
  hangup: { title: "End the call", colour: "var(--ink-3)", body: () => "Says goodbye and hangs up." },
};

const PALETTE: readonly { readonly group: string; readonly kinds: readonly FlowNodeKind[] }[] = [
  { group: "Speech", kinds: ["say", "collect", "confirm"] },
  { group: "Logic", kinds: ["decide", "tool"] },
  { group: "Ending", kinds: ["transfer", "hangup"] },
];

/* ------------------------------------------------------------------ conditions */

const OPERATORS = [
  { value: "equals", label: "is" },
  { value: "oneOf", label: "is one of" },
  { value: "isEmpty", label: "was not given" },
  { value: "greaterThan", label: "is over" },
] as const;

type Operator = (typeof OPERATORS)[number]["value"];

const asOperator = (raw: string): Operator => OPERATORS.find((o) => o.value === raw)?.value ?? "equals";

const operatorOf = (when: FlowCondition): Operator =>
  "equals" in when ? "equals" : "oneOf" in when ? "oneOf" : "isEmpty" in when ? "isEmpty" : "greaterThan";

const valueOf = (when: FlowCondition): string =>
  "equals" in when ? when.equals : "oneOf" in when ? when.oneOf.join(", ") : "isEmpty" in when ? "" : String(when.greaterThan);

const conditionFrom = (operator: Operator, raw: string): FlowCondition => {
  if (operator === "isEmpty") return { isEmpty: true };
  if (operator === "oneOf") return { oneOf: raw.split(",").map((part) => part.trim()).filter((part) => part !== "") };
  if (operator === "greaterThan") {
    const value = Number(raw);
    return { greaterThan: Number.isFinite(value) ? value : 0 };
  }
  return { equals: raw };
};

/** Short enough to sit on a wire. The condition in words, not in JSON. */
const conditionLabel = (when: FlowCondition): string => {
  if ("equals" in when) return `is ${when.equals === "" ? "…" : when.equals}`;
  if ("oneOf" in when) return when.oneOf.length === 0 ? "is one of …" : `is ${when.oneOf.join(" or ")}`;
  if ("isEmpty" in when) return "was not given";
  return `is over ${when.greaterThan}`;
};

/* ------------------------------------------------------------------------ ports */

/**
 * What leaves a node, and how the edge that leaves by it is recognised.
 *
 * Ports are derived, not declared. Most kinds have a fixed pair — a `collect` either got the
 * value or gave up — but a `decide` node's outputs *are* its branches, and a branch lives on
 * the edge as a `when` condition. The list here used to read `["renewal", "claim", "other"]`,
 * which was one insurance demo's seed data hard-coded as a model: no operator could add a
 * fourth branch, and those three words were spoken on behalf of every organisation.
 *
 * `holds` and `wire` belong to the port rather than to a switch at each call site because the
 * discriminator differs by kind. A fixed port is named (`edge.port === "got"`), a branch is
 * identified by the condition it carries, and `otherwise` by its own flag. Ask the port.
 */
interface Port {
  /** Stable within one node, and used only to key the measured DOM position. */
  readonly key: string;
  readonly label: string;
  /** The edge leaving by this port, if one has been drawn. At most one. */
  readonly holds: (edge: FlowEdge) => boolean;
  /** The edge this port makes when it is dropped on a node. */
  readonly wire: (to: string) => FlowEdge;
}

const onlyPort = (from: string): Port => ({
  key: "next",
  label: "",
  holds: (edge) => edge.from === from && edge.port === undefined && edge.when === undefined && edge.otherwise === undefined,
  wire: (to) => ({ from, to }),
});

const namedPort = (from: string, name: string, label: string): Port => ({
  key: name,
  label,
  holds: (edge) => edge.from === from && edge.port === name,
  wire: (to) => ({ from, to, port: name }),
});

const conditional =
  (from: string) =>
  (edge: FlowEdge): edge is FlowEdge & { when: FlowCondition } =>
    edge.from === from && edge.when !== undefined;

/**
 * A decide node's ports: its branches, then the one it cannot be without.
 *
 * `otherwise` is last and has no delete: callers say unlisted things, and a branch node with
 * nowhere to send them is a call that stops. The contract makes the same point by allowing
 * exactly one per decide node.
 *
 * `pending` holds branches an operator has added but not yet wired anywhere. They cannot be
 * edges — an edge needs somewhere to go — so they live beside the graph until they are
 * dropped on a node, and are not saved. A branch that points nowhere routes nothing.
 */
const branchPorts = (from: string, edges: readonly FlowEdge[], pending: readonly FlowCondition[]): readonly Port[] => [
  ...edges.filter(conditional(from)).map((edge, at) => ({
    key: `when:${at}`,
    label: conditionLabel(edge.when),
    /* Identity, not shape. Two branches can carry the same condition while the second is
       half typed, and matching by value would move both edges at once. */
    holds: (other: FlowEdge) => other === edge,
    wire: (to: string) => ({ from, to, when: edge.when }),
  })),
  ...pending.map((when, at) => ({
    key: `pending:${at}`,
    label: conditionLabel(when),
    holds: () => false,
    wire: (to: string) => ({ from, to, when }),
  })),
  {
    key: "otherwise",
    label: "otherwise",
    holds: (edge: FlowEdge) => edge.from === from && edge.otherwise === true,
    wire: (to: string) => ({ from, to, otherwise: true as const }),
  },
];

const portsOf = (node: FlowNode, edges: readonly FlowEdge[], pending: readonly FlowCondition[]): readonly Port[] => {
  switch (node.kind) {
    case "start":
    case "say":
      return [onlyPort(node.id)];
    case "collect":
      return [namedPort(node.id, "got", "got it"), namedPort(node.id, "gave-up", "gave up")];
    case "confirm":
      return [namedPort(node.id, "yes", "yes"), namedPort(node.id, "no", "no")];
    case "tool":
      return [namedPort(node.id, "ok", "ok"), namedPort(node.id, "failed", "failed")];
    case "decide":
      return branchPorts(node.id, edges, pending);
    case "transfer":
    case "hangup":
      return [];
  }
};

/* ---------------------------------------------------------------------- history */

interface History {
  readonly past: readonly Flow[];
  readonly present: Flow;
  readonly future: readonly Flow[];
}

/** Deep enough to cover a session's worth of mistakes, shallow enough not to hold the page. */
const HISTORY_DEPTH = 60;

const remember = (history: History, next: Flow): History => ({
  past: [...history.past, history.present].slice(-HISTORY_DEPTH),
  present: next,
  future: [],
});

const stepBack = (history: History): History => {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
};

const stepForward = (history: History): History => {
  const next = history.future[0];
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future: history.future.slice(1) };
};

/* ----------------------------------------------------------------------- layout */

const NODE_W = 208;
const HEAD = 15;
const COLUMN = 260;
const ROW = 150;

interface Point {
  readonly x: number;
  readonly y: number;
}

const bezier = (p1: Point, p2: Point): string => {
  const dx = Math.max(46, Math.abs(p2.x - p1.x) * 0.45);
  return `M${p1.x} ${p1.y} C${p1.x + dx} ${p1.y},${p2.x - dx} ${p2.y},${p2.x} ${p2.y}`;
};

/**
 * Tidy up: columns by distance from the answer, rows by arrival.
 *
 * A grid in id order — what this used to do — reads as a shuffle, because the one thing a
 * flow has that a list does not is a direction. Breadth-first from the `start` node puts the
 * conversation left to right in the order a call meets it. Anything the walk never reaches
 * goes in a column of its own past the end, which is also the clearest way to see that a step
 * is unreachable without drawing a validation report for it.
 */
const tidied = (flow: Flow): Flow => {
  const first = flow.nodes.find((node) => node.kind === "start") ?? flow.nodes[0];
  const depth = new Map<string, number>();
  const queue: string[] = first === undefined ? [] : [first.id];
  if (first !== undefined) depth.set(first.id, 0);

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) continue;
    const here = depth.get(id) ?? 0;
    for (const edge of flow.edges) {
      if (edge.from !== id || depth.has(edge.to)) continue;
      depth.set(edge.to, here + 1);
      queue.push(edge.to);
    }
  }

  const unreached = Math.max(0, ...[...depth.values()].map((value) => value + 1));
  const filled = new Map<number, number>();
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const column = depth.get(node.id) ?? unreached;
      const row = filled.get(column) ?? 0;
      filled.set(column, row + 1);
      return { ...node, x: 40 + column * COLUMN, y: 40 + row * ROW };
    }),
  };
};

/* ------------------------------------------------------------------- new nodes */

const blankField = (): FlowField => ({
  key: "",
  type: "text",
  prompt: "",
  capture: "either",
  confirm: "none",
  pattern: "",
  attempts: 3,
  required: true,
  options: [],
});

/**
 * A node with nothing filled in, rather than a node with somebody else's example in it.
 *
 * The seeded version of this ("policyNumber", "Good afternoon, Kano General Insurance") put
 * one demo's words into every new step, and a placeholder that reads as real is the kind that
 * gets published. Empty is visible; a wrong greeting is not.
 */
const blankNode = (id: string, kind: FlowNodeKind, x: number, y: number): FlowNode => {
  if (kind === "say") return { id, kind, x, y, text: "" };
  if (kind === "collect") return { id, kind, x, y, field: blankField() };
  if (kind === "tool") return { id, kind, x, y, tool: "" };
  if (kind === "decide" || kind === "confirm") return { id, kind, x, y, on: "" };
  return { id, kind, x, y };
};

/**
 * An id nothing in this graph is already using.
 *
 * A module-level counter — what this was — is shared by every canvas the page ever mounts and
 * knows nothing about the ids a stored graph arrived with, so reopening a saved flow and
 * adding a step could produce a second `n101` and wire an edge to the wrong one.
 */
const freshId = (taken: ReadonlySet<string>): string => {
  let at = taken.size + 1;
  while (taken.has(`n${at}`)) at += 1;
  return `n${at}`;
};

/* ---------------------------------------------------------------------- saving */

interface Readiness {
  /** Null when the graph is saveable. Otherwise why it is not, in the operator's terms. */
  readonly problem: string | null;
  /** The nodes the problem is about, so the message has somewhere to land. */
  readonly nodes: ReadonlySet<string>;
}

/**
 * Whether this graph is one the API would accept, checked before it is offered.
 *
 * The hidden field is not rendered while the answer is no, and an absent field means "leave
 * the stored graph alone" — the same rule the policy editor follows when a document will not
 * parse, and for the same reason. Writing the half we understood would delete the rest.
 */
const readiness = (flow: Flow): Readiness => {
  const parsed = flowSchema.safeParse(flow);
  if (parsed.success) return { problem: null, nodes: new Set() };

  const nodes = new Set<string>();
  for (const issue of parsed.error.issues) {
    if (issue.path[0] !== "nodes") continue;
    const at = issue.path[1];
    const node = typeof at === "number" ? flow.nodes[at] : undefined;
    if (node !== undefined) nodes.add(node.id);
  }
  return { problem: parsed.error.issues[0]?.message ?? "This graph is not in a shape that can be saved.", nodes };
};

/* ------------------------------------------------------------------ the canvas */

const BranchRow = ({
  when,
  onChange,
  onRemove,
}: {
  readonly when: FlowCondition;
  readonly onChange: (next: FlowCondition) => void;
  readonly onRemove: () => void;
}) => {
  const operator = operatorOf(when);
  return (
    <div className="flex items-center gap-1.5">
      <select
        aria-label="How this branch is chosen"
        className={cn(CONTROL, "w-[116px] flex-none px-2 py-1 text-[12px]")}
        value={operator}
        onChange={(event) => onChange(conditionFrom(asOperator(event.target.value), valueOf(when)))}
      >
        {OPERATORS.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
      {operator !== "isEmpty" && (
        <input
          aria-label="What this branch matches"
          className={cn(CONTROL, "min-w-0 px-2 py-1 text-[12px]")}
          value={valueOf(when)}
          placeholder={operator === "oneOf" ? "renewal, claim" : operator === "greaterThan" ? "5000" : "renewal"}
          onChange={(event) => onChange(conditionFrom(operator, event.target.value))}
        />
      )}
      <IconButton aria-label="Remove this branch" className="size-6 flex-none" onClick={onRemove}>
        ×
      </IconButton>
    </div>
  );
};

interface FlowCanvasProps {
  /**
   * The graph this agent has: the draft's where there is one, the published one otherwise.
   *
   * The same "draft over live" rule every other tab follows — showing the live graph under a
   * header saying "unpublished changes" would show somebody the opposite of what they are
   * about to publish. `GET /agents/{agentId}/flow` returns both halves for that choice.
   *
   * `unknown` on purpose. It arrives as `jsonb` through a generated client, which is to say
   * untrusted and typed by whatever the API's schema says this week. Parsing it here means
   * the canvas cannot be handed a graph nobody validated, and that one place decides what an
   * absent graph is (`emptyFlow()`) and what an unreadable one is (a message, and no save).
   */
  readonly flow: unknown;
  /**
   * The id of the workspace form this canvas writes into.
   *
   * A plain `form=` attribute, the same way every other tab reaches the one form: the graph
   * is submitted by the header's Save and Publish, and this component owns neither.
   */
  readonly publishForm: string;
  /**
   * Which editor the agent is built in.
   *
   * Decides whether an untouched canvas is submitted. For a flow agent the graph is the
   * conversation and always rides the save. For a form agent this panel is rendered hidden
   * behind the tabs like every other, and submitting its empty starting graph on every save
   * wrote a two-node canvas onto agents nobody had drawn — harmless until somebody switched
   * one to a flow and found "their" canvas already there.
   */
  readonly authoringMode: "form" | "flow";
  /**
   * How many problems on this canvas would refuse a publish, reported on every edit.
   *
   * Required, not optional: the workspace disables Publish on it, and an optional callback
   * nobody passed would be a button that lets somebody try a publish the API refuses.
   */
  readonly onBlockingProblems: (count: number) => void;
}

export const FlowCanvas = ({ flow, publishForm, authoringMode, onBlockingProblems }: FlowCanvasProps) => {
  /* Read once, on mount. Later renders keep the operator's work in front of them; the
     workspace remounts this panel with a `key` when the document underneath it changes. */
  const [loaded] = useState(() => readFlow(flow));
  const [history, setHistory] = useState<History>(() => ({ past: [], present: loaded ?? emptyFlow(), future: [] }));
  const [pending, setPending] = useState<Readonly<Record<string, readonly FlowCondition[]>>>({});
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [temp, setTemp] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // Bumped whenever the canvas needs its port positions re-read from the DOM — after a tab
  // that was hidden becomes visible, chiefly, since `offsetTop` is 0 until then.
  const [tick, setTick] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const portRefs = useRef(new Map<string, HTMLSpanElement>());
  const dragRef = useRef<{ id: string; dx: number; dy: number; from: Flow } | null>(null);
  const wireRef = useRef<{ from: string; port: Port } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const coalescing = useRef<string | null>(null);

  /* Re-checked only when the graph itself changes. Panning and dragging a wire re-render at
     pointer rate without touching a single node, and re-parsing 120 steps to answer a
     question whose answer cannot have moved is a cost that only shows up on a slower laptop
     than the one this was written on. Dragging a node does rewrite the graph, and does pay. */
  const ready = useMemo(() => readiness(history.present), [history.present]);

  /* The tab this canvas lives in starts `hidden`, and `Tabs` toggles that attribute on an
     ancestor it owns rather than unmounting this component — so nothing about this
     component's own props or state changes when the tab opens. A MutationObserver on the
     nearest `[role=tabpanel]` is what notices instead. */
  useEffect(() => {
    const panel = rootRef.current?.closest('[role="tabpanel"]');
    if (!panel) return;
    const observer = new MutationObserver(() => {
      if (!panel.hasAttribute("hidden")) setTick((t) => t + 1);
    });
    observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    return () => observer.disconnect();
  }, []);

  /* A graph that will not parse is still a graph somebody drew. Drawing an empty one over it
     would submit two nodes into the draft on the next save and overwrite the real thing with
     our failure to read it, so this tab shows the failure and writes nothing at all. */
  if (loaded === null) {
    return (
      <div ref={rootRef} data-flow-canvas>
        <Notice tone="error">
          This agent&rsquo;s flow is not in a shape this console understands, so it is not shown and
          nothing here will change it. The other tabs still save and publish as usual. Tell us
          which agent this is and we will look at the stored graph.
        </Notice>
      </div>
    );
  }

  const { nodes, edges } = history.present;

  /**
   * One graph edit, and where undo gets its entries.
   *
   * `coalesce` folds consecutive edits to the same thing into one entry: typing a field name
   * is a single action to the person doing it, and a stack with an entry per keystroke is a
   * stack nobody can use. Anything else starts a new entry.
   */
  const edit = (change: (current: Flow) => Flow, coalesce?: string) => {
    const merge = coalesce !== undefined && coalesce === coalescing.current;
    coalescing.current = coalesce ?? null;
    setHistory((current) => {
      const next = change(current.present);
      if (next === current.present) return current;
      return merge ? { ...current, present: next, future: [] } : remember(current, next);
    });
  };

  const byId = (id: string): FlowNode | undefined => nodes.find((n) => n.id === id);
  const portsFor = (node: FlowNode): readonly Port[] => portsOf(node, edges, pending[node.id] ?? []);

  const outPoint = (node: FlowNode, key: string, at: number): Point => {
    const dot = portRefs.current.get(`${node.id}:${key}`);
    return dot ? { x: node.x + NODE_W, y: node.y + dot.offsetTop + 5.5 } : { x: node.x + NODE_W, y: node.y + HEAD + at * 20 };
  };
  const inPoint = (node: FlowNode): Point => ({ x: node.x, y: node.y + HEAD });

  // Read fresh on every render — `tick` exists purely to force one after visibility flips.
  void tick;
  const edgePaths = edges.map((edge, at) => {
    const from = byId(edge.from);
    const to = byId(edge.to);
    if (!from || !to) return null;
    const ports = portsFor(from);
    const index = ports.findIndex((port) => port.holds(edge));
    const p1 = outPoint(from, ports[index]?.key ?? "", Math.max(index, 0));
    const p2 = inPoint(to);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 - 5 };
    return { key: at, d: bezier(p1, p2), label: ports[index]?.label ?? "", mid };
  });

  const localPoint = (e: ReactPointerEvent): Point => {
    const box = canvasRef.current?.getBoundingClientRect();
    return { x: e.clientX - (box?.left ?? 0) - pan.x, y: e.clientY - (box?.top ?? 0) - pan.y };
  };

  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>, node: FlowNode) => {
    setSelected(node.id);
    dragRef.current = { id: node.id, dx: e.clientX - node.x, dy: e.clientY - node.y, from: history.present };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onHeaderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const x = Math.round(e.clientX - drag.dx);
    const y = Math.round(e.clientY - drag.dy);
    /* Moves the present without recording it. The whole gesture becomes one history entry on
       pointer up, so undo puts the node back where it was picked up rather than a pixel back. */
    setHistory((current) => ({
      ...current,
      present: { ...current.present, nodes: current.present.nodes.map((n) => (n.id === drag.id ? { ...n, x, y } : n)) },
    }));
  };
  const onHeaderPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag === null) return;
    coalescing.current = null;
    setHistory((current) => (current.present === drag.from ? current : remember({ ...current, present: drag.from }, current.present)));
  };

  const onOutPortPointerDown = (e: ReactPointerEvent<HTMLSpanElement>, node: FlowNode, port: Port) => {
    wireRef.current = { from: node.id, port };
    setTemp({ x1: 0, y1: 0, x2: 0, y2: 0 });
    e.currentTarget.setPointerCapture(e.pointerId);
    e.stopPropagation();
    e.preventDefault();
  };
  const onOutPortPointerMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const wire = wireRef.current;
    if (!wire) return;
    const from = byId(wire.from);
    if (!from) return;
    const ports = portsFor(from);
    const p1 = outPoint(from, wire.port.key, Math.max(ports.findIndex((port) => port.key === wire.port.key), 0));
    const p2 = localPoint(e);
    setTemp({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
  };
  const onOutPortPointerUp = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const wire = wireRef.current;
    wireRef.current = null;
    setTemp(null);
    if (!wire) return;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const dropNode = target?.closest("[data-flow-node]");
    const to = dropNode?.getAttribute("data-flow-node");
    if (to === null || to === undefined || to === wire.from) return;
    edit((f) => ({ ...f, edges: [...f.edges.filter((x) => !wire.port.holds(x)), wire.port.wire(to)] }));
    /* A branch that was waiting for somewhere to go now has one, so it is an edge and stops
       being pending. Leaving it would show the same branch twice. */
    if (wire.port.key.startsWith("pending:")) {
      const at = Number(wire.port.key.slice("pending:".length));
      setPending((all) => ({ ...all, [wire.from]: (all[wire.from] ?? []).filter((_, i) => i !== at) }));
    }
  };

  const onCanvasPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-flow-node], [data-canvas-bar]")) return;
    panRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelected(null);
  };
  const onCanvasPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p) return;
    setPan({ x: p.panX + (e.clientX - p.startX), y: p.panY + (e.clientY - p.startY) });
  };
  const onCanvasPointerUp = () => {
    panRef.current = null;
  };

  /**
   * The steps in the order a call meets them, for Tab.
   *
   * Cards are rendered in this order so that the DOM order — which is what Tab follows — is
   * the graph's order and not the order the steps happened to be added. Breadth-first from
   * the start, then whatever is unreachable, by position: the same shape Tidy up draws.
   */
  const inGraphOrder = useMemo(() => {
    const byIdHere = new Map(nodes.map((n) => [n.id, n]));
    const seen = new Set<string>();
    const ordered: FlowNode[] = [];
    const queue = nodes.filter((n) => n.kind === "start").map((n) => n.id);
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      const node = byIdHere.get(id);
      if (node === undefined) continue;
      ordered.push(node);
      for (const edge of edges) if (edge.from === id) queue.push(edge.to);
    }
    const stranded = nodes.filter((n) => !seen.has(n.id)).sort((a, b) => a.y - b.y || a.x - b.x);
    return [...ordered, ...stranded];
  }, [nodes, edges]);

  /** Wire one port to a step, the way a drop does — from the inspector, for the keyboard. */
  const connect = (port: Port, to: string) => {
    edit((f) => ({ ...f, edges: [...f.edges.filter((x) => !port.holds(x)), port.wire(to)] }));
    if (port.key.startsWith("pending:") && selected !== null) {
      const at = Number(port.key.slice("pending:".length));
      setPending((all) => ({ ...all, [selected]: (all[selected] ?? []).filter((_, i) => i !== at) }));
    }
  };

  /**
   * The keyboard on a step: select, delete, nudge, leave.
   *
   * Connecting is not here. Dragging a wire has no keyboard shape, so the inspector offers
   * "Connect to" on every port instead, which is a select and works with nothing but Tab and
   * Enter. Nudging is ten pixels, forty with Shift, and is one undo entry per press.
   */
  const onNodeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, n: FlowNode) => {
    if ((e.target as HTMLElement) !== e.currentTarget) return;
    const step = e.shiftKey ? 40 : 10;
    const nudge = (dx: number, dy: number) => {
      edit((f) => ({ ...f, nodes: f.nodes.map((m) => (m.id === n.id ? { ...m, x: m.x + dx, y: m.y + dy } : m)) }));
    };
    switch (e.key) {
      case "Enter":
      case " ":
        setSelected(n.id);
        break;
      case "Escape":
        setSelected(null);
        break;
      case "Delete":
      case "Backspace":
        if (n.kind !== "start") removeNode(n.id);
        break;
      case "ArrowLeft": nudge(-step, 0); break;
      case "ArrowRight": nudge(step, 0); break;
      case "ArrowUp": nudge(0, -step); break;
      case "ArrowDown": nudge(0, step); break;
      default:
        return;
    }
    e.preventDefault();
  };

  const addNode = (kind: FlowNodeKind) => {
    const id = freshId(new Set(nodes.map((n) => n.id)));
    edit((f) => ({ ...f, nodes: [...f.nodes, blankNode(id, kind, 120 - pan.x + ((f.nodes.length % 4) * 26), 460 - pan.y)] }));
    setSelected(id);
  };

  const removeNode = (id: string) => {
    edit((f) => ({ ...f, nodes: f.nodes.filter((n) => n.id !== id), edges: f.edges.filter((x) => x.from !== id && x.to !== id) }));
    setPending((all) => ({ ...all, [id]: [] }));
    setSelected((s) => (s === id ? null : s));
  };

  const removeEdge = (index: number) => {
    edit((f) => ({ ...f, edges: f.edges.filter((_, i) => i !== index) }));
  };

  /* No zoom on this canvas, so fitting means bringing the drawing back under the viewport
     rather than scaling it. It is the way back from having panned into empty space. */
  /**
   * Put one step on screen and select it, for a row in the problems list.
   *
   * Selecting without panning is the failure worth avoiding: the inspector changes to a node
   * the reader cannot see, which reads as the click having gone somewhere else entirely. The
   * node is placed a little in from the top-left rather than centred, because centring a node
   * whose problem is an edge hides the edge.
   */
  const focusNode = (nodeId: string): void => {
    const node = byId(nodeId);
    if (node === undefined) return;
    setSelected(nodeId);
    setPan({ x: 120 - node.x, y: 90 - node.y });
  };

  const fit = () => {
    const first = nodes[0];
    if (first === undefined) return setPan({ x: 0, y: 0 });
    setPan({ x: 24 - Math.min(...nodes.map((n) => n.x)), y: 24 - Math.min(...nodes.map((n) => n.y)) });
  };

  const tidyUp = () => {
    edit((f) => tidied(f));
    setPan({ x: 0, y: 0 });
  };

  const updateSelected = (patch: Partial<FlowNode>, what: string) => {
    edit((f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === selected ? { ...n, ...patch } : n)) }), `${selected ?? ""}:${what}`);
  };

  /* Creates the field if the node arrived without one. A `collect` node with no question is
     valid to store and impossible to publish, and the editor is where that gets fixed. */
  const updateField = (patch: Partial<FlowField>, what: string) => {
    edit(
      (f) => ({
        ...f,
        nodes: f.nodes.map((n) => (n.id === selected ? { ...n, field: { ...(n.field ?? blankField()), ...patch } } : n)),
      }),
      `${selected ?? ""}:field:${what}`,
    );
  };

  /* Recomputed from the graph on every edit, not memoised against a key: the graph is at
     most 120 nodes and the walk is linear, and a stale problem list is worse than a cheap
     one — it would tell somebody a step is fixed while the publish still refuses it. */
  const problems = validateFlow(history.present);
  const blockingCount = problems.filter((problem) => problem.blocking).length;
  useEffect(() => {
    onBlockingProblems(blockingCount);
  }, [blockingCount, onBlockingProblems]);
  /* The worst thing wrong with each step, for the mark on its card. A step with a blocking
     problem and a warning shows the blocking one; the panel below lists both. */
  const marked = useMemo(() => {
    const worst = new Map<string, "blocks" | "warns">();
    for (const problem of problems) {
      if (problem.nodeId === null) continue;
      if (problem.blocking) worst.set(problem.nodeId, "blocks");
      else if (!worst.has(problem.nodeId)) worst.set(problem.nodeId, "warns");
    }
    return worst;
  }, [problems]);

  const selectedNode = selected === null ? null : (byId(selected) ?? null);
  const branches = selectedNode === null ? [] : edges.filter(conditional(selectedNode.id));
  const waiting = selectedNode === null ? [] : (pending[selectedNode.id] ?? []);

  return (
    <div ref={rootRef} data-flow-canvas>
      {/* The graph rides the workspace's own form, as the body of `PUT /agents/:id/flow`.
          Absent while it cannot be parsed, because an absent field means "leave the stored
          graph alone" — see `readiness`. */}
      {/* Rides the save for a flow agent always, and for a form agent only once somebody has
          drawn on it — an untouched starting graph is not a decision anybody made. */}
      {ready.problem === null && (authoringMode === "flow" || history.past.length > 0) && (
        <input type="hidden" form={publishForm} name="flow" value={JSON.stringify(history.present)} />
      )}

      {ready.problem !== null && (
        <Notice tone="warn" className="mb-3.5">
          This flow is not saved with the rest until it is finished: {ready.problem} Everything
          else on the other tabs still saves and publishes.
        </Notice>
      )}

      {/* A phone cannot drag a wire between two cards it cannot show side by side. Saying so
          is more use than a canvas that pans forever; the questions themselves are one tab
          over, and every other tab works at this width. */}
      <Notice tone="info" className="mb-3.5 sm:hidden">
        The canvas needs a wider screen to draw on. The questions this flow asks are on the
        Data captured tab, and everything else about the agent can be edited here.
      </Notice>

      <div className="hidden items-start gap-3.5 sm:grid lg:grid-cols-[186px_minmax(0,1fr)_280px]">
        <div className="surface flex flex-col gap-0.5 rounded-xl p-2.5">
          {PALETTE.map((group) => (
            <div key={group.group}>
              <h6 className="mt-1 mb-1 ml-1.5 font-mono text-[9.5px] tracking-[0.13em] text-[var(--ink-3)] uppercase">
                {group.group}
              </h6>
              {group.kinds.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => addNode(kind)}
                  className="flex w-full cursor-grab items-center gap-2 rounded-lg px-2.5 py-[7px] text-left text-[12.5px] text-[var(--ink-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
                >
                  <span className="size-2 flex-none rounded-[3px]" style={{ background: NODE_KINDS[kind].colour }} />
                  {NODE_KINDS[kind].title}
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* One grid cell for the drawing and what is said about it, so the palette, this and
            the inspector stay three columns. Mounted as siblings, the status line took the
            inspector's column and the inspector wrapped under the palette. */}
        <div className="flex min-w-0 flex-col gap-3.5">
        <div
          ref={canvasRef}
          className={cn(
            /* As tall as the page allows, and never less than a working height. It was a
               fixed 560 pixels for a tab; on a page of its own the drawing gets the screen. */
            "relative h-[max(560px,calc(100vh-240px))] touch-none overflow-hidden rounded-xl border border-[var(--hairline)] bg-[var(--surface-2)] shadow-[var(--spec)]",
            panRef.current ? "cursor-grabbing" : "cursor-grab",
          )}
          style={{ backgroundImage: "radial-gradient(circle, var(--hairline) 1px, transparent 1px)", backgroundSize: "20px 20px" }}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
        >
          <div className="absolute inset-0" style={{ transform: `translate(${pan.x}px,${pan.y}px)`, transformOrigin: "0 0" }}>
            <svg className="pointer-events-none absolute inset-0 overflow-visible">
              {edgePaths.map((p) =>
                p === null ? null : (
                  <g key={p.key}>
                    <path
                      d={p.d}
                      fill="none"
                      stroke="var(--ink-3)"
                      strokeWidth={1.8}
                      style={{ pointerEvents: "stroke" }}
                      className="cursor-pointer hover:stroke-[var(--bad)]"
                      onClick={() => removeEdge(p.key)}
                    />
                    {p.label !== "" && (
                      <text x={p.mid.x} y={p.mid.y} textAnchor="middle" className="pointer-events-none fill-[var(--ink-3)] font-mono text-[9.5px]">
                        {p.label}
                      </text>
                    )}
                  </g>
                ),
              )}
              {temp !== null && (
                <path
                  d={bezier({ x: temp.x1, y: temp.y1 }, { x: temp.x2, y: temp.y2 })}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={1.8}
                  strokeDasharray="5 4"
                  className="pointer-events-none"
                />
              )}
            </svg>

            {inGraphOrder.map((n) => {
              const kind = NODE_KINDS[n.kind];
              const ports = portsFor(n);
              return (
                <div
                  key={n.id}
                  data-flow-node={n.id}
                  tabIndex={0}
                  role="button"
                  aria-pressed={n.id === selected}
                  aria-label={`${kind.title}${marked.has(n.id) ? ", has a problem" : ""}. Enter selects, Delete removes, arrows move.`}
                  onKeyDown={(e) => onNodeKeyDown(e, n)}
                  onFocus={() => setSelected(n.id)}
                  className={cn(
                    "focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none",
                    "glass absolute w-[208px] rounded-[13px] border select-none",
                    ready.nodes.has(n.id) || marked.get(n.id) === "blocks"
                      ? "border-[var(--bad)]"
                      : marked.get(n.id) === "warns"
                        ? "border-[var(--warn)]"
                      : n.id === selected
                        ? "border-[var(--accent)] shadow-[0_0_0_2px_var(--accent-soft)]"
                        : "border-[var(--hairline)]",
                  )}
                  style={{ left: n.x, top: n.y }}
                >
                  <div
                    className="flex cursor-grab items-center gap-[7px] border-b border-[var(--hairline)] px-2.5 py-2"
                    onPointerDown={(e) => onHeaderPointerDown(e, n)}
                    onPointerMove={onHeaderPointerMove}
                    onPointerUp={onHeaderPointerUp}
                  >
                    <span className="size-2 flex-none rounded-[3px]" style={{ background: kind.colour }} />
                    <b className="flex-1 truncate text-[12px] font-[620]">{kind.title}</b>
                    {/* The problems panel below names it; this is the mark that says which card
                        it is naming, so a step at the far end of a wide canvas is not found by
                        reading forty messages. Two channels, not one: the colour of the border
                        and this label, for anyone who cannot see the first. */}
                    {marked.has(n.id) && (
                      <span
                        role="img"
                        aria-label={marked.get(n.id) === "blocks" ? "has a problem that blocks publishing" : "has a warning"}
                        className={cn(
                          "flex-none rounded-full px-1.5 font-mono text-[9.5px] font-semibold tracking-[0.08em] uppercase",
                          marked.get(n.id) === "blocks"
                            ? "bg-[var(--bad-soft)] text-[var(--bad)]"
                            : "bg-[var(--warn-soft)] text-[var(--warn)]",
                        )}
                      >
                        {marked.get(n.id) === "blocks" ? "fix" : "check"}
                      </span>
                    )}
                    {n.kind !== "start" && (
                      <IconButton
                        aria-label="Delete node"
                        className="size-5"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeNode(n.id);
                        }}
                      >
                        ×
                      </IconButton>
                    )}
                  </div>
                  <div className="px-2.5 py-[9px] text-[12px] leading-[1.45] text-[var(--ink-2)]">{kind.body(n)}</div>
                  {ports.length > 0 && (
                    <div className="flex flex-col gap-1.5 px-2.5 pb-[9px]">
                      {ports.map((port) => (
                        <div key={port.key} className="flex h-3.5 items-center justify-end truncate font-mono text-[10.5px] text-[var(--ink-3)]">
                          {port.label}
                        </div>
                      ))}
                    </div>
                  )}
                  {n.kind !== "start" && (
                    <span className="absolute top-[15px] left-[-6px] size-[11px] rounded-full border-2 border-[var(--ink-3)] bg-[var(--surface-solid)]" />
                  )}
                  {ports.map((port, at) => (
                    <span
                      key={port.key}
                      ref={(el) => {
                        const key = `${n.id}:${port.key}`;
                        if (el) portRefs.current.set(key, el);
                        else portRefs.current.delete(key);
                      }}
                      className="absolute right-[-6px] size-[11px] cursor-crosshair rounded-full border-2 border-[var(--ink-3)] bg-[var(--surface-solid)] transition-transform hover:scale-125 hover:border-[var(--accent)]"
                      style={{ top: HEAD + at * 20 }}
                      onPointerDown={(e) => onOutPortPointerDown(e, n, port)}
                      onPointerMove={onOutPortPointerMove}
                      onPointerUp={onOutPortPointerUp}
                    />
                  ))}
                </div>
              );
            })}
          </div>

          {/* Canvas actions only. Save, Publish and Test call live in the workspace header,
              where they act on the whole agent rather than on this one tab. */}
          <div
            data-canvas-bar
            className="glass absolute bottom-3 left-3 z-[5] flex items-center gap-1.5 rounded-lg border border-[var(--hairline)] px-2 py-1.5 text-[11.5px] text-[var(--ink-3)]"
          >
            <span>
              {nodes.length} nodes · {edges.length} links
            </span>
            <span>·</span>
            <button type="button" className="underline" onClick={fit}>
              Fit
            </button>
            <button type="button" className="underline" onClick={tidyUp}>
              Tidy up
            </button>
            <button
              type="button"
              className={cn("underline", history.past.length === 0 && "opacity-40")}
              disabled={history.past.length === 0}
              onClick={() => {
                coalescing.current = null;
                setHistory(stepBack);
              }}
            >
              Undo
            </button>
            <button
              type="button"
              className={cn("underline", history.future.length === 0 && "opacity-40")}
              disabled={history.future.length === 0}
              onClick={() => {
                coalescing.current = null;
                setHistory(stepForward);
              }}
            >
              Redo
            </button>
          </div>
        </div>

        {/* Whether this graph could answer a phone, under the graph itself and recomputed on
            every edit rather than at publish. `validateFlow` is the same function the publish
            gate runs, so nobody reaches a refusal having been told here that it was fine. */}
        <FlowStatus steps={nodes} problems={problems} />
        <FlowProblems steps={nodes} problems={problems} onFocusNode={focusNode} />
        </div>

        <div className="surface rounded-xl p-4">
          {selectedNode === null ? (
            <p className="py-6 text-center text-[12.5px] leading-relaxed text-[var(--ink-3)]">
              Select a node to edit what it says and how it behaves.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <div>
                <p className="mb-1 font-mono text-[10px] tracking-[0.15em] text-[var(--ink-3)] uppercase">{selectedNode.kind}</p>
                <h3 className="text-[16px] font-[640] tracking-[-0.018em]">{NODE_KINDS[selectedNode.kind].title}</h3>
              </div>

              {/* Every way out of this step, and where it goes. The dots on the card do this
                  with a drag; this does it with a select, so a keyboard can wire a graph. */}
              {portsFor(selectedNode).length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[11px] font-medium text-[var(--ink-3)]">Where each way out leads</p>
                  {portsFor(selectedNode).map((port) => {
                    const current = edges.find((x) => port.holds(x))?.to ?? "";
                    return (
                      <label key={port.key} className="flex items-center gap-2 text-[12.5px]">
                        <span className="w-[92px] flex-none truncate font-mono text-[11px] text-[var(--ink-3)]">{port.label}</span>
                        <select
                          aria-label={`Where "${port.label}" leads`}
                          value={current}
                          onChange={(e) => {
                            if (e.target.value !== "") connect(port, e.target.value);
                          }}
                          className={CONTROL}
                        >
                          <option value="">— nowhere yet —</option>
                          {inGraphOrder
                            .filter((m) => m.id !== selectedNode.id && m.kind !== "start")
                            .map((m) => (
                              <option key={m.id} value={m.id}>
                                {NODE_KINDS[m.kind].title}: {m.field?.key ?? m.text?.slice(0, 30) ?? m.tool ?? m.on ?? m.id}
                              </option>
                            ))}
                        </select>
                      </label>
                    );
                  })}
                </div>
              )}

              {selectedNode.kind === "say" && (
                <TextAreaField
                  label="What to cover here"
                  value={selectedNode.text ?? ""}
                  onChange={(e) => updateSelected({ text: e.target.value }, "text")}
                  hint="An instruction at this point in the call, not a script. The agent puts it in its own words."
                />
              )}

              {selectedNode.kind === "collect" && (
                <>
                  <TextField
                    label="Field name"
                    value={selectedNode.field?.key ?? ""}
                    onChange={(e) => updateField({ key: e.target.value }, "key")}
                    className="font-mono"
                    hint="What the answer is stored under. Letters, digits and underscores."
                  />
                  <SelectField
                    label="Kind of value"
                    value={selectedNode.field?.type ?? "text"}
                    onChange={(e) => updateField({ type: FLOW_FIELD_TYPES.find((t) => t === e.target.value) ?? "text" }, "type")}
                  >
                    {FLOW_FIELD_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </SelectField>
                  <TextAreaField
                    label="How it asks"
                    value={selectedNode.field?.prompt ?? ""}
                    onChange={(e) => updateField({ prompt: e.target.value }, "prompt")}
                  />
                  <SelectField
                    label="Captured by"
                    value={selectedNode.field?.capture ?? "either"}
                    onChange={(e) => updateField({ capture: e.target.value === "speech" ? "speech" : e.target.value === "keypad" ? "keypad" : "either" }, "capture")}
                    hint="Keypad survives the codec; speech does not, for anything with a checkable structure."
                  >
                    <option value="speech">Speech</option>
                    <option value="keypad">Keypad</option>
                    <option value="either">Either</option>
                  </SelectField>
                  <SelectField
                    label="Confirmed by"
                    value={selectedNode.field?.confirm ?? "none"}
                    onChange={(e) => updateField({ confirm: e.target.value === "readback" ? "readback" : e.target.value === "spellback" ? "spellback" : "none" }, "confirm")}
                    hint="Enforced in the dispatch path, not asked of the model."
                  >
                    <option value="none">Nothing</option>
                    <option value="readback">Reading it back</option>
                    <option value="spellback">Spelling it back</option>
                  </SelectField>
                </>
              )}

              {(selectedNode.kind === "confirm" || selectedNode.kind === "decide") && (
                <TextField
                  label={selectedNode.kind === "confirm" ? "Value to read back" : "Value to branch on"}
                  value={selectedNode.on ?? ""}
                  onChange={(e) => updateSelected({ on: e.target.value }, "on")}
                  className="font-mono"
                  hint={
                    selectedNode.kind === "decide"
                      ? "A branch reads something the caller was asked for. Opening hours are not one of those — the agent is told whether you are open and says so, rather than routing on it."
                      : undefined
                  }
                />
              )}

              {selectedNode.kind === "tool" && (
                <TextField
                  label="Tool"
                  value={selectedNode.tool ?? ""}
                  onChange={(e) => updateSelected({ tool: e.target.value }, "tool")}
                  className="font-mono"
                  hint="A tool already enabled on the Tools tab. Placing a node here does not enable one."
                />
              )}

              {selectedNode.kind === "decide" && (
                <div>
                  <span className="mb-1.5 block text-[12.5px] font-medium">Branches</span>
                  <div className="flex flex-col gap-1.5">
                    {branches.map((edge, at) => (
                      <BranchRow
                        key={`when:${at}`}
                        when={edge.when}
                        onChange={(when) =>
                          edit(
                            (f) => ({ ...f, edges: f.edges.map((x) => (x === edge ? { ...x, when } : x)) }),
                            `${selectedNode.id}:branch:${at}`,
                          )
                        }
                        onRemove={() => edit((f) => ({ ...f, edges: f.edges.filter((x) => x !== edge) }))}
                      />
                    ))}
                    {waiting.map((when, at) => (
                      <BranchRow
                        key={`pending:${at}`}
                        when={when}
                        onChange={(next) =>
                          setPending((all) => ({
                            ...all,
                            [selectedNode.id]: (all[selectedNode.id] ?? []).map((each, i) => (i === at ? next : each)),
                          }))
                        }
                        onRemove={() =>
                          setPending((all) => ({
                            ...all,
                            [selectedNode.id]: (all[selectedNode.id] ?? []).filter((_, i) => i !== at),
                          }))
                        }
                      />
                    ))}
                    {/* Always present and never removable: callers say unlisted things, and a
                        branch node with nowhere to send them is a call that stops. */}
                    <div className="flex h-[30px] items-center rounded-lg border border-dashed border-[var(--hairline)] px-2 text-[12px] text-[var(--ink-3)]">
                      anything else → otherwise
                    </div>
                  </div>
                  <button
                    type="button"
                    className="mt-2 text-[12px] underline"
                    onClick={() =>
                      setPending((all) => ({ ...all, [selectedNode.id]: [...(all[selectedNode.id] ?? []), { equals: "" }] }))
                    }
                  >
                    Add a branch
                  </button>
                  <p className="mt-1.5 text-xs leading-relaxed text-[var(--ink-3)]">
                    A branch is saved once it is wired to a step. Drag from its dot on the node.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
