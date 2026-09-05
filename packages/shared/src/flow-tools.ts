import type { Flow } from "./flow";

/**
 * The internal tools a flow has to name before a call gets them.
 *
 * Four, and not the other six. The line is not "how dangerous is it" — it is whether the
 * tool is a *step in the conversation the operator drew* or part of the machinery that runs
 * any conversation at all. `record_answer` and `confirm_answer` are how the engine writes and
 * reads back a captured field; `end_call` is how any call finishes; `business_hours` and
 * `search_knowledge_base` answer questions rather than doing anything. None of those is a
 * step somebody would draw, so gating them on a drawing would only mean flows that silently
 * stop working. The four here are all steps: offer times, take one, hand to a person, hand to
 * a person urgently.
 *
 * A form-authored agent has no nodes, so it names nothing and this never applies to it — see
 * `namedInternalTools`, which returns null rather than an empty set for that case. The
 * difference matters: "named nothing" and "has no way to name anything" must not collapse
 * into the same answer, or switching an agent to a form would take its tools away.
 */
export const GATED_INTERNAL_TOOLS: readonly string[] = [
  "find_appointment_slots",
  "book_appointment",
  "transfer_to_human",
  "transfer_urgently",
];

/**
 * Which node kinds name a tool by being that kind.
 *
 * A `transfer` node is not a `tool` node with `tool: "transfer_to_human"` — it is its own
 * kind, drawn as its own shape, and `flow-form` walks to `{ kind: "transfer" }`. It names the
 * tool as plainly as a tool node does, just structurally, so reading only `.tool` would take
 * the transfer tool away from every flow that draws a transfer step. That is the whole
 * feature failing on its most common use.
 *
 * `hangup` and `end_call` are the same relationship, and are listed for the day `end_call`
 * joins the gated set. Nothing reads this for an ungated tool, so listing it costs nothing
 * and stops the next person having to rediscover the pairing.
 */
const KIND_NAMES_TOOL: Readonly<Record<string, string>> = {
  transfer: "transfer_to_human",
  hangup: "end_call",
};

/**
 * Every internal tool this flow names, or null when there is no flow to read.
 *
 * Null means "not authored as a graph", and every caller must treat it as "gate nothing" —
 * an agent conducted by the ordered list has no nodes and cannot name anything, so applying
 * the gate to it would remove all four tools from every form-authored agent at once.
 *
 * The returned set is deliberately not filtered to `GATED_INTERNAL_TOOLS`. It is the honest
 * answer to "what does this drawing mention", and the callers do the filtering, so a tool
 * moving in or out of the gated set is one edit above rather than two here.
 */
export const namedInternalTools = (flow: Flow | null): ReadonlySet<string> | null => {
  if (flow === null) return null;

  const named = new Set<string>();
  for (const node of flow.nodes) {
    const byKind = KIND_NAMES_TOOL[node.kind];
    if (byKind !== undefined) named.add(byKind);
    const tool = node.tool;
    if (typeof tool === "string" && tool.trim() !== "") named.add(tool.trim());
  }
  return named;
};

/**
 * Does this call get that tool?
 *
 * The one question both halves ask — the prompt, deciding what to describe, and the registry,
 * deciding what to hold. They must never disagree: a tool described and not held is one the
 * agent will offer a caller and then fail to use, which is the failure the whole gate exists
 * to prevent, and a tool held and not described is dead weight the model never reaches for.
 */
export const flowAllowsTool = (named: ReadonlySet<string> | null, tool: string): boolean =>
  named === null || !GATED_INTERNAL_TOOLS.includes(tool) || named.has(tool);
