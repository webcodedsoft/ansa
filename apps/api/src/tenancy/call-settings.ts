import type { BusinessHours, HandoffDestination, TenantId } from "@ansa/shared";
import type { PreparedConnectors, PreparedEvents } from "@ansa/tools";

import { UNKNOWN_TENANT, type CallTenant } from "./tenant-registry";

/**
 * Everything about one call that comes from *which organisation was dialled*, in one place.
 *
 * This function exists because the gateway had six of these decisions inline and got two of
 * them wrong for two months. `voice_id` and `greeting` were stored on the tenant row,
 * versioned in `tenant_prompt_versions`, printed by the onboarding tool, and read into
 * `CallTenant` — and then the media gateway passed `config.elevenLabsVoiceId` and the
 * hardcoded `GREETING_TEXT` to every call regardless. A second tenant could publish a voice
 * and a greeting, watch the version number go up, and hear the first tenant's.
 *
 * Nothing was leaking across an RLS boundary: the row was read correctly and then dropped
 * on the floor. That is the shape of every defect this file is meant to catch, so the rule
 * is now structural rather than remembered — **if a call-time value depends on the tenant,
 * it is a field here.** A test can then pin all of them at once, which
 * `isolation.test.ts` does, and adding a seventh cannot quietly skip the call site.
 *
 * The platform values are a *fallback*, not a default. An unregistered number genuinely has
 * no organisation and gets them. A registered tenant who has not configured a voice also
 * gets them, and that is a decision worth seeing plainly rather than one buried in `??`.
 */
export interface CallSettings {
  /** Null for an unregistered number, which disables tools and per-tenant state. */
  readonly tenantId: TenantId | null;
  readonly name: string;
  /** Base vocabulary merged with theirs, capped and de-duplicated (R4.1.3). */
  readonly keyterms: readonly string[];
  /** Which voice speaks. Theirs if they configured one. */
  readonly voiceId: string;
  /** The first thing the caller hears. Theirs if they configured one. */
  readonly greeting: string;
  /** The five-layer prompt with their layer in it, composed at config load. */
  readonly systemPrompt: string;
  /** When their line is staffed, WAT. Null means the agent says it does not know. */
  readonly businessHours: BusinessHours | null;
  /** Where an escalation is transferred. Null means it says so rather than dialling. */
  readonly handoff: HandoffDestination | null;
  /** Their own tools, prepared at config load, registered per call beside the platform's. */
  readonly connectors: PreparedConnectors;
  /** Their own event receivers and redaction policy. */
  readonly events: PreparedEvents;
  /** Recorded on every call, so a call from weeks ago can be explained (R7.5). */
  readonly configVersion: number;
}

/**
 * What the platform supplies when an organisation has not.
 *
 * `handoff` is here rather than read from the environment inside this function because the
 * environment is not this module's business, and because a test that could not vary it
 * would be proving less than it looked.
 */
export interface PlatformDefaults {
  readonly voiceId: string;
  readonly greeting: string;
  readonly handoff: HandoffDestination | null;
}

/**
 * A tenant's configuration, plus the platform's, as one call's settings.
 *
 * `tenant` is null when the media socket carried no tenant at all. It is deliberately the
 * same code path as `UNKNOWN_TENANT`: an unregistered number and an unresolvable one should
 * sound identical, because from the caller's side they are.
 *
 * Empty strings are treated as absent. A tenant who cleared their greeting in a config
 * editor should get the platform's, not silence where the greeting was.
 */
export const callSettings = (
  tenant: CallTenant | null,
  platform: PlatformDefaults,
): CallSettings => {
  const resolved = tenant ?? UNKNOWN_TENANT;
  const chosen = (value: string | null, fallback: string): string => {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? fallback : trimmed;
  };

  return {
    tenantId: resolved.tenantId,
    name: resolved.name,
    keyterms: resolved.keyterms,
    voiceId: chosen(resolved.voiceId, platform.voiceId),
    greeting: chosen(resolved.greeting, platform.greeting),
    systemPrompt: resolved.systemPrompt,
    businessHours: resolved.businessHours,
    handoff: resolved.handoff ?? platform.handoff,
    connectors: resolved.connectors,
    events: resolved.events,
    configVersion: resolved.configVersion,
  };
};
