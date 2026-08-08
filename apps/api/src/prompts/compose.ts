import { BASE_CONDUCT, identityLine } from "./base";
import { GUARANTEES_LAYER } from "./guarantees";
import { LOCALE_LAYER } from "./locale";
import { fenceTenantText, type TenantLayer } from "./tenant-layer";
import { taskLayer, type AvailableTool } from "./task-layer";

/**
 * The composition. Five layers, per `docs/MULTI_TENANT_ARCHITECTURE.md` §3:
 *
 *   base       us       rarely           short turns, never invent a number
 *   locale     us       rarely           Nigerian English, naira, WAT, Pidgin
 *   tenant     tenant   per config ver.  persona and rules, bounded and fenced
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
 * locale. A tenant supplies a `TenantLayer`, which is a branded value only
 * `compileTenantLayer` can mint, and it lands in one position: after ours, before the
 * guarantees. There is no argument that could replace the base, no "custom prompt" branch
 * to fall into, and no code path that reaches TTS-bound reasoning without the guarantee
 * block after it. That is what "the tenant layer never replaces the base" means when it
 * is structural rather than a rule in a document.
 */
export interface CallPrompt {
  /** Null for an unregistered number, or when config could not be read. */
  readonly tenant: TenantLayer | null;
  /** Registered for this call. Empty today; the registry is R5.2.0. */
  readonly tools: readonly AvailableTool[];
}

export const composeSystemPrompt = (input: CallPrompt): string =>
  [
    identityLine(input.tenant?.name ?? null),
    BASE_CONDUCT,
    LOCALE_LAYER,
    // Only when they actually wrote something. An empty fence would tell the model an
    // organisation had rules and then show it none, which reads as an instruction to
    // invent them.
    ...(input.tenant !== null && input.tenant.text !== ""
      ? [fenceTenantText(input.tenant)]
      : []),
    taskLayer(input.tools),
    GUARANTEES_LAYER,
  ].join("\n\n");

/**
 * What an unregistered number gets. A call that resolves a tenant uses
 * `CallTenant.systemPrompt` instead, which is these layers with theirs in the middle.
 *
 * Computed once at module load rather than per call: it has no inputs, and the composed
 * string is a couple of hundred tokens the LLM adapter sends on every turn.
 *
 * To change the wording:
 *   phone-call conduct        -> prompts/base.ts
 *   Nigerian English, numbers -> prompts/locale.ts
 *   what a tenant may say     -> prompts/tenant-layer.ts
 *   tools and capabilities    -> prompts/task-layer.ts
 *   the non-negotiables       -> prompts/guarantees.ts  (and read the comment first)
 */
export const DEFAULT_SYSTEM_PROMPT = composeSystemPrompt({ tenant: null, tools: [] });
