"use client";

import {
  useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from "react";

import {
  CheckCircle2,
  GitBranch,
  GripVertical,
  Maximize2,
  MessageSquareText,
  PhoneForwarded,
  PhoneIncoming,
  PhoneOff,
  Redo2,
  TextCursorInput,
  Undo2,
  Wrench,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";

import { Button, CONTROL, IconButton, Notice, SelectField, TextAreaField, TextField } from "@/components/ui";
import { cn } from "@/lib/cn";

/* The validator itself, from `@ansa/shared`, imported by subpath so a browser bundle does not
   pull the package barrel — which reaches `node:buffer` through the audio helpers.

   Imported rather than mirrored, unlike the zod schemas above it. Those mirror a module of
   types and constants; this is the rule that decides whether a conversation can answer a
   phone, the publish gate runs exactly this function, and a second opinion about that in the
   console would eventually tell somebody their graph was fine while the API refused it. */
import { validateFlow } from "@ansa/shared/flow-validate";

import {
  addService, appendToLane, branchEdgeOf, foldedAway, freshServiceName, insertAfter, insertBefore, jumpEdges, LANE_HEAD, laneFrames, laneGroups, LEFT, linkToService,
  movable, moveAfter, moveBefore, moveToLane, moveToNewService, removeService, renameService, reorderService, sameShape, tidied, TOP, withServiceTags, type Lane,
} from "../flow-layout";

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
  /** What the step does, at a glance: a card and a palette row read faster by shape than by title. */
  readonly icon: LucideIcon;
  readonly body: (node: FlowNode) => string;
}

const NODE_KINDS: Record<FlowNodeKind, NodeKindSpec> = {
  start: { title: "Call answered", colour: "var(--ok)", icon: PhoneIncoming, body: () => "The caller has picked up, or has dialled in." },
  say: { title: "Say something", colour: "var(--accent)", icon: MessageSquareText, body: (n) => (n.text ?? "") === "" ? "Nothing to cover here yet." : `“${n.text ?? ""}”` },
  collect: {
    title: "Collect a value",
    colour: "var(--ok)",
    icon: TextCursorInput,
    body: (n) => `${n.field?.key === "" || n.field === undefined ? "unnamed" : n.field.key} · ${n.field?.capture ?? "either"} · ${n.field?.confirm ?? "none"}`,
  },
  confirm: { title: "Confirm a value", colour: "var(--ok)", icon: CheckCircle2, body: (n) => `Read back ${n.on === "" || n.on === undefined ? "a value you have not named" : n.on}` },
  decide: { title: "Branch", colour: "var(--accent)", icon: GitBranch, body: (n) => `On ${n.on === "" || n.on === undefined ? "a value you have not named" : n.on}` },
  tool: { title: "Call a tool", colour: "var(--warn)", icon: Wrench, body: (n) => (n.tool ?? "") === "" ? "No tool chosen yet." : (n.tool ?? "") },
  transfer: { title: "Transfer to human", colour: "var(--bad)", icon: PhoneForwarded, body: () => "Rings a person. Irreversible tools land here." },
  hangup: { title: "End the call", colour: "var(--ink-3)", icon: PhoneOff, body: () => "Says goodbye and hangs up." },
};

/** A step kind's icon, in its colour. The one mark that is the same in the palette, on the card and in the inspector. */
const KindIcon = ({ kind, size = 14 }: { readonly kind: FlowNodeKind; readonly size?: number }) => {
  const Icon = NODE_KINDS[kind].icon;
  return <Icon aria-hidden className="flex-none" style={{ color: NODE_KINDS[kind].colour, width: size, height: size }} />;
};

const PALETTE: readonly { readonly group: string; readonly kinds: readonly FlowNodeKind[] }[] = [
  { group: "Speech", kinds: ["say", "collect", "confirm"] },
  { group: "Logic", kinds: ["decide", "tool"] },
  { group: "Ending", kinds: ["transfer", "hangup"] },
];

/* ------------------------------------------------------------------- the card */

/**
 * What one card says: a title, a subtitle, and which of the two is typed into.
 *
 * The card is one line, so the title has to be the thing somebody scans for — the question
 * a step asks, the tool it calls, the words it says — and the subtitle the thing they check
 * once they have found it: how the answer is heard, whether it is read back, how many ways
 * the call can go from here. The kind's own name is not on the card at all; the icon is.
 */
interface CardLine {
  readonly title: string;
  readonly subtitle: string;
  /** Which of the two lines is an input, if either. */
  readonly edit?: "title" | "subtitle";
  readonly placeholder?: string;
  readonly onEdit?: (value: string) => void;
}

const CONFIRM_WORD: Record<string, string> = { none: "", readback: "read back", spellback: "spelled back" };

const cardLineOf = (
  node: FlowNode,
  edges: readonly FlowEdge[],
  onEdit: { readonly text: (value: string) => void; readonly prompt: (value: string) => void },
): CardLine => {
  switch (node.kind) {
    case "start":
      return { title: "Call answered", subtitle: "the greeting plays" };
    case "collect": {
      const field = node.field;
      const parts: string[] = [field?.type ?? "text"];
      if (field?.type === "choice") parts.push(`${field.options.length} ${field.options.length === 1 ? "answer" : "answers"}`);
      else if (field !== undefined && (CONFIRM_WORD[field.confirm] ?? "") !== "") parts.push(CONFIRM_WORD[field.confirm] ?? "");
      else if (field?.capture === "keypad") parts.push("keypad");
      return {
        title: field?.prompt ?? "",
        subtitle: parts.join(" · "),
        edit: "title",
        placeholder: field?.key === "" || field === undefined ? "What the agent asks" : `asks for their ${field.key}`,
        onEdit: onEdit.prompt,
      };
    }
    case "say":
      return { title: "Say something", subtitle: node.text ?? "", edit: "subtitle", placeholder: "what to cover, in your own words", onEdit: onEdit.text };
    case "confirm":
      return { title: `Confirm ${node.on === "" || node.on === undefined ? "a value" : node.on}`, subtitle: "reads it back" };
    case "decide": {
      const ways = edges.filter((edge) => edge.from === node.id).length;
      return {
        title: "Branch",
        subtitle: node.on === "" || node.on === undefined ? "on a value you have not named" : `on ${node.on} · ${ways} ${ways === 1 ? "way" : "ways"}`,
      };
    }
    case "tool":
      return {
        title: (node.tool ?? "") === "" ? "Call a tool" : (node.tool ?? ""),
        subtitle: (node.tool ?? "") === "" ? "no tool chosen yet" : "looks up · then carries on",
      };
    case "transfer":
      return { title: "Transfer to a person", subtitle: "rings a person · ends here" };
    case "hangup":
      return { title: "End the call", subtitle: "says goodbye" };
  }
};

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

/**
 * A named way out of a step.
 *
 * The first port also holds an edge that names no port at all. That is the director's rule
 * — a port with no edge of its own takes the first edge — and a graph seeded from a form
 * has exactly those edges. Without this the canvas drew the link from the first port and
 * the inspector said the port led nowhere, about the same edge.
 */
const namedPort = (from: string, name: string, label: string, first = false): Port => ({
  key: name,
  label,
  holds: (edge) =>
    edge.from === from &&
    (edge.port === name || (first && edge.port === undefined && edge.when === undefined && edge.otherwise !== true)),
  wire: (to) => ({ from, to, port: name }),
});

const conditional =
  (from: string) =>
  (edge: FlowEdge): edge is FlowEdge & { when: FlowCondition } =>
    edge.from === from && edge.when !== undefined;

/**
 * The dot a new arm is dragged from. Dropped on a step or a service it becomes a branch with
 * that destination and an answer to fill in — or, dropped on a service from the fork, the
 * service's name as the answer. It holds no edge: it is the one that is not there yet.
 */
const anotherArm = (from: string): Port => ({
  key: "add",
  label: "+ another answer",
  holds: () => false,
  wire: (to: string) => ({ from, to, when: { equals: "" } }),
});

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
      return [namedPort(node.id, "got", "got it", true), namedPort(node.id, "gave-up", "gave up")];
    case "confirm":
      return [namedPort(node.id, "yes", "yes", true), namedPort(node.id, "no", "no")];
    case "tool":
      return [namedPort(node.id, "ok", "ok", true), namedPort(node.id, "failed", "failed")];
    case "decide":
      return [...branchPorts(node.id, edges, pending), anotherArm(node.id)];
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

/** What a drag picked up: a kind from the palette, a card by id, or a whole service. */
type DragSource = { readonly kind: FlowNodeKind } | { readonly node: string } | { readonly lane: Lane };
/** Where it would land. */
type DropTarget =
  | { readonly after: string }
  | { readonly before: string }
  | { readonly lane: Lane }
  | { readonly newService: true }
  | { readonly beforeLane: Lane | null };
interface LiveDrag {
  readonly source: DragSource;
  readonly startX: number;
  readonly startY: number;
  readonly offsetX: number;
  readonly offsetY: number;
  began: boolean;
  target: DropTarget | null;
  /** What was pressed, so a press that never became a drag can still be the click it was. */
  readonly pressed: EventTarget | null;
  /** Where the pointer last was, so a ghost rendered mid-move appears under it. */
  lastX: number;
  lastY: number;
}
const sameTarget = (a: DropTarget | null, b: DropTarget | null): boolean => {
  if (a === null || b === null) return a === b;
  if ("after" in a) return "after" in b && a.after === b.after;
  if ("before" in a) return "before" in b && a.before === b.before;
  if ("lane" in a) return "lane" in b && a.lane.id === b.lane.id;
  if ("newService" in a) return "newService" in b;
  return "beforeLane" in b && (a.beforeLane?.id ?? null) === (b.beforeLane?.id ?? null);
};

const NODE_W = 208;
/** A card's height, for the fallback before it has been measured. One line: icon, title, subtitle. */
const BODY_H = 44;

/** Where the drawing sits under the viewport, and how large. */
interface View {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}
/** How far in and out the drawing goes. Below half, the words on a card are not words. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 1.15;
const clampScale = (scale: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
/** The toolbar's height along the top of the viewport, which the drawing must stay under. */
const TOOLBAR_CLEAR = 60;

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * A connector runs downwards. The call reads top to bottom — the answer at the top, the
 * goodbye at the bottom, branches spreading sideways in between — so a link leaves the
 * bottom of one card and arrives at the top of the next, and the curve bends vertically.
 */
const bezier = (p1: Point, p2: Point): string => {
  /* Straight when it can be. A link down one column is the common case — nearly every link
     on a drawing — and a curve there reads as a wobble. The bend is kept for a link that
     crosses to another column, where it is the shape of a fork. */
  if (Math.abs(p2.x - p1.x) < 2) return `M${p1.x} ${p1.y} L${p2.x} ${p2.y}`;
  const dy = Math.max(18, Math.abs(p2.y - p1.y) * 0.5);
  return `M${p1.x} ${p1.y} C${p1.x} ${p1.y + dy},${p2.x} ${p2.y - dy},${p2.x} ${p2.y}`;
};

/**
 * A connector that runs along a gap: down from the card, across at `busY`, down into the
 * next card. For the links that leave a lane or fan out into the lanes — a curve between two
 * columns passes straight through whatever lane lies between them, and a link across
 * somebody else's cards reads as a link to them. The gap between the lanes is the one place
 * a sideways run touches nothing.
 */
const elbow = (p1: Point, p2: Point, busY: number): string => {
  const r = 8;
  const dx = p2.x - p1.x;
  if (Math.abs(dx) < 2 * r + 2) return bezier(p1, p2);
  const s = Math.sign(dx);
  const y = Math.min(Math.max(busY, p1.y + r), p2.y - r);
  return [
    `M${p1.x} ${p1.y}`,
    `V${y - r}`,
    `Q${p1.x} ${y} ${p1.x + s * r} ${y}`,
    `H${p2.x - s * r}`,
    `Q${p2.x} ${y} ${p2.x} ${y + r}`,
    `V${p2.y}`,
  ].join(" ");
};

/** A path through the given corners, each turn rounded. Every segment is horizontal or vertical. */
const orthogonal = (points: readonly Point[], r: number): string => {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return "";
  const parts = [`M${first.x} ${first.y}`];
  for (let at = 1; at < points.length - 1; at += 1) {
    const before = points[at - 1];
    const here = points[at];
    const next = points[at + 1];
    if (before === undefined || here === undefined || next === undefined) continue;
    const back = Math.min(r, (Math.abs(here.x - before.x) + Math.abs(here.y - before.y)) / 2);
    const on = Math.min(r, (Math.abs(next.x - here.x) + Math.abs(next.y - here.y)) / 2);
    parts.push(`L${here.x - Math.sign(here.x - before.x) * back} ${here.y - Math.sign(here.y - before.y) * back}`);
    parts.push(`Q${here.x} ${here.y} ${here.x + Math.sign(next.x - here.x) * on} ${here.y + Math.sign(next.y - here.y) * on}`);
  }
  parts.push(`L${last.x} ${last.y}`);
  return parts.join(" ");
};

/**
 * A link to another service: down out of the card, along the gap beside its column, then into
 * the top of the step it lands on.
 *
 * Out to the side rather than straight across, because the straight line between two services
 * runs through whatever is drawn between them, and a line over somebody else's cards reads as
 * a line to them. The gap beside the column belongs to nothing, and the target may be above
 * the source — a jump goes backwards as often as forwards — which a curve down the page
 * cannot say at all.
 */
const jumpPath = (p1: Point, p2: Point, sideX: number): string =>
  orthogonal([p1, { x: p1.x, y: p1.y + 16 }, { x: sideX, y: p1.y + 16 }, { x: sideX, y: p2.y - 16 }, { x: p2.x, y: p2.y - 16 }, p2], 7);

/**
 * Where the `at`-th of `count` ports sits along a card's bottom edge, as a fraction of its
 * width.
 *
 * The way out a step takes by default — "got it", "yes", "ok" — sits at the centre, so the
 * link down a column leaves from the middle of the card and stays straight; the other ways
 * out sit to its right. A fork has no default, and its branches are spread evenly so the
 * fan reads as a fan.
 */
const portAlong = (at: number, count: number, kind: FlowNodeKind): number => {
  const n = Math.max(count, 1);
  if (kind === "decide") return (2 * at + 1) / (2 * n);
  return at === 0 ? 0.5 : 0.5 + at / (2 * n);
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
  /**
   * The organisation's tools, and which this agent has enabled.
   *
   * A tool step names a tool, and a name typed by hand is a name that may not exist. The
   * inspector offers the registry instead, and says when the one chosen is not yet enabled
   * — the publish gate refuses a step that names a tool the agent has not been given.
   */
  readonly availableTools: readonly { readonly name: string; readonly enabled: boolean }[];
  /** Where a transfer step sends the call, from the agent's routing, or null when unset. */
  readonly transferNumber: string | null;
  /** Show the agent's settings, at whatever a step turns out to need. */
  readonly onOpenSettings: () => void;
  /**
   * The agent's settings panels, to fill the right-hand pane when one is chosen on the strip.
   *
   * Always mounted, hidden when a step is being edited instead: the panels carry the fields
   * Save and Publish submit, and one that unmounted would take its edits with it. Which is
   * why this is a node rather than a render prop — the caller keeps it alive.
   */
  readonly settingsPane?: ReactNode;
  /** Which setting is open, or null when the pane belongs to the selected step. */
  readonly openSetting?: string | null;
  /**
   * A step was chosen, so the right-hand pane belongs to it again.
   *
   * Without this, clicking a card while a setting is open looks broken: the card highlights
   * and the pane goes on showing the voice. Selecting a step is a request to see that step.
   */
  readonly onChooseStep?: () => void;
}

export const FlowCanvas = ({
  flow,
  publishForm,
  authoringMode,
  onBlockingProblems,
  availableTools,
  transferNumber,
  onOpenSettings,
  settingsPane,
  openSetting = null,
  onChooseStep,
}: FlowCanvasProps) => {
  /* Read once, on mount. Later renders keep the operator's work in front of them; the
     workspace remounts this panel with a `key` when the document underneath it changes. */
  const [loaded] = useState(() => readFlow(flow));
  /* Laid out on the way in. Positions are derived from the graph now, so the ones in the
     stored document are whatever the previous layout left there, and honouring them would
     open a flow at yesterday's spacing until the first edit. */
  /* Services named on the way in: a flow saved before steps carried their service is read
     the old way once — a service was whatever one branch of the fork reached — and carries
     names from here on, so the next save writes them. */
  const [history, setHistory] = useState<History>(() => ({ past: [], present: tidied(withServiceTags(loaded ?? emptyFlow())), future: [] }));
  const [pending, setPending] = useState<Readonly<Record<string, readonly FlowCondition[]>>>({});
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [temp, setTemp] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // Bumped whenever the canvas needs its port positions re-read from the DOM — after a tab
  // that was hidden becomes visible, chiefly, since `offsetTop` is 0 until then.
  const [tick, setTick] = useState(0);
  /** Branch heads the reader has folded away, so six services fit a laptop. */
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  /**
   * What is being dragged and where it would land, while something is. Rendering reads this;
   * the pointer writes `dragRef` and only touches this when the answer changes, so a drag
   * re-renders on crossing a target and not on every pixel.
   */
  const [drag, setDrag] = useState<{ readonly source: DragSource; readonly target: DropTarget | null } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  /** The layer the drawing is on — panned by writing its transform, see `applyPan`. */
  const layerRef = useRef<HTMLDivElement>(null);
  /** The view as the screen has it, ahead of `view`, which follows at the end of a gesture. */
  const viewLive = useRef<View>({ x: 0, y: 0, scale: 1 });
  const viewCommit = useRef<number | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<LiveDrag | null>(null);
  /** Set by a drag that began on a palette button, so the click that follows it adds nothing. */
  const swallowClick = useRef(false);
  const portRefs = useRef(new Map<string, HTMLSpanElement>());
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
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

  /* Folded branches, and the steps that vanish with them. Computed from the graph rather
     than remembered, so a branch deleted while folded takes its chip with it.

     Declared here, above `edgePaths`, because it is read there — function expressions do not
     hoist and neither do consts, so the order in this file is the dependency order. */
  const hidden = foldedAway(history.present, folded);

  /* The lanes, read off the graph. Declared here, above the links, because a link into a
     lane's first step is drawn without a word on it — the lane header says which answer it
     is — and the links are built before the lane boxes are measured. */
  const lanes = laneGroups(history.present);
  const laneHeads = new Set(lanes.flatMap((lane) => (lane.id !== "opening" && lane.head !== undefined && lane.ids.length > 0 ? [lane.head] : [])));
  /** The lane a step is in, and whether its lane is folded away. */
  const laneOfStep = new Map(lanes.flatMap((lane) => (lane.id === "opening" ? [] : lane.ids.map((id) => [id, lane] as const))));
  const inFoldedLane = (id: string): boolean => {
    const lane = laneOfStep.get(id);
    return lane !== undefined && folded.has(lane.id);
  };
  /** The fork the lanes hang off, and every step that is inside some service's lane. */
  const laneFork = lanes.find((lane) => lane.id === "opening")?.ids.find((id) => nodes.find((n) => n.id === id)?.kind === "decide");
  const inService = new Set(lanes.filter((lane) => lane.id !== "opening").flatMap((lane) => lane.ids));

  const toggleFold = (head: string) => {
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(head)) next.delete(head);
      else next.add(head);
      return next;
    });
  };


  /**
   * One graph edit, and where undo gets its entries.
   *
   * `coalesce` folds consecutive edits to the same thing into one entry: typing a field name
   * is a single action to the person doing it, and a stack with an entry per keystroke is a
   * stack nobody can use. Anything else starts a new entry.
   */
  /**
   * Every change goes through here, and every change that alters the *shape* of the call is
   * laid out again before it lands.
   *
   * This is what removed dragging, nudging and the Tidy up button in one go: positions are
   * derived from the graph, so there is nothing to arrange and nothing that can be untidy.
   * A change to the words in a step is deliberately not a change of shape — `sameShape`
   * decides — because a card that jumps while somebody is typing in it is worse than an
   * untidy one.
   */
  const edit = (change: (current: Flow) => Flow, coalesce?: string) => {
    const merge = coalesce !== undefined && coalesce === coalescing.current;
    coalescing.current = coalesce ?? null;
    setHistory((current) => {
      const changed = change(current.present);
      if (changed === current.present) return current;
      const next = sameShape(current.present, changed) ? changed : tidied(changed);
      return merge ? { ...current, present: next, future: [] } : remember(current, next);
    });
  };

  /** Select a step, and give it the right-hand pane if a setting had taken it. */
  const chooseStep = (id: string) => {
    setSelected(id);
    onChooseStep?.();
  };

  const byId = (id: string): FlowNode | undefined => nodes.find((n) => n.id === id);

  const cardLine = (node: FlowNode, all: readonly FlowEdge[]): CardLine =>
    cardLineOf(node, all, {
      text: (value) => updateNode(node.id, { text: value }, "text"),
      prompt: (value) => updateNodeField(node.id, { prompt: value }, "prompt"),
    });

  /**
   * Change one step's words, named rather than selected.
   *
   * The inspector edits whatever is selected; a card edits itself. Coalescing on the node
   * and field means a sentence typed into a card is one undo entry, not forty.
   */
  const updateNode = (id: string, patch: Partial<FlowNode>, what: string) => {
    edit((f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }), `${id}:${what}`);
  };
  const updateNodeField = (id: string, patch: Partial<FlowField>, what: string) => {
    edit(
      (f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === id ? { ...n, field: { ...(n.field ?? blankField()), ...patch } } : n)) }),
      `${id}:field:${what}`,
    );
  };
  const portsFor = (node: FlowNode): readonly Port[] => portsOf(node, edges, pending[node.id] ?? []);

  /* A link leaves from the dot of the port it belongs to and lands on the dot at the top of
     the next card, so the drawing shows where a link attaches — the dot is the joint. The
     default port sits at the centre (`portAlong`), which keeps a link down a column straight. */
  const outPoint = (node: FlowNode, _key: string, at: number): Point => ({
    x: node.x + NODE_W * portAlong(at, portsFor(node).length, node.kind),
    y: node.y + (cardRefs.current.get(node.id)?.offsetHeight ?? BODY_H),
  });
  const inPoint = (node: FlowNode): Point => ({ x: node.x + NODE_W / 2, y: node.y });

  // Read fresh on every render — `tick` exists purely to force one after visibility flips.
  void tick;
  const frames = laneFrames(history.present);
  /* The links that leave one service for another. Drawn, but not part of the drawing's
     structure — see `jumpEdges`, which is also why the lanes survive one. */
  const jumping = jumpEdges(history.present);
  const edgePaths = edges.flatMap((edge, at) => {
    const from = byId(edge.from);
    const to = byId(edge.to);
    if (!from || !to) return [];
    // A link to a step that has been folded away has nothing to point at — unless the step
    // heads a lane, in which case the lane's header is standing in and the link lands on it.
    if (hidden.has(edge.from)) return [];
    if (hidden.has(edge.to) && !(laneHeads.has(edge.to) && inFoldedLane(edge.to))) return [];
    const ports = portsFor(from);
    const index = ports.findIndex((port) => port.holds(edge));
    const p1 = outPoint(from, ports[index]?.key ?? "", Math.max(index, 0));
    const p2 = inFoldedLane(to.id) ? { x: to.x + NODE_W / 2, y: to.y - LANE_HEAD } : inPoint(to);
    /* The branch of a service with nothing in it points past the service at the shared
       close. Drawn that way the empty lane would hang off nothing, so the link is drawn in
       two: into the top of the empty box, and on from its bottom to where it was going. */
    const emptyLane = from.id === laneFork ? lanes.find((lane) => lane.ids.length === 0 && branchEdgeOf(history.present, lane) === edge) : undefined;
    const frame = emptyLane === undefined ? undefined : frames.find((one) => one.id === emptyLane.id);
    if (frame !== undefined) {
      const x = frame.left + frame.width / 2;
      const boxTop = { x, y: frame.top - LANE_HEAD };
      const boxBottom = { x, y: frame.top + BODY_H + 8 };
      return [
        { key: `${at}`, d: elbow(p1, boxTop, boxTop.y - 12), jump: false, label: "", mid: boxTop },
        { key: `${at}b`, d: elbow(boxBottom, p2, p2.y - 16), jump: false, label: "", mid: p2 },
      ];
    }

    /* A jump keeps its label whatever it lands on: "which answer leaves this service" is the
       whole of what it says, and the lane header it lands on is naming a different thing. */
    if (jumping.has(edge)) {
      const side = p2.x > p1.x ? from.x + NODE_W + 14 : from.x - 14;
      return [
        {
          key: `${at}`,
          d: jumpPath(p1, { x: p2.x, y: p2.y - 5 }, side),
          jump: true,
          label: ports[index]?.label ?? "",
          mid: { x: p1.x, y: p1.y + 12 },
        },
      ];
    }
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 - 5 };
    /* A word on the link only where the call splits. "got it" on every question was a word
       on every link, which is the same as a word on none; "gave up", "failed" and a branch's
       answer are the ones that change where the caller ends up. A link into a lane's first
       step carries no word either: the lane's own header already says which answer it is. */
    const splits = from.kind === "decide" || index > 0;
    const intoLane = laneHeads.has(to.id);
    /* Fanning out into the lanes runs along the gap above their headers; leaving a lane for
       the shared close runs along the gap below them. Everything else curves or drops. */
    const fansOut = from.id === laneFork && (intoLane || lanes.some((lane) => lane.head === to.id));
    const rejoins = inService.has(from.id) && !inService.has(to.id);
    const d = fansOut ? elbow(p1, p2, p2.y - LANE_HEAD - 12) : rejoins ? elbow(p1, p2, p2.y - 16) : bezier(p1, p2);
    return [{ key: `${at}`, d, jump: false, label: splits && !intoLane ? (ports[index]?.label ?? "") : "", mid }];
  });

  const localPoint = (e: ReactPointerEvent): Point => {
    const box = canvasRef.current?.getBoundingClientRect();
    const { x, y, scale } = viewLive.current;
    return { x: (e.clientX - (box?.left ?? 0) - x) / scale, y: (e.clientY - (box?.top ?? 0) - y) / scale };
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
    /* Dropped on a service rather than on a step: the link goes to the service's first
       step, and — from the fork, for an arm with no answer yet — the service's name becomes
       the answer and an option on the choice, so the fork can publish as it stands. */
    const onLane = lanes.find((lane) => lane.id === target?.closest("[data-lane]")?.getAttribute("data-lane"));
    if ((to === null || to === undefined) && onLane !== undefined && onLane.id !== "opening" && onLane.ids.length > 0 && onLane.head !== wire.from) {
      const link = wire.port.wire(onLane.head ?? "");
      edit((f) => linkToService({ ...f, edges: f.edges.filter((x) => !wire.port.holds(x)) }, link, onLane));
    } else {
      if (to === null || to === undefined || to === wire.from) return;
      edit((f) => ({ ...f, edges: [...f.edges.filter((x) => !wire.port.holds(x)), wire.port.wire(to)] }));
    }
    /* A branch that was waiting for somewhere to go now has one, so it is an edge and stops
       being pending. Leaving it would show the same branch twice. */
    if (wire.port.key.startsWith("pending:")) {
      const at = Number(wire.port.key.slice("pending:".length));
      setPending((all) => ({ ...all, [wire.from]: (all[wire.from] ?? []).filter((_, i) => i !== at) }));
    }
  };

  /**
   * How far the drawing reaches, so the pan can be held to it.
   *
   * With the layout derived, the drawing starts near the origin and grows down and to the
   * right — so the only pans worth allowing are the ones that bring a further part of it
   * into view. Past the origin there is nothing; past the far edge, the same. The room for
   * an "add a service" box beside the last lane is counted, since it is part of the drawing.
   */
  const extent = (): { readonly right: number; readonly bottom: number } => {
    const shown = nodes.filter((n) => !hidden.has(n.id));
    if (shown.length === 0) return { right: 0, bottom: 0 };
    /* The lanes are counted as well as the cards, since an empty service has a box and no
       card; and past the last lane there is the add-a-service box, which is part of the
       drawing and the reason the drawing's right edge is further out than its last card. */
    const cardsRight = Math.max(...shown.map((n) => n.x + NODE_W));
    const lanesRight = Math.max(cardsRight, ...frames.map((frame) => frame.left + frame.width / 2 + NODE_W / 2 + 8));
    const right = (lanes.length > 1 ? lanesRight + 12 + NODE_W + 16 : cardsRight) + LEFT;
    const bottom = Math.max(...shown.map((n) => n.y + (cardRefs.current.get(n.id)?.offsetHeight ?? BODY_H))) + 40;
    return { right, bottom };
  };

  /**
   * A view that keeps some of the drawing on screen, whichever way it was asked for.
   *
   * A drawing larger than the viewport can be scrolled until its far edge is in view and no
   * further; one smaller than the viewport can sit anywhere inside it. The top of the
   * drawing is kept below the toolbar: at 100% the layout's own margin clears it, and when
   * zoomed out that margin shrinks with everything else, so the room is made up here.
   */
  const clampView = (next: View): View => {
    const port = canvasRef.current;
    const scale = clampScale(next.scale);
    if (port === null) return { ...next, scale };
    const { right, bottom } = extent();
    const topClear = Math.max(0, TOOLBAR_CLEAR - (TOP - LANE_HEAD) * scale);
    const between = (low: number, high: number, value: number): number => Math.min(Math.max(low, high), Math.max(Math.min(low, high), value));
    return {
      x: between(0, port.clientWidth - right * scale, next.x),
      y: between(topClear, port.clientHeight - bottom * scale, next.y),
      scale,
    };
  };
  const clampRef = useRef(clampView);
  clampRef.current = clampView;

  /**
   * The drawing sits in the middle of the viewport.
   *
   * At first paint, whenever its width changes — a service added, folded, removed or
   * reordered — and whenever the viewport itself changes size. Not on every edit: a step
   * added inside a lane leaves the width alone, and the drawing is already where it was
   * put. Across, not down: a call reads from the answer at the top, so the top stays where
   * it is and the reader scrolls down through it. A layout effect rather than an effect so
   * the first frame is already centred, not a frame off to the left and then a jump.
   */
  const drawingWidth = extent().right;
  const centre = () => {
    const port = canvasRef.current;
    if (port === null) return;
    const live = viewLive.current;
    applyViewRef.current({ ...live, x: (port.clientWidth - drawingWidth * live.scale) / 2 });
  };
  const centreRef = useRef(centre);
  centreRef.current = centre;
  useLayoutEffect(() => {
    centreRef.current();
  }, [drawingWidth]);
  useEffect(() => {
    const port = canvasRef.current;
    if (port === null) return;
    const observer = new ResizeObserver(() => centreRef.current());
    observer.observe(port);
    return () => observer.disconnect();
  }, []);

  /**
   * Move or scale the drawing now, and tell React later.
   *
   * A pan that went through state re-rendered every card, every link and the validator on
   * every pointer move, and on a laptop that is a drawing that lags the hand. So the layer's
   * transform is written directly, at pointer rate, and the `view` state — which nothing
   * needs until the gesture is over — catches up once per frame. React leaves a style it
   * did not change alone, so the two never fight.
   */
  const applyView = (next: View) => {
    const clamped = clampRef.current(next);
    viewLive.current = clamped;
    const layer = layerRef.current;
    if (layer !== null) layer.style.transform = `translate(${clamped.x}px,${clamped.y}px) scale(${clamped.scale})`;
    if (viewCommit.current === null) {
      viewCommit.current = requestAnimationFrame(() => {
        viewCommit.current = null;
        setView(viewLive.current);
      });
    }
  };
  const applyPan = (next: Point) => applyView({ ...viewLive.current, ...next });
  const applyViewRef = useRef(applyView);
  applyViewRef.current = applyView;
  useEffect(() => () => {
    if (viewCommit.current !== null) cancelAnimationFrame(viewCommit.current);
  }, []);

  /**
   * Scale the drawing about a point on the viewport, so what is under that point stays put.
   * The buttons zoom about the middle of the viewport; the wheel about the pointer.
   */
  const zoomTo = (scale: number, about?: Point) => {
    const port = canvasRef.current;
    const current = viewLive.current;
    const next = clampScale(scale);
    const cx = about?.x ?? (port?.clientWidth ?? 0) / 2;
    const cy = about?.y ?? (port?.clientHeight ?? 0) / 2;
    applyView({
      x: cx - ((cx - current.x) / current.scale) * next,
      y: cy - ((cy - current.y) / current.scale) * next,
      scale: next,
    });
  };

  const onCanvasPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-flow-node], [data-canvas-bar], [data-lane], [data-add-service]")) return;
    panRef.current = { startX: e.clientX, startY: e.clientY, panX: viewLive.current.x, panY: viewLive.current.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelected(null);
  };
  const onCanvasPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p) return;
    applyPan({ x: p.panX + (e.clientX - p.startX), y: p.panY + (e.clientY - p.startY) });
  };
  const onCanvasPointerUp = () => {
    panRef.current = null;
  };

  /* The wheel pans the drawing while the pointer is over it, and scrolls the page otherwise;
     with Ctrl or ⌘ held — which is also what a trackpad pinch arrives as — it zooms about the
     pointer. Attached by hand rather than as `onWheel`: React registers wheel listeners as
     passive, and a passive listener cannot stop the page from scrolling underneath — which is
     the one thing this has to do. The drawing takes the wheel whether or not it can move
     further, the way any canvas does; the page is a mouse-width away. */
  const wheelRef = useRef({ applyPan, zoomTo });
  wheelRef.current = { applyPan, zoomTo };
  useEffect(() => {
    const port = canvasRef.current;
    if (port === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const box = port.getBoundingClientRect();
        /* A mouse tick is ~120 and a pinch step ~2, so the factor is per unit and bounded:
           a tick is a quarter step, a pinch is smooth, and neither can jump the range. */
        const factor = Math.min(1.3, Math.max(0.77, Math.exp(-e.deltaY * 0.0025)));
        wheelRef.current.zoomTo(viewLive.current.scale * factor, { x: e.clientX - box.left, y: e.clientY - box.top });
        return;
      }
      wheelRef.current.applyPan({ x: viewLive.current.x - e.deltaX, y: viewLive.current.y - e.deltaY });
    };
    port.addEventListener("wheel", onWheel, { passive: false });
    return () => port.removeEventListener("wheel", onWheel);
  }, []);

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
    switch (e.key) {
      case "Enter":
      case " ":
        chooseStep(n.id);
        break;
      case "Escape":
        setSelected(null);
        break;
      case "Delete":
      case "Backspace":
        if (n.kind !== "start") removeNode(n.id);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  /**
   * A new step, where it was put.
   *
   * Dropped on a card, it goes on the path right after that card. Dropped on a lane, it goes
   * at the end of the lane — before the fork on the opening lane, before the rejoin on a
   * service. Clicked in the palette with a step selected, it goes after that step. Only a
   * click with nothing selected leaves a step floating, and the layout shows it below the
   * end as unreachable, which is exactly what it is until it is wired.
   */
  const addNode = (kind: FlowNodeKind, where?: { readonly after?: string; readonly before?: string; readonly lane?: Lane }) => {
    const id = freshId(new Set(nodes.map((n) => n.id)));
    const fresh = blankNode(id, kind, 0, 0);
    edit((f) => {
      if (where?.after !== undefined && f.nodes.some((n) => n.id === where.after)) return insertAfter(f, where.after, fresh);
      if (where?.before !== undefined && f.nodes.some((n) => n.id === where.before)) return insertBefore(f, where.before, fresh);
      if (where?.lane !== undefined) return appendToLane(f, where.lane, fresh);
      return { ...f, nodes: [...f.nodes, fresh] };
    });
    chooseStep(id);
  };

  /** A new service with a first step to fill in. Nothing leads to it until a branch is dragged onto it. */
  const addNewService = () => {
    const id = freshId(new Set(nodes.map((n) => n.id)));
    const head = blankNode(id, "collect", 0, 0);
    edit((f) => addService(f, head, freshServiceName(f)));
    chooseStep(id);
  };

  /**
   * Where a drag would land, read off whatever is under the pointer.
   *
   * The ghost that follows the pointer takes no pointer events, so `elementFromPoint` sees
   * through it to the card, lane or box beneath. A card is "after this card"; a lane is "at
   * the end of this lane"; the add-a-service box is "as a new service". A lane being dragged
   * reads other lanes as "before this one" or "after this one" by which half the pointer is
   * in, and the box as "last". A card cannot be dropped on itself.
   */
  const targetAt = (source: DragSource, clientX: number, clientY: number): DropTarget | null => {
    const under = document.elementFromPoint(clientX, clientY);
    if (under === null) return null;
    if ("lane" in source) {
      if (under.closest("[data-add-service]")) return { beforeLane: null };
      /* By geometry rather than by what is under the pointer: the cards sit on top of the
         boxes as siblings, so over a card the pointer is "in" no box at all — and a lane is
         mostly cards. The box whose rectangle holds the pointer is the lane meant. */
      const boxes = [...document.querySelectorAll<HTMLElement>("[data-lane]")];
      const box = boxes.find((one) => {
        const rect = one.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
      });
      const id = box?.getAttribute("data-lane");
      const services = lanes.filter((one) => one.id !== "opening");
      const at = services.findIndex((one) => one.id === id);
      if (box === undefined || at < 0 || id === source.lane.id) return null;
      const rect = box.getBoundingClientRect();
      const leftHalf = clientX < rect.left + rect.width / 2;
      const before = leftHalf ? services[at] : services[at + 1];
      return { beforeLane: before ?? null };
    }
    /* On a card, which half decides: the top half puts the step before it, the bottom half
       after — so the top of a service is reached by dropping on the upper half of its first
       card, the way anything is put at the top of a list. */
    const cardEl = under.closest("[data-flow-node]");
    const card = cardEl?.getAttribute("data-flow-node");
    if (cardEl !== null && cardEl !== undefined && card !== null && card !== undefined) {
      if ("node" in source && card === source.node) return null;
      const rect = cardEl.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2 ? { before: card } : { after: card };
    }
    if (under.closest("[data-add-service]")) return { newService: true };
    const laneId = under.closest("[data-lane]")?.getAttribute("data-lane");
    const lane = lanes.find((one) => one.id === laneId);
    if (lane === undefined) return null;
    /* On a lane's own box: above its first card — its header — means first; anywhere else
       means last. The header is the one part of a lane that is not a card. */
    const head = lane.ids[0];
    const headEl = head === undefined ? null : document.querySelector(`[data-flow-node="${head}"]`);
    if (head !== undefined && headEl !== null && clientY < headEl.getBoundingClientRect().top && !("node" in source && head === source.node)) {
      return { before: head };
    }
    return { lane };
  };

  /** What a finished drag does to the graph. */
  const drop = (source: DragSource, target: DropTarget) => {
    if ("kind" in source) {
      if ("newService" in target) {
        const id = freshId(new Set(nodes.map((n) => n.id)));
        const head = blankNode(id, source.kind, 0, 0);
        edit((f) => addService(f, head, freshServiceName(f)));
        chooseStep(id);
      } else if ("after" in target) addNode(source.kind, { after: target.after });
      else if ("before" in target) addNode(source.kind, { before: target.before });
      else if ("lane" in target) addNode(source.kind, { lane: target.lane });
      return;
    }
    if ("node" in source) {
      const id = source.node;
      if ("after" in target) edit((f) => moveAfter(f, id, target.after));
      else if ("before" in target) edit((f) => moveBefore(f, id, target.before));
      else if ("lane" in target) edit((f) => moveToLane(f, id, target.lane));
      else if ("newService" in target) edit((f) => moveToNewService(f, id, freshServiceName(f)));
      chooseStep(id);
      return;
    }
    /* Laid out by hand: a reorder keeps every step and every link, so `sameShape` would call
       it unchanged and leave the lanes where they were — the one edit whose whole point is
       where things are. */
    if ("beforeLane" in target) edit((f) => tidied(reorderService(f, source.lane, target.beforeLane)));
  };

  /**
   * The pointer handlers that make something draggable, for a palette button, a card or a
   * lane header alike.
   *
   * Pointer events rather than the browser's drag-and-drop, which was tried first: that
   * ghost is a translucent snapshot the browser moves on its own schedule, the target under
   * it is reported at a throttled rate, and nothing about it can be drawn — a step
   * crossing the canvas looked like a screenshot being posted. Here the ghost is an element
   * this component owns, moved with the pointer on every event by writing its transform,
   * and the target is whatever is under the pointer right now. A press that moves less than
   * a few pixels is a click, and is left to be one.
   */
  const draggable = (source: DragSource) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      dragRef.current = { source, startX: e.clientX, startY: e.clientY, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top, began: false, target: null, pressed: e.target, lastX: e.clientX, lastY: e.clientY };
      /* Capture so the drag survives the pointer leaving the element. Not fatal without it —
         the drag ends on the next pointerup wherever it lands — so a refusal is ignored. */
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* an inactive pointer; the drag still runs on the events that reach the element */
      }
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const live = dragRef.current;
      if (live === null) return;
      live.lastX = e.clientX;
      live.lastY = e.clientY;
      if (!live.began) {
        if (Math.hypot(e.clientX - live.startX, e.clientY - live.startY) < 5) return;
        live.began = true;
        if (document.activeElement instanceof HTMLElement && e.currentTarget.contains(document.activeElement)) document.activeElement.blur();
        // The press may have started a text selection in a name field; the drag is not that.
        window.getSelection()?.removeAllRanges();
        setDrag({ source: live.source, target: null });
      }
      const ghost = ghostRef.current;
      if (ghost !== null) ghost.style.transform = `translate(${e.clientX - live.offsetX}px,${e.clientY - live.offsetY}px)`;
      const next = targetAt(live.source, e.clientX, e.clientY);
      if (!sameTarget(live.target, next)) {
        live.target = next;
        setDrag({ source: live.source, target: next });
      }
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      const live = dragRef.current;
      dragRef.current = null;
      if (live === null) return;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      /* A press on a service's name that never moved is a click on the name: focus it to
         edit. The name field gives up its own press (see its `onPointerDown`) so the box
         can be dragged by it; this is where the click it would have been is honoured. */
      if (!live.began) {
        if (live.pressed instanceof HTMLInputElement && e.currentTarget.contains(live.pressed)) live.pressed.focus();
        return;
      }
      swallowClick.current = true;
      setDrag(null);
      if (live.target !== null) drop(live.source, live.target);
    },
    onPointerCancel: () => {
      dragRef.current = null;
      setDrag(null);
    },
  });

  /** The card or lane under a drag right now, for the target to say so. */
  const dropAfter = drag?.target !== null && drag?.target !== undefined && "after" in drag.target ? drag.target.after : null;
  const dropBefore = drag?.target !== null && drag?.target !== undefined && "before" in drag.target ? drag.target.before : null;
  const dropLane = drag?.target !== null && drag?.target !== undefined && "lane" in drag.target ? drag.target.lane.id : null;
  const dropNewService = drag?.target !== null && drag?.target !== undefined && "newService" in drag.target;
  const dropBeforeLane = drag?.target !== null && drag?.target !== undefined && "beforeLane" in drag.target ? (drag.target.beforeLane?.id ?? "") : null;
  const draggedNode = drag !== null && "node" in drag.source ? drag.source.node : null;
  const draggedLane = drag !== null && "lane" in drag.source ? drag.source.lane.id : null;

  const removeNode = (id: string) => {
    edit((f) => ({ ...f, nodes: f.nodes.filter((n) => n.id !== id), edges: f.edges.filter((x) => x.from !== id && x.to !== id) }));
    setPending((all) => ({ ...all, [id]: [] }));
    setSelected((s) => (s === id ? null : s));
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
    chooseStep(nodeId);
    applyPan({ x: 120 - node.x, y: 90 - node.y });
  };

  /* Fit: the whole drawing under the viewport, scaled down when it is too big and never
     scaled up — a small flow at 160% is a small flow with enormous cards. */
  const fit = () => {
    const port = canvasRef.current;
    if (port === null || nodes.length === 0) return applyView({ x: 0, y: 0, scale: 1 });
    const { right, bottom } = extent();
    const scale = clampScale(Math.min(1, (port.clientWidth - 16) / right, (port.clientHeight - TOOLBAR_CLEAR) / bottom));
    applyView({ x: (port.clientWidth - right * scale) / 2, y: 0, scale });
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

  /* Recomputed whenever the graph changes and not otherwise: a drag re-renders on every
     target it crosses, and re-validating 120 steps for a hover is work with no answer. */
  const problems = useMemo(() => validateFlow(history.present), [history.present]);
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

  /**
   * The labelled boxes behind the cards: the shared opening, then one per service.
   *
   * Read from the DOM for height the same way the links read the ports — a card grows with
   * the words in it, and a box drawn to a guessed height clips the card it is meant to
   * contain. One render stale is fine and is what the links already accept.
   */
  const laneBoxes = lanes
    .map((lane) => {
      const head = lane.id === "opening" || lane.head === undefined || lane.ids.length === 0 ? undefined : byId(lane.head);
      /* A folded lane is its header and nothing else, sitting where its first card would be:
         the name, how many steps are behind it, and the button that brings them back. The
         cards are hidden; the header is what stands in for them. */
      if (head !== undefined && folded.has(lane.id)) {
        return {
          id: lane.id,
          label: lane.label,
          steps: lane.ids.length,
          broken: lane.ids.filter((id) => marked.get(id) === "blocks").length,
          folded: true,
          empty: false,
          left: head.x - 8,
          top: head.y - LANE_HEAD,
          width: NODE_W + 16,
          height: LANE_HEAD,
        };
      }
      const cards = lane.ids
        .filter((id) => !hidden.has(id))
        .map((id) => byId(id))
        .filter((node): node is FlowNode => node !== undefined);
      /* A service with nothing in it — just added, or its steps all dragged elsewhere —
         has no cards to measure, so it is drawn at the column the layout keeps for it,
         one card tall, with room to drop the first step onto. */
      if (cards.length === 0) {
        const frame = laneFrames(history.present).find((one) => one.id === lane.id);
        if (frame === undefined || lane.id === "opening") return null;
        return {
          id: lane.id,
          label: lane.label,
          steps: 0,
          broken: 0,
          folded: false,
          empty: true,
          left: frame.left + (frame.width - NODE_W) / 2 - 8,
          top: frame.top - LANE_HEAD,
          width: NODE_W + 16,
          height: LANE_HEAD + BODY_H + 8,
        };
      }
      const top = Math.min(...cards.map((n) => n.y));
      const bottom = Math.max(...cards.map((n) => n.y + (cardRefs.current.get(n.id)?.offsetHeight ?? BODY_H)));
      const left = Math.min(...cards.map((n) => n.x));
      const right = Math.max(...cards.map((n) => n.x + NODE_W));
      return {
        id: lane.id,
        label: lane.label,
        steps: cards.length,
        broken: cards.filter((n) => marked.get(n.id) === "blocks").length,
        folded: false,
        empty: false,
        /* The header sits inside the box above the first card; the box hugs the cards by
           the same 8 pixels the drawing's lanes use. */
        left: left - 8,
        top: top - LANE_HEAD,
        width: right - left + 16,
        height: bottom - top + LANE_HEAD + 8,
      };
    })
    .filter((lane): lane is NonNullable<typeof lane> => lane !== null);
  /* "Everyone gets this" hugs its own column like every other lane. It used to span the
     services beneath it, and so grew a card's width with every service added — which read
     as the opening changing when only the fork below it had. The fan of links leaves the
     fork's dots and runs along the gap, and needs no box to start from. */

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
          <h5 className="mt-0.5 mb-1.5 ml-1.5 font-mono text-[9.5px] tracking-[0.14em] text-[var(--ink-3)] uppercase">
            Add a step
          </h5>
          {PALETTE.map((group) => (
            <div key={group.group}>
              <h6 className="mt-1 mb-1 ml-1.5 font-mono text-[9.5px] tracking-[0.13em] text-[var(--ink-3)] uppercase">
                {group.group}
              </h6>
              {group.kinds.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  {...draggable({ kind })}
                  onClick={() => {
                    if (swallowClick.current) {
                      swallowClick.current = false;
                      return;
                    }
                    addNode(kind, selected === null ? undefined : { after: selected });
                  }}
                  title={selected === null ? "Drag onto the drawing, or click to add" : "Drag onto the drawing, or click to add after the selected step"}
                  className="flex w-full cursor-grab touch-none items-center gap-2 rounded-lg px-2.5 py-[7px] text-left text-[12.5px] text-[var(--ink-2)] transition-colors select-none hover:bg-[var(--surface-2)] hover:text-[var(--ink)] active:cursor-grabbing"
                >
                  <KindIcon kind={kind} />
                  {NODE_KINDS[kind].title}
                </button>
              ))}
            </div>
          ))}
          {/* Named but not offered. Every call starts one way and the publish gate refuses a
              second start, so a button here would be a button whose only outcome is a refusal
              — this says the step exists and that it is already on the drawing. */}
          <div>
            <h6 className="mt-1 mb-1 ml-1.5 font-mono text-[9.5px] tracking-[0.13em] text-[var(--ink-3)] uppercase">
              Always first
            </h6>
            <p className="flex w-full items-center gap-2 rounded-lg px-2.5 py-[7px] text-[12.5px] text-[var(--ink-3)]">
              <KindIcon kind="start" />
              {NODE_KINDS.start.title}
            </p>
          </div>
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
          {/* The toolbar, inside the drawing along its top edge. Canvas actions only — Save
              and Publish belong to the page header, where they act on the whole agent. On
              the canvas rather than above it so the actions travel with the thing they act
              on; along the top rather than in a corner so they are found where every toolbar
              is found, and its buttons are buttons. `data-canvas-bar` keeps a press on it
              from starting a pan. The near-solid ground is deliberate: a node panned under the
              bar showed its text straight through the lighter one, which read as the node
              being on top. */}
          <div
            data-canvas-bar
            className="glass absolute top-3 right-3 left-3 z-[5] flex items-center gap-1.5 rounded-lg border border-[var(--hairline)] bg-[color-mix(in_srgb,var(--surface-solid)_85%,transparent)] px-2 py-1.5"
          >
            <span className="px-1.5 font-mono text-[11px] text-[var(--ink-3)]">
              {nodes.length} {nodes.length === 1 ? "step" : "steps"} · {edges.length} {edges.length === 1 ? "link" : "links"}
            </span>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => zoomTo(viewLive.current.scale / ZOOM_STEP)} disabled={view.scale <= ZOOM_MIN + 0.001} title="Zoom out (⌘ + scroll)" aria-label="Zoom out">
              <ZoomOut className="size-3.5" />
            </Button>
            <button
              type="button"
              onClick={() => zoomTo(1)}
              title="Back to 100%"
              className="min-w-[38px] rounded px-1 font-mono text-[10.5px] tabular-nums text-[var(--ink-3)] hover:text-[var(--ink)]"
            >
              {Math.round(view.scale * 100)}%
            </button>
            <Button size="sm" variant="ghost" onClick={() => zoomTo(viewLive.current.scale * ZOOM_STEP)} disabled={view.scale >= ZOOM_MAX - 0.001} title="Zoom in (⌘ + scroll)" aria-label="Zoom in">
              <ZoomIn className="size-3.5" />
            </Button>
            <Button size="sm" variant="ghost" onClick={fit} title="Fit the whole drawing under the viewport">
              <Maximize2 className="size-3.5" />
              Fit
            </Button>
            <span aria-hidden className="mx-1 h-4 w-px bg-[var(--hairline)]" />
            <Button
              size="sm"
              variant="ghost"
              disabled={history.past.length === 0}
              title="Undo"
              onClick={() => {
                coalescing.current = null;
                setHistory(stepBack);
              }}
            >
              <Undo2 className="size-3.5" />
              Undo
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={history.future.length === 0}
              title="Redo"
              onClick={() => {
                coalescing.current = null;
                setHistory(stepForward);
              }}
            >
              <Redo2 className="size-3.5" />
              Redo
            </Button>
          </div>
          <div ref={layerRef} className="absolute inset-0" style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.scale})`, transformOrigin: "0 0" }}>
            {/* The lanes, behind everything and clickable through: a label saying which part
                of the business a column of cards belongs to. `pointer-events-none` because a
                box is a caption, not a target — clicking inside one should reach the card. */}
            {laneBoxes.map((lane) => {
              const group = lanes.find((one) => one.id === lane.id);
              const isService = lane.id !== "opening" && group !== undefined;
              const catchAll = group?.catchAll === true;
              /* A catch-all standing in for the one uncovered option has that option's name
                 and can be renamed; one standing for nothing in particular has no name. */
              const nameless = catchAll && lane.label === "anything else";
              return (
              <div
                key={lane.id}
                data-lane={lane.id}
                aria-hidden={lane.id === "opening"}
                {...(isService && !lane.folded ? draggable({ lane: group }) : {})}
                className={cn(
                  "absolute rounded-[7px] border bg-[var(--surface)] transition-colors",
                  /* A service is picked up by any part of its box — the cards on top take
                     their own presses first. The opening is not a thing that moves, and a
                     press on it pans the canvas; while something is being dragged it is a
                     target like the rest. */
                  lane.id === "opening" && drag === null ? "pointer-events-none" : "pointer-events-auto",
                  isService && !lane.folded && "cursor-grab touch-none active:cursor-grabbing",
                  draggedLane === lane.id && "opacity-50",
                  dropLane === lane.id
                    ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                    : lane.broken > 0
                      ? "border-[var(--bad)]"
                      : lane.folded
                        ? "border-[var(--accent)]"
                        : lane.empty
                          ? "border-dashed border-[var(--hairline)]"
                          : "border-[var(--hairline)]",
                )}
                style={{ left: lane.left, top: lane.top, width: lane.width, height: lane.height }}
              >
                {/* Where a dragged lane would go: a bar down this lane's left edge. */}
                {dropBeforeLane === lane.id && (
                  <span aria-hidden className="absolute top-1 bottom-1 -left-[7px] w-[3px] rounded bg-[var(--accent)]" />
                )}
                <div
                  data-lane-head
                  className={cn(
                    "pointer-events-auto mx-2 flex items-center gap-2 font-mono text-[9.5px] tracking-[0.06em] select-none",
                    lane.folded ? "" : "border-b border-dashed border-[var(--hairline)]",
                    lane.broken > 0 ? "text-[var(--bad)]" : lane.folded ? "text-[var(--accent)]" : "text-[var(--ink-2)]",
                  )}
                  style={{ height: LANE_HEAD - 6, marginTop: 2 }}
                >
                  {/* The grip says the box moves. Any part of the box not covered by a card
                      drags it — the name included — but a name does not look like a handle. */}
                  {isService && !lane.folded && <GripVertical aria-hidden className="-ml-1 size-3 flex-none text-[var(--ink-3)]" />}
                  {/* The name, edited where it is read, the way a card's question is: click
                      and type, and the branch and the choice's option change together on
                      Enter or on leaving the field. It was a double-click on a label before,
                      and that never fired — the box captures the pointer on press, so the
                      browser aims the click at the box and the label never hears it. Keyed by
                      the name so a refused rename (empty, or taken) snaps back to what stands.
                      The catch-all is not a name: it is whatever the caller says that is not
                      one of the others, and the label says so rather than pretending. */}
                  {isService && !nameless && !lane.folded ? (
                    <input
                      key={lane.label}
                      defaultValue={lane.label}
                      aria-label="Service name"
                      title={
                        catchAll
                          ? "The answer that brings a caller here — and where the call goes when the answer is none of the others. Click to rename, drag to move the service."
                          : "The answer that brings a caller here. Click to rename, drag to move the service."
                      }
                      /* Not focused on press: the press belongs to the box, which drags the
                         service by it. If the pointer never moves, the box focuses this on
                         release and the click is the edit it looked like. */
                      onPointerDown={(e) => {
                        if (document.activeElement !== e.currentTarget) e.preventDefault();
                        else e.stopPropagation();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") {
                          e.currentTarget.value = lane.label;
                          e.currentTarget.blur();
                        }
                      }}
                      onBlur={(e) => {
                        const name = e.currentTarget.value;
                        if (name.trim() === lane.label) return;
                        edit((f) => renameService(f, group, name));
                      }}
                      className="min-w-0 flex-1 cursor-text truncate rounded-[3px] border-0 bg-transparent px-0.5 py-0 font-mono text-[9.5px] tracking-[0.06em] text-inherit hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)] focus:text-[var(--ink)] focus:outline-none"
                    />
                  ) : (
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={nameless ? "Whatever the caller says that is not one of the other services. It has no name of its own." : undefined}
                    >
                      {lane.label}
                    </span>
                  )}
                  <span className="flex-none">
                    {lane.broken > 0 ? `${lane.broken} problem${lane.broken === 1 ? "" : "s"}` : lane.folded ? `${lane.steps} folded` : lane.steps}
                  </span>
                  {/* Fold a service away, or bring it back. On the lane rather than the fork,
                      because the lane is the thing that stops fitting the screen. */}
                  {lane.id !== "opening" && !lane.empty && (
                    <button
                      type="button"
                      aria-pressed={lane.folded}
                      title={lane.folded ? `Show the ${lane.label} steps` : `Fold ${lane.label} away`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => toggleFold(lane.id)}
                      className="pointer-events-auto grid size-4 flex-none place-items-center rounded-[3px] border border-[var(--hairline)] text-[10px] leading-none text-[var(--ink-3)] hover:border-[var(--ink-3)] hover:text-[var(--ink)]"
                    >
                      {lane.folded ? "+" : "−"}
                    </button>
                  )}
                  {/* Remove the service: its branch, its option and its own steps go together,
                      the way they arrived. Undo brings them back. The catch-all stays — a fork
                      without one cannot publish. */}
                  {isService && !catchAll && (
                    <button
                      type="button"
                      title={lane.steps === 0 ? "Remove this service" : `Remove this service and its ${lane.steps} step${lane.steps === 1 ? "" : "s"}`}
                      aria-label={`Remove the ${lane.label} service`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        edit((f) => removeService(f, group));
                        setSelected((s) => (s !== null && group.ids.includes(s) ? null : s));
                      }}
                      className="pointer-events-auto grid size-4 flex-none place-items-center rounded-[3px] border border-[var(--hairline)] text-[10px] leading-none text-[var(--ink-3)] hover:border-[var(--bad)] hover:text-[var(--bad)]"
                    >
                      ×
                    </button>
                  )}
                </div>
                {lane.empty && (
                  <p className="grid place-items-center px-3 text-center font-mono text-[9.5px] text-[var(--ink-3)]" style={{ height: BODY_H + 4 }}>
                    drop a step here
                  </p>
                )}
                {/* Where a dropped step would go on this lane: its end. */}
                {dropLane === lane.id && !lane.empty && (
                  <span aria-hidden className="absolute right-3 bottom-[3px] left-3 h-[2px] rounded bg-[var(--accent)]" />
                )}
              </div>
              );
            })}
            {/* Another service, beside the last one: the mockup's "+ Add a service" card. It
                only exists once the call forks — a straight line has nothing to add a service
                to — and adds the option, the branch and the first step together. */}
            {laneBoxes.length > 1 && (() => {
              const services = laneBoxes.filter((lane) => lane.id !== "opening");
              const first = services[0];
              if (first === undefined) return null;
              const rightmost = services.reduce((best, lane) => (lane.left > best.left ? lane : best), first);
              const aimedAt = dropNewService || dropBeforeLane === "";
              return (
                <button
                  type="button"
                  data-add-service
                  onClick={addNewService}
                  onPointerDown={(e) => e.stopPropagation()}
                  className={cn(
                    "absolute flex items-center justify-center gap-1.5 rounded-[7px] border border-dashed bg-transparent font-mono text-[10px] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]",
                    aimedAt ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--hairline)] text-[var(--ink-3)]",
                  )}
                  style={{ left: rightmost.left + rightmost.width + 12, top: rightmost.top, width: NODE_W + 16, height: LANE_HEAD + 40 }}
                >
                  {dropBeforeLane === "" ? "move here" : drag !== null && "node" in drag.source ? "+ as a new service" : "+ add a service"}
                </button>
              );
            })()}
            <svg className="pointer-events-none absolute inset-0 overflow-visible">
              <defs>
                {/* The head on a jump. A link down the page is read downwards without one;
                    a link that leaves for another service has to say which end it arrives at. */}
                <marker id="ansa-jump-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
                  <path d="M0 0 L8 4 L0 8 Z" fill="color-mix(in srgb, var(--accent) 70%, transparent)" />
                </marker>
              </defs>
              {edgePaths.map((p) => (
                  <g key={p.key}>
                    {/* Inert. A click on the link used to remove it, and a hairline that
                        deletes on contact is a trap on a drawing that is mostly hairlines:
                        it took the press meant for the lane behind it, and a slip left a dead
                        end. A link is changed by moving the step, or from the inspector. */}
                    <path
                      d={p.d}
                      fill="none"
                      stroke={p.jump ? "color-mix(in srgb, var(--accent) 70%, transparent)" : "color-mix(in srgb, var(--ink-3) 60%, transparent)"}
                      strokeWidth={1.5}
                      strokeDasharray={p.jump ? "4 3" : undefined}
                      markerEnd={p.jump ? "url(#ansa-jump-head)" : undefined}
                    />
                    {p.label !== "" && (
                      <text
                        x={p.mid.x}
                        y={p.mid.y}
                        textAnchor="middle"
                        className={cn("pointer-events-none font-mono text-[9.5px]", p.jump ? "fill-[var(--accent)]" : "fill-[var(--ink-3)]")}
                      >
                        {p.label}
                      </text>
                    )}
                  </g>
              ))}
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

            {inGraphOrder.filter((n) => !hidden.has(n.id)).map((n) => {
              const kind = NODE_KINDS[n.kind];
              const ports = portsFor(n);
              const line = cardLine(n, edges);
              const isBad = ready.nodes.has(n.id) || marked.get(n.id) === "blocks";
              return (
                <div
                  key={n.id}
                  data-flow-node={n.id}
                  ref={(el) => {
                    if (el) cardRefs.current.set(n.id, el);
                    else cardRefs.current.delete(n.id);
                  }}
                  tabIndex={0}
                  role="button"
                  aria-pressed={n.id === selected}
                  aria-label={`${kind.title}: ${line.title}${marked.has(n.id) ? ", has a problem" : ""}. Enter selects, Delete removes.`}
                  onKeyDown={(e) => onNodeKeyDown(e, n)}
                  onFocus={() => chooseStep(n.id)}
                  {...(movable(n) ? draggable({ node: n.id }) : {})}
                  onPointerDown={(e) => {
                    chooseStep(n.id);
                    e.stopPropagation();
                    if (movable(n)) draggable({ node: n.id }).onPointerDown(e);
                  }}
                  className={cn(
                    "focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none",
                    draggedNode === n.id && "opacity-40",
                    /* One line: the icon says what kind of step it is, the title says what it
                       does, the subtitle says how. The kind's name is no longer written on
                       the card — "Collect a value" on every question was the heaviest thing
                       on the drawing and told nobody anything the icon did not. */
                    "group absolute flex w-[208px] touch-none items-start gap-2 rounded-[7px] border bg-[var(--surface-solid)] px-2.5 py-[7px] select-none",
                    movable(n) ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                    dropAfter === n.id || dropBefore === n.id
                      ? "border-[var(--accent)]"
                      : isBad
                      ? "border-[var(--bad)]"
                      : marked.get(n.id) === "warns"
                        ? "border-[var(--warn)]"
                        : n.id === selected
                          ? "border-[var(--accent)] shadow-[0_0_0_2px_var(--accent-soft)]"
                          : "border-[var(--hairline)]",
                  )}
                  style={{ left: n.x, top: n.y }}
                >
                  <span
                    className="mt-[1px] grid size-4 flex-none place-items-center rounded-[4px]"
                    style={{ background: `color-mix(in srgb, ${kind.colour} 16%, transparent)` }}
                  >
                    <KindIcon kind={n.kind} size={10} />
                  </span>
                  <span className="min-w-0 flex-1">
                    {/* The words, edited where they are read. A question is typed into the title
                        it is shown as; anything else on the step stays in the inspector. */}
                    {line.edit === "title" ? (
                      <input
                        value={line.title}
                        onChange={(e) => line.onEdit?.(e.target.value)}
                        onPointerDown={(e) => e.stopPropagation()}
                        placeholder={line.placeholder}
                        aria-label={line.placeholder}
                        className="block w-full truncate border-0 bg-transparent p-0 text-[11px] leading-[1.35] font-semibold text-[var(--ink)] placeholder:font-normal placeholder:text-[var(--ink-3)] focus:outline-none"
                      />
                    ) : (
                      <b className="block truncate text-[11px] leading-[1.35] font-semibold text-[var(--ink)]">{line.title}</b>
                    )}
                    {line.edit === "subtitle" ? (
                      <input
                        value={line.subtitle}
                        onChange={(e) => line.onEdit?.(e.target.value)}
                        onPointerDown={(e) => e.stopPropagation()}
                        placeholder={line.placeholder}
                        aria-label={line.placeholder}
                        className="block w-full truncate border-0 bg-transparent p-0 font-mono text-[10px] leading-[1.45] text-[var(--ink-3)] placeholder:text-[var(--ink-3)] focus:text-[var(--ink-2)] focus:outline-none"
                      />
                    ) : (
                      <span className="block truncate font-mono text-[10px] leading-[1.45] text-[var(--ink-3)]">{line.subtitle}</span>
                    )}
                  </span>
                  {/* The mark that says this is the card the problems bar is naming. Two
                      channels: the border's colour, and this, for anyone who cannot see it. */}
                  {marked.has(n.id) && (
                    <span
                      role="img"
                      aria-label={marked.get(n.id) === "blocks" ? "has a problem that blocks publishing" : "has a warning"}
                      className={cn("mt-[3px] size-[7px] flex-none rounded-full", marked.get(n.id) === "blocks" ? "bg-[var(--bad)]" : "bg-[var(--warn)]")}
                    />
                  )}
                  {n.kind !== "start" && (
                    <IconButton
                      aria-label="Remove this step"
                      title="Remove this step"
                      className="absolute top-1 right-1 size-5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeNode(n.id);
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <X className="size-3" />
                    </IconButton>
                  )}
                  {/* Where a dropped step would go: the gap under this card, or above it. */}
                  {dropAfter === n.id && (
                    <span aria-hidden className="absolute right-2 -bottom-[13px] left-2 h-[2px] rounded bg-[var(--accent)]" />
                  )}
                  {dropBefore === n.id && (
                    <span aria-hidden className="absolute -top-[13px] right-2 left-2 h-[2px] rounded bg-[var(--accent)]" />
                  )}
                  {/* The dot a link lands on. Shown while something does land there, so every
                      drawn link visibly begins at one dot and ends at another. */}
                  {n.kind !== "start" && (
                    <span
                      aria-hidden
                      className={cn(
                        "absolute top-[-5px] left-[calc(50%-4.5px)] size-[9px] rounded-full border-[1.5px] border-[var(--ink-3)] bg-[var(--surface-solid)] transition-opacity",
                        n.id === selected || edges.some((edge) => edge.to === n.id) ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                      )}
                    />
                  )}
                  {/* The dots a link is dragged from. Quiet until the card is hovered or chosen,
                      because on a drawing of forty cards eighty dots are the drawing. */}
                  {ports.map((port, at) => (
                    <span
                      key={port.key}
                      ref={(el) => {
                        const key = `${n.id}:${port.key}`;
                        if (el) portRefs.current.set(key, el);
                        else portRefs.current.delete(key);
                      }}
                      title={port.key === "add" ? "Drag onto a step or a service to add a way out" : port.label === "" ? "Drag to the next step" : `${port.label} — drag to the next step`}
                      className={cn(
                        "absolute bottom-[-5px] size-[9px] cursor-crosshair rounded-full border-[1.5px] bg-[var(--surface-solid)] transition-[transform,opacity] hover:scale-125 hover:border-[var(--accent)]",
                        port.key === "add" && "border-dashed",
                        n.id === selected || edges.some((edge) => port.holds(edge))
                          ? "border-[var(--ink-3)] opacity-100"
                          : "border-[var(--ink-3)] opacity-0 group-hover:opacity-100",
                      )}
                      style={{ left: `calc(${portAlong(at, ports.length, n.kind) * 100}% - 4.5px)` }}
                      onPointerDown={(e) => onOutPortPointerDown(e, n, port)}
                      onPointerMove={onOutPortPointerMove}
                      onPointerUp={onOutPortPointerUp}
                    />
                  ))}
                </div>
              );
            })}
          </div>
          {/* The thing being dragged, following the pointer. Fixed to the screen and outside
              the panned layer, since a fixed element inside a transform is fixed to the
              transform. Takes no pointer events, so the target beneath it is what is hit. */}
          {drag !== null && (
            <div
              ref={ghostRef}
              aria-hidden
              className="pointer-events-none fixed top-0 left-0 z-50 will-change-transform"
              style={{ transform: `translate(${(dragRef.current?.lastX ?? -9999) - (dragRef.current?.offsetX ?? 0)}px,${(dragRef.current?.lastY ?? -9999) - (dragRef.current?.offsetY ?? 0)}px)` }}
            >
             <div style={{ transform: `scale(${view.scale})`, transformOrigin: "0 0" }}>
              {"kind" in drag.source && (
                <div className="flex items-center gap-2 rounded-[7px] border border-[var(--accent)] bg-[var(--surface-solid)] px-2.5 py-[7px] text-[11px] font-semibold text-[var(--ink)] shadow-lg">
                  <KindIcon kind={drag.source.kind} size={10} />
                  {NODE_KINDS[drag.source.kind].title}
                </div>
              )}
              {"node" in drag.source && (() => {
                const node = byId(drag.source.node);
                if (node === undefined) return null;
                const line = cardLine(node, edges);
                return (
                  <div className="flex w-[208px] items-start gap-2 rounded-[7px] border border-[var(--accent)] bg-[var(--surface-solid)] px-2.5 py-[7px] shadow-lg">
                    <span className="mt-[1px] grid size-4 flex-none place-items-center rounded-[4px]" style={{ background: `color-mix(in srgb, ${NODE_KINDS[node.kind].colour} 16%, transparent)` }}>
                      <KindIcon kind={node.kind} size={10} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <b className="block truncate text-[11px] leading-[1.35] font-semibold text-[var(--ink)]">{line.title || line.placeholder}</b>
                      <span className="block truncate font-mono text-[10px] leading-[1.45] text-[var(--ink-3)]">{line.subtitle}</span>
                    </span>
                  </div>
                );
              })()}
              {"lane" in drag.source && (
                <div className="rounded-[7px] border border-[var(--accent)] bg-[var(--surface)] px-3 py-1.5 font-mono text-[9.5px] tracking-[0.06em] text-[var(--ink)] shadow-lg" style={{ width: NODE_W + 16 }}>
                  {drag.source.lane.label} · {drag.source.lane.ids.length}
                </div>
              )}
             </div>
            </div>
          )}
        </div>

        {/* Whether this graph could answer a phone, under the graph itself and recomputed on
            every edit rather than at publish. `validateFlow` is the same function the publish
            gate runs, so nobody reaches a refusal having been told here that it was fine. */}
        <FlowStatus steps={nodes} problems={problems} onFocusNode={focusNode} />
        {/* The full list, only once there is more than the dock shows. */}
        {problems.length > 1 && <FlowProblems steps={nodes} problems={problems} onFocusNode={focusNode} />}
        </div>

        <div className="surface studio-inspector rounded-xl p-4">
          {/* The settings live here rather than in an overlay, so changing the voice never
              covers the call it speaks. Kept in the tree while hidden — see `settingsPane`. */}
          {settingsPane !== undefined && <div hidden={openSetting === null}>{settingsPane}</div>}
          <div hidden={openSetting !== null}>
          {selectedNode === null ? (
            <p className="py-6 text-center text-[12.5px] leading-relaxed text-[var(--ink-3)]">
              Select a node to edit what it says and how it behaves.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 grid size-8 flex-none place-items-center rounded-lg bg-[var(--surface-2)]">
                  <KindIcon kind={selectedNode.kind} size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="mb-0.5 flex items-baseline justify-between gap-2 font-mono text-[9.5px] tracking-[0.13em] text-[var(--ink-3)] uppercase">
                    <span>{NODE_KINDS[selectedNode.kind].title}</span>
                    <span>step {inGraphOrder.findIndex((n) => n.id === selectedNode.id) + 1}</span>
                  </p>
                  <h3 className="truncate text-[14px] font-[640] tracking-[-0.018em]">{cardLine(selectedNode, edges).title}</h3>
                </div>
              </div>

              {/* Every way out of this step, and where it goes. The dots on the card do this
                  with a drag; this does it with a select, so a keyboard can wire a graph. */}
              {portsFor(selectedNode).some((port) => port.key !== "add") && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[11px] font-medium text-[var(--ink-3)]">Where each way out leads</p>
                  {portsFor(selectedNode).filter((port) => port.key !== "add").map((port) => {
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
                <div className="flex flex-col gap-2">
                  <SelectField
                    label="Tool"
                    value={selectedNode.tool ?? ""}
                    onChange={(e) => updateSelected({ tool: e.target.value }, "tool")}
                    hint="From the organisation's registry. The step uses it; enabling it for this agent is in Settings, under Tools."
                  >
                    <option value="">— choose a tool —</option>
                    {availableTools.map((tool) => (
                      <option key={tool.name} value={tool.name}>
                        {tool.name}
                        {tool.enabled ? "" : " — not enabled yet"}
                      </option>
                    ))}
                    {/* Platform tools are on every call and never need enabling. */}
                    <option value="business_hours">business_hours — always available</option>
                  </SelectField>
                  {selectedNode.tool !== undefined &&
                    selectedNode.tool !== "" &&
                    availableTools.some((tool) => tool.name === selectedNode.tool && !tool.enabled) && (
                      <Notice tone="warn">
                        This agent has not been given {selectedNode.tool}, so publishing will be refused
                        until it is enabled.
                        <span className="mt-2 block">
                          <Button size="sm" onClick={onOpenSettings}>
                            Open Settings
                          </Button>
                        </span>
                      </Notice>
                    )}
                </div>
              )}

              {selectedNode.kind === "transfer" && (
                <Notice tone={transferNumber === null ? "warn" : "info"}>
                  {transferNumber === null
                    ? "No transfer number is set on this agent, so a caller reaching this step would be apologised to and hung up on."
                    : `Hands the call to ${transferNumber}, the transfer number under Routing & hours.`}
                  <span className="mt-2 block">
                    <Button size="sm" onClick={onOpenSettings}>
                      {transferNumber === null ? "Set a transfer number" : "Change it"}
                    </Button>
                  </span>
                </Notice>
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
    </div>
  );
};
