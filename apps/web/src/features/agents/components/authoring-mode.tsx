import type { CapturedField } from "../agents.schema";

/**
 * How somebody builds an agent, and the one thing that choice decides afterwards.
 *
 * An agent is configured across ten tabs and the authoring mode owns exactly one of them.
 * A form-authored agent edits its questions on Data captured; a flow-authored one draws
 * them on the canvas and reads them there. Everything else — name, persona, instructions,
 * keyterms, greeting, barge-in, answering-machine detection, voice, speaking rate,
 * policies, knowledge, tools, number, hours, transfer target, versions — is the same
 * screen and the same edit in either mode. Locking more than one tab would strand
 * settings with nowhere to change them, which is the mistake this note exists to prevent.
 *
 * The choice is the first screen of creating an agent — two builders, and nothing else on
 * the page — and each builder is complete on its own from there.
 */

export type AuthoringMode = "form" | "flow";

/**
 * The sentence that makes this a decision rather than a trap.
 *
 * Both directions are possible, but they are not the same size of change, and somebody
 * choosing here is entitled to know that before they choose rather than after. A form
 * widens into a graph without losing anything; a graph narrowed back to a list has to
 * drop whatever only existed because the call could branch.
 */
export const AUTHORING_ASYMMETRY =
  "A form can become a flow at any time. Turning a flow back into a form removes its branches, so it asks first.";

/**
 * A question a flow-authored agent asks, as the Data captured tab reads it.
 *
 * The same value as a `CapturedField` plus the one thing a list cannot express: a graph can
 * put a question on a branch, so "when is this asked" stops being "always" for everybody.
 * That is the column the graph earns on that screen.
 */
export interface FlowQuestion {
  /** The value's name, as tools receive it. */
  readonly key: string;
  /** How the agent asks, in the agent's own words. */
  readonly prompt: string;
  readonly type: CapturedField["type"];
  readonly confirm: CapturedField["confirm"];
  /**
   * The branch this question sits on, phrased to complete "asked …" — "when looking to
   * rent". Null when every call reaches it.
   */
  readonly asked: string | null;
}
