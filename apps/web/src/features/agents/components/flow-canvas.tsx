"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

import {
  CheckCircle2,
  GitBranch,
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

import { foldedAway, LANE_HEAD, laneGroups, sameShape, tidied, TOP } from "../flow-layout";

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
      if (field?.type === "choice") parts.push(`${field.options.length} answers`);
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
/** A card's height, for the fallback before it has been measured. One line: icon, title, subtitle. */
const BODY_H = 44;

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

/** Where the `at`-th of `count` ports sits along a card's bottom edge, as a fraction of its width. */
const portAlong = (at: number, count: number): number => (2 * at + 1) / (2 * Math.max(count, 1));

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
  const [history, setHistory] = useState<History>(() => ({ past: [], present: tidied(loaded ?? emptyFlow()), future: [] }));
  const [pending, setPending] = useState<Readonly<Record<string, readonly FlowCondition[]>>>({});
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [temp, setTemp] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // Bumped whenever the canvas needs its port positions re-read from the DOM — after a tab
  // that was hidden becomes visible, chiefly, since `offsetTop` is 0 until then.
  const [tick, setTick] = useState(0);
  /** Branch heads the reader has folded away, so six services fit a laptop. */
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
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
  const laneHeads = new Set(lanes.filter((lane) => lane.id !== "opening").map((lane) => lane.id));

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

  /* A link leaves from the middle of the card's bottom edge whichever port it belongs to,
     so a link down a column is a vertical line and a fork is a fan from one point — the
     shape the drawing has. The port dots along the edge are where a link is *dragged* from;
     where a drawn link appears to start is a separate question, and this is its answer. */
  const outPoint = (node: FlowNode, _key: string, _at: number): Point => ({
    x: node.x + NODE_W / 2,
    y: node.y + (cardRefs.current.get(node.id)?.offsetHeight ?? BODY_H),
  });
  const inPoint = (node: FlowNode): Point => ({ x: node.x + NODE_W / 2, y: node.y });

  // Read fresh on every render — `tick` exists purely to force one after visibility flips.
  void tick;
  const edgePaths = edges.map((edge, at) => {
    const from = byId(edge.from);
    const to = byId(edge.to);
    if (!from || !to) return null;
    // A link to a step that has been folded away has nothing to point at — unless the step
    // heads a lane, in which case the lane's header is standing in and the link lands on it.
    if (hidden.has(edge.from)) return null;
    if (hidden.has(edge.to) && !(laneHeads.has(edge.to) && folded.has(edge.to))) return null;
    const ports = portsFor(from);
    const index = ports.findIndex((port) => port.holds(edge));
    const p1 = outPoint(from, ports[index]?.key ?? "", Math.max(index, 0));
    const p2 = folded.has(to.id) ? { x: to.x + NODE_W / 2, y: to.y - LANE_HEAD } : inPoint(to);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 - 5 };
    /* A word on the link only where the call splits. "got it" on every question was a word
       on every link, which is the same as a word on none; "gave up", "failed" and a branch's
       answer are the ones that change where the caller ends up. A link into a lane's first
       step carries no word either: the lane's own header already says which answer it is. */
    const splits = from.kind === "decide" || index > 0;
    const intoLane = laneHeads.has(to.id);
    return { key: at, d: bezier(p1, p2), label: splits && !intoLane ? (ports[index]?.label ?? "") : "", mid };
  });

  const localPoint = (e: ReactPointerEvent): Point => {
    const box = canvasRef.current?.getBoundingClientRect();
    return { x: e.clientX - (box?.left ?? 0) - pan.x, y: e.clientY - (box?.top ?? 0) - pan.y };
  };

  /* Dragging a card used to live here. It is gone on purpose: with the layout derived from
     the graph, moving a card by hand would be undone by the next edit, which is a worse
     experience than not being able to move it at all. Clicking a header still selects. */

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

  const addNode = (kind: FlowNodeKind) => {
    const id = freshId(new Set(nodes.map((n) => n.id)));
    edit((f) => ({ ...f, nodes: [...f.nodes, blankNode(id, kind, 120 - pan.x + ((f.nodes.length % 4) * 26), 460 - pan.y)] }));
    chooseStep(id);
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
    chooseStep(nodeId);
    setPan({ x: 120 - node.x, y: 90 - node.y });
  };

  const fit = () => {
    const first = nodes[0];
    if (first === undefined) return setPan({ x: 0, y: 0 });
    setPan({ x: 24 - Math.min(...nodes.map((n) => n.x)), y: TOP - Math.min(...nodes.map((n) => n.y)) });
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

  /**
   * The labelled boxes behind the cards: the shared opening, then one per service.
   *
   * Read from the DOM for height the same way the links read the ports — a card grows with
   * the words in it, and a box drawn to a guessed height clips the card it is meant to
   * contain. One render stale is fine and is what the links already accept.
   */
  const laneBoxes = lanes
    .map((lane) => {
      const head = lane.id === "opening" ? undefined : byId(lane.id);
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
      if (cards.length === 0) return null;
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
        /* The header sits inside the box above the first card; the box hugs the cards by
           the same 8 pixels the drawing's lanes use. */
        left: left - 8,
        top: top - LANE_HEAD,
        width: right - left + 16,
        height: bottom - top + LANE_HEAD + 8,
      };
    })
    .filter((lane): lane is NonNullable<typeof lane> => lane !== null)
    .map((box, _at, all) => {
      /* "Everyone gets this" spans the services it splits into, the way the drawing has it
         — a column of shared questions is narrower than the lanes beneath it, and a box
         that hugged the column would leave the fan of links starting from nowhere. */
      if (box.id !== "opening" || all.length < 2) return box;
      const others = all.filter((other) => other.id !== "opening");
      const left = Math.min(box.left, ...others.map((other) => other.left));
      const right = Math.max(box.left + box.width, ...others.map((other) => other.left + other.width));
      return { ...box, left, width: right - left };
    });

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
                  onClick={() => addNode(kind)}
                  className="flex w-full cursor-grab items-center gap-2 rounded-lg px-2.5 py-[7px] text-left text-[12.5px] text-[var(--ink-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
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
            <Button size="sm" variant="ghost" onClick={fit} title="Bring the drawing back under the viewport">
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
          <div className="absolute inset-0" style={{ transform: `translate(${pan.x}px,${pan.y}px)`, transformOrigin: "0 0" }}>
            {/* The lanes, behind everything and clickable through: a label saying which part
                of the business a column of cards belongs to. `pointer-events-none` because a
                box is a caption, not a target — clicking inside one should reach the card. */}
            {laneBoxes.map((lane) => (
              <div
                key={lane.id}
                aria-hidden={lane.id === "opening"}
                className={cn(
                  "pointer-events-none absolute rounded-[7px] border bg-[var(--surface)]",
                  lane.broken > 0 ? "border-[var(--bad)]" : lane.folded ? "border-[var(--accent)]" : "border-[var(--hairline)]",
                )}
                style={{ left: lane.left, top: lane.top, width: lane.width, height: lane.height }}
              >
                <div
                  className={cn(
                    "mx-2 flex items-center gap-2 font-mono text-[9.5px] tracking-[0.06em]",
                    lane.folded ? "" : "border-b border-dashed border-[var(--hairline)]",
                    lane.broken > 0 ? "text-[var(--bad)]" : lane.folded ? "text-[var(--accent)]" : "text-[var(--ink-2)]",
                  )}
                  style={{ height: LANE_HEAD - 6, marginTop: 2 }}
                >
                  <span className="min-w-0 flex-1 truncate">{lane.label}</span>
                  <span className="flex-none">
                    {lane.broken > 0 ? `${lane.broken} problem${lane.broken === 1 ? "" : "s"}` : lane.folded ? `${lane.steps} folded` : lane.steps}
                  </span>
                  {/* Fold a service away, or bring it back. On the lane rather than the fork,
                      because the lane is the thing that stops fitting the screen. */}
                  {lane.id !== "opening" && (
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
                </div>
              </div>
            ))}
            <svg className="pointer-events-none absolute inset-0 overflow-visible">
              {edgePaths.map((p) =>
                p === null ? null : (
                  <g key={p.key}>
                    <path
                      d={p.d}
                      fill="none"
                      stroke="color-mix(in srgb, var(--ink-3) 60%, transparent)"
                      strokeWidth={1.5}
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
                  onPointerDown={(e) => {
                    chooseStep(n.id);
                    e.stopPropagation();
                  }}
                  className={cn(
                    "focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none",
                    /* One line: the icon says what kind of step it is, the title says what it
                       does, the subtitle says how. The kind's name is no longer written on
                       the card — "Collect a value" on every question was the heaviest thing
                       on the drawing and told nobody anything the icon did not. */
                    "group absolute flex w-[208px] cursor-pointer items-start gap-2 rounded-[7px] border bg-[var(--surface-solid)] px-2.5 py-[7px] select-none",
                    isBad
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
                      title={port.label === "" ? "Drag to the next step" : `${port.label} — drag to the next step`}
                      className={cn(
                        "absolute bottom-[-5px] size-[9px] cursor-crosshair rounded-full border-[1.5px] bg-[var(--surface-solid)] transition-[transform,opacity] hover:scale-125 hover:border-[var(--accent)]",
                        n.id === selected || edges.some((edge) => port.holds(edge))
                          ? "border-[var(--ink-3)] opacity-100"
                          : "border-[var(--ink-3)] opacity-0 group-hover:opacity-100",
                      )}
                      style={{ left: `calc(${portAlong(at, ports.length) * 100}% - 4.5px)` }}
                      onPointerDown={(e) => onOutPortPointerDown(e, n, port)}
                      onPointerMove={onOutPortPointerMove}
                      onPointerUp={onOutPortPointerUp}
                    />
                  ))}
                </div>
              );
            })}
          </div>
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
