import { BASE_CONDUCT, identityLine } from "./base";
import { CONVERSATION_LAYER } from "./conversation";
import { EMOTIONAL_LAYER } from "./emotional";
import { renderPolicyBlocks, toPolicyBlocks } from "./policy-blocks";
import { GUARANTEES_LAYER } from "./guarantees";
import { LOCALE_LAYER } from "./locale";
import { SAFEGUARDING_LAYER } from "./safeguarding";
import { SITUATIONS_LAYER } from "./situations";
import { VARIATION_LAYER } from "./variation";
import { fenceOrganizationText, type OrganizationLayer } from "./organization-layer";
import { taskLayer, type AvailableTool } from "./task-layer";
import type { CollectedField } from "../tenancy/captured-fields";

/**
 * The composition. Five layers, per `docs/MULTI_TENANT_ARCHITECTURE.md` §3:
 *
 *   base       us       rarely           short turns, never invent a number
 *   locale     us       rarely           Nigerian English, naira, WAT, Pidgin
 *   organization     organization   per config ver.  persona and rules, bounded and fenced
 *   task       derived  per call         which tools are registered
 *   turn       derived  per turn         the budget instruction
 *
 * The turn layer is not here, and that is the point: it already exists in
 * `orchestrator/turn-budget.ts`, is computed per turn, and is appended to whatever this
 * function returns. It proved the layering works before the layering was written, and
 * duplicating it here would give the same instruction two homes.
 *
 * ---
 *
 * **Read the signature.** There is no parameter for the base and no parameter for the
 * locale. A organization supplies a `OrganizationLayer`, which is a branded value only
 * `compileOrganizationLayer` can mint, and it lands in one position: after ours, before the
 * guarantees. There is no argument that could replace the base, no "custom prompt" branch
 * to fall into, and no code path that reaches TTS-bound reasoning without the guarantee
 * block after it. That is what "the organization layer never replaces the base" means when it
 * is structural rather than a rule in a document.
 */
export interface CallPrompt {
  /** Null for an unregistered number, or when config could not be read. */
  readonly organization: OrganizationLayer | null;
  /** Registered for this call. Empty today; the registry is R5.2.0. */
  readonly tools: readonly AvailableTool[];
  /**
   * The voice form this agent conducts, in the order it asks (migration 0021).
   *
   * In the task layer beside the tools rather than in the organization's, because it is the same
   * kind of thing: derived per call from what the operator configured, not free text they
   * typed at the model.
   */
  readonly fields?: readonly CollectedField[];
  /**
   * The organisation's rules as named blocks, straight off the config row.
   *
   * `unknown` because it is jsonb and this is the call path: rows written by an older
   * schema or by a script reach here too, so it is checked rather than trusted.
   */
  readonly policyBlocks?: unknown;
}

export const composeSystemPrompt = (input: CallPrompt): string =>
  [
    identityLine(input.organization?.name ?? null),
    BASE_CONDUCT,
    /* Straight after the conduct it qualifies: those rules say what a good sentence is,
       and this says not to produce the same good sentence twice. */
    VARIATION_LAYER,
    LOCALE_LAYER,
    /* How a call moves, before anything organisation-specific. Interruptions, silence and
       loops happen the same way whoever is being answered for. */
    CONVERSATION_LAYER,
    // Only when they actually wrote something. An empty fence would tell the model an
    // organisation had rules and then show it none, which reads as an instruction to
    // invent them.
    ...(input.organization !== null && input.organization.text !== ""
      ? [fenceOrganizationText(input.organization)]
      : []),
    /* After their prose and before the task layer. Their own words first, because a block
       is the structured half of the same thing and reads as a refinement of it; the tools
       after, because what may be done is downstream of what is allowed. */
    ...(() => {
      const rendered = renderPolicyBlocks(toPolicyBlocks(input.policyBlocks));
      return rendered === "" ? [] : [rendered];
    })(),
    taskLayer(input.tools, input.fields ?? []),
    /* Before the guarantees, which must land last, and after the task layer, because how
       to sound is a smaller instruction than what may be done. */
    EMOTIONAL_LAYER,
    /* After the emotional read, because both are about the person rather than the task,
       and this is what to do once that read says something is wrong. */
    SAFEGUARDING_LAYER,
    SITUATIONS_LAYER,
    GUARANTEES_LAYER,
  ].join("\n\n");

/**
 * What an unregistered number gets. A call that resolves a organization uses
 * `CallAgent.systemPrompt` instead, which is these layers with theirs in the middle.
 *
 * Computed once at module load rather than per call: it has no inputs, and the composed
 * string is a couple of hundred tokens the LLM adapter sends on every turn.
 *
 * To change the wording:
 *   phone-call conduct        -> prompts/base.ts
 *   not sounding like a loop  -> prompts/variation.ts
 *   openings, silence, loops  -> prompts/conversation.ts
 *   distress, abuse, crisis   -> prompts/safeguarding.ts
 *   verification, edge cases  -> prompts/situations.ts
 *   Nigerian English, numbers -> prompts/locale.ts
 *   what a organization may say     -> prompts/organization-layer.ts
 *   tools and capabilities    -> prompts/task-layer.ts
 *   the non-negotiables       -> prompts/guarantees.ts  (and read the comment first)
 */
export const DEFAULT_SYSTEM_PROMPT = composeSystemPrompt({ organization: null, tools: [] });
