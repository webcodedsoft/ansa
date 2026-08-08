/**
 * Layer 4 of 5 — the task. Derived per call, from what is registered rather than from
 * anything a tenant wrote.
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

export const taskLayer = (tools: readonly AvailableTool[]): string => {
  if (tools.length === 0) {
    // Deliberately says "their records" rather than naming what kind of records this
    // organisation keeps. Naming them is the tenant's job, in their own layer, and a
    // domain baked in here would be wrong for the next tenant and a word the model
    // reaches for on this one.
    return [
      "You can't look anything up on this call. You have no access to their account or to",
      "anything the organisation has on file.",
      "If they ask for something only those records could answer, say so plainly in a few",
      "words and offer to put them through to someone who can check. Don't guess, don't",
      "approximate, and don't say you'll check and come back.",
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
  ].join("\n");
};
