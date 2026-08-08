/**
 * The prompt moved. It is now five composed layers in `apps/api/src/prompts/`, per
 * `docs/MULTI_TENANT_ARCHITECTURE.md` §3 — base, locale, tenant, task, turn — because
 * "one string in a file" is exactly what makes a second tenant a code change.
 *
 * Nothing here changed shape: `SYSTEM_PROMPT` is still a constant string and still what
 * `orchestrator.ts` prepends to the per-turn budget instruction. It is now the
 * composition for a call with no tenant configured. A call that *does* resolve a tenant
 * should use `CallTenant.systemPrompt` instead, which is the same layers with theirs in
 * the middle — see `apps/api/src/prompts/WIRING.md` for the one line that connects it.
 *
 * To change the wording:
 *   phone-call conduct        -> prompts/base.ts
 *   Nigerian English, numbers -> prompts/locale.ts
 *   what a tenant may say     -> prompts/tenant-layer.ts
 *   tools and capabilities    -> prompts/task-layer.ts
 *   the non-negotiables       -> prompts/guarantees.ts  (and read the comment first)
 */
export { DEFAULT_SYSTEM_PROMPT as SYSTEM_PROMPT } from "../prompts/compose";
