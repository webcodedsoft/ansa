/**
 * Layer 4 of 5 — the task. Derived per call, from what is registered rather than from
 * anything a organization wrote.
 *
 * §3 of the architecture doc describes this layer as "which tools are registered and when
 * to use them". The registry that will supply them is being built separately (R5.2.0, one
 * registry, one dispatch path), so today every call composes the empty case.
 *
 * The empty case is not a placeholder. It is the most useful sentence in the prompt right
 * now: the agent currently cannot look anything up, and the honest summary of a day of
 * calls was "a genuinely good conversationalist with nothing to talk about". Telling the
 * model that plainly is what turns an invented policy status into "I can't check that for
 * you, let me put you through to someone who can".
 */

import { KNOWLEDGE_TOOL_NAME } from "../orchestrator/knowledge";
import type { CaptureRoute, CollectedField, Confirmation } from "../tenancy/captured-fields";

/**
 * What the composer needs to know about a tool. Deliberately not the registry's own type:
 * this layer wants a name, a sentence and a tier, and coupling the prompt to the
 * registry's shape would make every registry change a prompt change.
 */
export interface AvailableTool {
  readonly name: string;
  /** One line, in the register it will be reasoned about. */
  readonly description: string;
  readonly riskTier: "read" | "write" | "irreversible";
}

/**
 * Risk tier is a required field at registration and is enforced in the dispatch path
 * (R5.3). What appears here is the model's *expectation* of what will happen, so that its
 * turn plan matches what the code is going to do to it — a model that thinks a `write`
 * fires immediately will phrase the turn as though it already has.
 */
const TIER_NOTE: Readonly<Record<AvailableTool["riskTier"], string>> = {
  read: "runs straight away",
  write: "only after you've said it back and they've agreed",
  irreversible: "never by you — this one goes to a person",
};

/**
 * How each field is asked for, in the model's own terms.
 *
 * The route matters to the wording, not just to the plumbing: an agent that says "read it
 * to me" when the caller is meant to key it in gets speech on a line where the digits would
 * have survived intact. So the instruction names the route rather than leaving the model to
 * infer it from the operator's prompt.
 */
const ROUTE_NOTE: Readonly<Record<CaptureRoute, string>> = {
  speech: "ask them to say it",
  keypad: "ask them to key it in on their phone",
  either: "let them say it or key it in, whichever they prefer",
};

/**
 * And how it is pinned down before anything acts on it.
 *
 * This is the model's *expectation*, not the enforcement. Confirmation is enforced in the
 * dispatch path — a write-tier tool will not fire on an unconfirmed value however sure the
 * transcriber was — and stating it here only keeps the turn plan matching what the code is
 * about to do. A model that thinks it may act on an unconfirmed policy number phrases the
 * turn as though it already has.
 */
const CONFIRM_NOTE: Readonly<Record<Confirmation, string>> = {
  none: "no need to check it back",
  readback: "say it back to them and get a yes before you use it",
  spellback: "spell it back to them and get a yes before you use it",
};

/**
 * The form this agent conducts, if it has one (migration 0021).
 *
 * Part of the task layer rather than the organization layer, and that placement is the point:
 * this is structured configuration the operator built in the console, not the bounded free
 * text a organization types. It is not fenced and not filtered, because it cannot say anything —
 * every sentence here is generated from a closed set of routes and confirmations, and the
 * only organization-authored string in it is the wording of the question itself.
 */
/**
 * `callbackNumber` → `callback number`, for the fallback wording only.
 *
 * The key is an identifier because tools receive it; it is not something to say out loud.
 * When an operator has not written the question themselves, the model still has to ask
 * one, and "ask for their callbackNumber" is a phrase no person would use.
 */
const spoken = (key: string): string =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();

const collectionSection = (fields: readonly CollectedField[]): readonly string[] => {
  if (fields.length === 0) return [];

  return [
    "",
    "There are things you need from them on this call. Ask for them in this order, one at a",
    "time, and don't read the list out:",
    ...fields.map((field) => {
      const asked = field.prompt === "" ? `ask for their ${spoken(field.key)}` : `"${field.prompt}"`;
      const need = field.required ? "needed" : "optional — move on if they won't say";
      return `- ${field.key}: ${asked} — ${ROUTE_NOTE[field.capture]}, ${CONFIRM_NOTE[field.confirm]} (${need})`;
    }),
    "Fit them into the conversation rather than marching through them. If they have already",
    "told you one, don't ask again. If they ask a question mid-way, answer it and come back.",
  ];
};

/**
 * Answer from what was retrieved, or say you don't know.
 *
 * Composed only when `search_knowledge_base` is in the list, and it is only in the list
 * when the agent has sources behind it — so an agent with none is never told about a
 * knowledge base it hasn't got. Derived from the tools rather than passed in as a flag,
 * for the same reason the tool list is derived from the registered definitions: the prompt
 * then cannot ground the model in a store nobody registered.
 *
 * The last two lines are the ones that matter. A model told only to search will search,
 * find nothing, and answer anyway from what it knows about businesses of that kind — a
 * delivery charge that is right for most Lagos couriers and wrong for this one. Nothing on
 * the call distinguishes that from the truth until the caller has acted on it.
 */
const groundingSection = (tools: readonly AvailableTool[]): readonly string[] => {
  if (!tools.some((tool) => tool.name === KNOWLEDGE_TOOL_NAME)) return [];

  return [
    "",
    "One of those searches what the organisation has actually written down. Use it for",
    "anything about how they work — what they offer, what it costs, what their rules are,",
    "where they are — rather than answering from what you know about businesses like theirs.",
    "Say only what came back. Your own words are fine; going further than the words you were",
    "given is not.",
    "If it comes back with nothing, say plainly that you don't have that and offer to put",
    "them through to someone who does. Never fill the gap yourself.",
  ];
};

export const taskLayer = (
  tools: readonly AvailableTool[],
  fields: readonly CollectedField[] = [],
): string => {
  const collection = collectionSection(fields);
  const grounding = groundingSection(tools);

  if (tools.length === 0) {
    // Deliberately says "their records" rather than naming what kind of records this
    // organisation keeps. Naming them is the organization's job, in their own layer, and a
    // domain baked in here would be wrong for the next organization and a word the model
    // reaches for on this one.
    return [
      "You can't look anything up on this call. You have no access to their account or to",
      "anything the organisation has on file.",
      "If they ask for something only those records could answer, say so plainly in a few",
      "words and offer to put them through to someone who can check. Don't guess, don't",
      "approximate, and don't say you'll check and come back.",
      ...collection,
    ].join("\n");
  }

  return [
    "You can look these up. Use one only when the caller has actually asked for it:",
    ...tools.map((t) => `- ${t.name}: ${t.description} (${TIER_NOTE[t.riskTier]})`),
    // Describes what actually happens now that the loop is wired. The gap is covered by
    // pre-rendered filler audio the model has no part in, so the earlier wording — "you'll
    // be told to say something to fill the gap" — described a mechanism that does not
    // exist and invited the model to narrate one.
    "Ask for one instead of answering, and wait. The pause is covered for you.",
    "You'll be told what came back, in plain words. Never say a lookup worked, or that",
    "anything has been changed, until you have been told it did.",
    ...grounding,
    ...collection,
  ].join("\n");
};
