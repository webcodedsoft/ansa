"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { IconButton, Notice, TextAreaField, TextField } from "@/components/ui";
import { cn } from "@/lib/cn";

/**
 * The conversation flow, authored as a graph.
 *
 * Local component state only — there is nowhere in the API to persist this yet. The note
 * in the tab above this component says so; this file does not pretend otherwise. Nodes are
 * dragged, wired and deleted with pointer events and pointer capture (not mouse events), so
 * a trackpad, a mouse and a touchscreen all behave the same.
 *
 * Port positions are measured from the rendered DOM (`offsetTop` of each `.port.out`
 * element) rather than computed from a fixed layout, because a `collect` node has two
 * outputs and a `say` node has one — a hard-coded offset would wire the wrong one the first
 * time a node with a different output count was dragged in. The cost of that is the reason
 * for the visibility watcher below: `offsetTop` reads 0 for an element inside a `hidden`
 * ancestor, and this canvas lives inside a tab panel that starts hidden.
 */

type NodeKind = "start" | "say" | "collect" | "confirm" | "decide" | "tool" | "transfer" | "hangup";

interface FlowNode {
  readonly id: string;
  readonly kind: NodeKind;
  x: number;
  y: number;
  text?: string;
  field?: string;
  tool?: string;
  capture?: string;
  confirm?: string;
}

interface FlowEdge {
  readonly from: string;
  readonly port: number;
  readonly to: string;
}

interface NodeKindSpec {
  readonly title: string;
  readonly colour: string;
  readonly outs: readonly string[];
  readonly body: (n: FlowNode) => string;
}

const NODE_KINDS: Record<NodeKind, NodeKindSpec> = {
  start: { title: "Call answered", colour: "var(--ok)", outs: [""], body: () => "The caller has picked up, or has dialled in." },
  say: { title: "Say something", colour: "var(--accent)", outs: [""], body: (n) => `“${n.text ?? ""}”` },
  collect: { title: "Collect a value", colour: "var(--ok)", outs: ["got it", "gave up"], body: (n) => `${n.field ?? ""} · ${n.capture ?? ""} · ${n.confirm ?? ""}` },
  confirm: { title: "Confirm a value", colour: "var(--ok)", outs: ["yes", "no"], body: (n) => `Read back ${n.field ?? ""}` },
  decide: { title: "Branch", colour: "var(--accent)", outs: ["renewal", "claim", "other"], body: (n) => `On ${n.field ?? ""}` },
  tool: { title: "Call a tool", colour: "var(--warn)", outs: ["ok", "failed"], body: (n) => `${n.tool ?? ""}` },
  transfer: { title: "Transfer to human", colour: "var(--bad)", outs: [], body: () => "Rings a person. Irreversible tools land here." },
  hangup: { title: "End the call", colour: "var(--ink-3)", outs: [], body: () => "Says goodbye and hangs up." },
};

const PALETTE: readonly { readonly group: string; readonly kinds: readonly NodeKind[] }[] = [
  { group: "Speech", kinds: ["say", "collect", "confirm"] },
  { group: "Logic", kinds: ["decide", "tool"] },
  { group: "Ending", kinds: ["transfer", "hangup"] },
];

const seedNode = (id: string, kind: NodeKind, x: number, y: number): FlowNode => {
  const n: FlowNode = { id, kind, x, y };
  if (kind === "say") n.text = "Good afternoon, Kano General Insurance.";
  if (kind === "collect") { n.field = "policyNumber"; n.capture = "keypad"; n.confirm = "read back"; }
  if (kind === "tool") n.tool = "policy_lookup";
  if (kind === "decide") n.field = "reason";
  return n;
};

const SEED_NODES: readonly FlowNode[] = [
  seedNode("n1", "start", 40, 40),
  seedNode("n2", "say", 40, 168),
  seedNode("n3", "collect", 300, 168),
  seedNode("n4", "tool", 300, 330),
  seedNode("n5", "decide", 560, 40),
  seedNode("n6", "transfer", 560, 330),
];

const SEED_EDGES: readonly FlowEdge[] = [
  { from: "n1", port: 0, to: "n2" },
  { from: "n2", port: 0, to: "n3" },
  { from: "n3", port: 0, to: "n4" },
  { from: "n3", port: 1, to: "n6" },
  { from: "n4", port: 0, to: "n5" },
  { from: "n4", port: 1, to: "n6" },
];

const NODE_W = 208;
const HEAD = 15;

interface Point {
  readonly x: number;
  readonly y: number;
}

const bezier = (p1: Point, p2: Point): string => {
  const dx = Math.max(46, Math.abs(p2.x - p1.x) * 0.45);
  return `M${p1.x} ${p1.y} C${p1.x + dx} ${p1.y},${p2.x - dx} ${p2.y},${p2.x} ${p2.y}`;
};

let idSeq = 100;
const nextId = (): string => `n${idSeq++}`;

export const FlowCanvas = () => {
  const [nodes, setNodes] = useState<readonly FlowNode[]>(SEED_NODES);
  const [edges, setEdges] = useState<readonly FlowEdge[]>(SEED_EDGES);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [temp, setTemp] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // Bumped whenever the canvas needs its port positions re-read from the DOM — after a tab
  // that was hidden becomes visible, chiefly, since `offsetTop` is 0 until then.
  const [tick, setTick] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const portRefs = useRef(new Map<string, HTMLSpanElement>());
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const wireRef = useRef<{ from: string; port: number } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

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

  const byId = (id: string): FlowNode | undefined => nodes.find((n) => n.id === id);

  const outPoint = (node: FlowNode, port: number): Point => {
    const dot = portRefs.current.get(`${node.id}:${port}`);
    return dot ? { x: node.x + NODE_W, y: node.y + dot.offsetTop + 5.5 } : { x: node.x + NODE_W, y: node.y + HEAD };
  };
  const inPoint = (node: FlowNode): Point => ({ x: node.x, y: node.y + HEAD });

  // Read fresh on every render — `tick` exists purely to force one after visibility flips.
  void tick;
  const edgePaths = edges.map((e, i) => {
    const a = byId(e.from);
    const b = byId(e.to);
    if (!a || !b) return null;
    const p1 = outPoint(a, e.port);
    const p2 = inPoint(b);
    const label = (NODE_KINDS[a.kind].outs[e.port] ?? "").trim();
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 - 5 };
    return { key: i, d: bezier(p1, p2), label, mid };
  });

  const localPoint = (e: ReactPointerEvent): Point => {
    const box = canvasRef.current?.getBoundingClientRect();
    return { x: e.clientX - (box?.left ?? 0) - pan.x, y: e.clientY - (box?.top ?? 0) - pan.y };
  };

  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>, node: FlowNode) => {
    setSelected(node.id);
    dragRef.current = { id: node.id, dx: e.clientX - node.x, dy: e.clientY - node.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onHeaderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const x = Math.round(e.clientX - drag.dx);
    const y = Math.round(e.clientY - drag.dy);
    setNodes((prev) => prev.map((n) => (n.id === drag.id ? { ...n, x, y } : n)));
  };
  const onHeaderPointerUp = () => {
    dragRef.current = null;
  };

  const onOutPortPointerDown = (e: ReactPointerEvent<HTMLSpanElement>, node: FlowNode, port: number) => {
    wireRef.current = { from: node.id, port };
    setTemp({ x1: 0, y1: 0, x2: 0, y2: 0 });
    e.currentTarget.setPointerCapture(e.pointerId);
    e.stopPropagation();
    e.preventDefault();
  };
  const onOutPortPointerMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const wire = wireRef.current;
    if (!wire) return;
    const a = byId(wire.from);
    if (!a) return;
    const p1 = outPoint(a, wire.port);
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
    if (to !== null && to !== undefined && to !== wire.from) {
      setEdges((prev) => [...prev.filter((x) => !(x.from === wire.from && x.port === wire.port)), { from: wire.from, port: wire.port, to }]);
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

  const addNode = (kind: NodeKind) => {
    const id = nextId();
    const n = seedNode(id, kind, 120 - pan.x + ((nodes.length % 4) * 26), 460 - pan.y);
    if (kind === "collect") n.capture = "speech";
    if (kind === "confirm") n.field = "newField";
    setNodes((prev) => [...prev, n]);
    setSelected(id);
  };

  const removeNode = (id: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== id));
    setEdges((prev) => prev.filter((x) => x.from !== id && x.to !== id));
    setSelected((s) => (s === id ? null : s));
  };

  const removeEdge = (index: number) => {
    setEdges((prev) => prev.filter((_, i) => i !== index));
  };

  const tidyUp = () => {
    setNodes((prev) => prev.map((n, i) => ({ ...n, x: 40 + (i % 3) * 260, y: 40 + Math.floor(i / 3) * 150 })));
    setPan({ x: 0, y: 0 });
  };

  const updateSelected = (patch: Partial<FlowNode>) => {
    setNodes((prev) => prev.map((n) => (n.id === selected ? { ...n, ...patch } : n)));
  };

  const selectedNode = selected === null ? null : (byId(selected) ?? null);

  return (
    <div ref={rootRef} data-flow-canvas>
      <Notice tone="warn" className="mb-3.5">
        This flow lives in this browser tab only. There is nowhere in the API to save a
        graph yet, so leaving this page loses it — the conversation this agent actually runs
        is the Conversation, Data captured and Tools tabs, which do publish.
      </Notice>

      <div className="grid items-start gap-3.5 lg:grid-cols-[186px_minmax(0,1fr)_280px]">
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

        <div
          ref={canvasRef}
          className={cn(
            "relative h-[560px] touch-none overflow-hidden rounded-xl border border-[var(--hairline)] bg-[var(--surface-2)] shadow-[var(--spec)]",
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

            {nodes.map((n) => {
              const kind = NODE_KINDS[n.kind];
              return (
                <div
                  key={n.id}
                  data-flow-node={n.id}
                  className={cn(
                    "glass absolute w-[208px] rounded-[13px] border select-none",
                    n.id === selected ? "border-[var(--accent)] shadow-[0_0_0_2px_var(--accent-soft)]" : "border-[var(--hairline)]",
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
                  {kind.outs.length > 0 && (
                    <div className="flex flex-col gap-1.5 px-2.5 pb-[9px]">
                      {kind.outs.map((o, i) => (
                        <div key={i} className="flex h-3.5 items-center justify-end font-mono text-[10.5px] text-[var(--ink-3)]">
                          {o}
                        </div>
                      ))}
                    </div>
                  )}
                  {n.kind !== "start" && (
                    <span className="absolute top-[15px] left-[-6px] size-[11px] rounded-full border-2 border-[var(--ink-3)] bg-[var(--surface-solid)]" />
                  )}
                  {kind.outs.map((_, i) => (
                    <span
                      key={i}
                      ref={(el) => {
                        const key = `${n.id}:${i}`;
                        if (el) portRefs.current.set(key, el);
                        else portRefs.current.delete(key);
                      }}
                      className="absolute right-[-6px] size-[11px] cursor-crosshair rounded-full border-2 border-[var(--ink-3)] bg-[var(--surface-solid)] transition-transform hover:scale-125 hover:border-[var(--accent)]"
                      style={{ top: (n.kind === "start" ? HEAD : HEAD) + i * 20 }}
                      onPointerDown={(e) => onOutPortPointerDown(e, n, i)}
                      onPointerMove={onOutPortPointerMove}
                      onPointerUp={onOutPortPointerUp}
                    />
                  ))}
                </div>
              );
            })}
          </div>

          <div
            data-canvas-bar
            className="glass absolute bottom-3 left-3 z-[5] flex items-center gap-1.5 rounded-lg border border-[var(--hairline)] px-2 py-1.5 text-[11.5px] text-[var(--ink-3)]"
          >
            <span>
              {nodes.length} nodes · {edges.length} links
            </span>
            <span>·</span>
            <button type="button" className="underline" onClick={tidyUp}>
              Tidy up
            </button>
          </div>
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

              {"text" in selectedNode && selectedNode.text !== undefined && (
                <TextAreaField label="What it says" value={selectedNode.text} onChange={(e) => updateSelected({ text: e.target.value })} />
              )}
              {"field" in selectedNode && selectedNode.field !== undefined && (
                <TextField label="Field" value={selectedNode.field} onChange={(e) => updateSelected({ field: e.target.value })} className="font-mono" />
              )}
              {"tool" in selectedNode && selectedNode.tool !== undefined && (
                <TextField label="Tool" value={selectedNode.tool} onChange={(e) => updateSelected({ tool: e.target.value })} className="font-mono" />
              )}
              {"capture" in selectedNode && selectedNode.capture !== undefined && (
                <TextField
                  label="Captured by"
                  value={selectedNode.capture}
                  onChange={(e) => updateSelected({ capture: e.target.value })}
                  hint="Keypad survives the codec; speech does not, for anything with a checkable structure."
                />
              )}
              {"confirm" in selectedNode && selectedNode.confirm !== undefined && (
                <TextField
                  label="Confirmed by"
                  value={selectedNode.confirm}
                  onChange={(e) => updateSelected({ confirm: e.target.value })}
                  hint="Enforced in the dispatch path, not asked of the model."
                />
              )}

              {NODE_KINDS[selectedNode.kind].outs.length > 1 && (
                <div>
                  <span className="mb-1.5 block text-[12.5px] font-medium">Branches</span>
                  <div className="flex flex-wrap gap-1.5">
                    {NODE_KINDS[selectedNode.kind].outs.map((o) => (
                      <span key={o} className="rounded-full border border-[var(--hairline)] bg-[var(--surface-2)] px-2 py-0.5 text-[11.5px]">
                        {o}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
