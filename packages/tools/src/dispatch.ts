import type { CallId, Logger, TenantId } from "@ansa/shared";

import { createConfirmationStore, fingerprintArgs } from "./confirmation";
import { CONFIRMATION_TTL_MS, HARD_TIMEOUT_MS, SOFT_TIMEOUT_MS } from "./limits";
import { redactArgs } from "./redact";
import type { Registration, ToolRegistry } from "./registry";
import type { DispatchOutcome, FailureReason, RiskTier, ToolCall } from "./types";

/** Where the tool is in its life, for whoever is covering the gap with sound. */
export interface HoldContext {
  readonly tenantId: TenantId;
  readonly callId: CallId;
  readonly name: string;
  readonly tier: RiskTier;
}

/**
 * R5.4.2. Holding speech begins the moment a tool is dispatched, not when it returns.
 *
 * This is the whole reason the hook exists rather than the orchestrator simply awaiting
 * `dispatch()` and speaking afterwards: by the time the promise settles the gap has
 * already happened. `start` is called before the adapter is invoked, synchronously, and
 * only for tools that are actually going to run — a tool that is refused on its tier
 * never dispatched, so it must never produce "let me check that" either.
 */
export interface HoldingSpeech {
  start(context: HoldContext): void;
  /** Past the soft ceiling and still running. A second register, not the same phrase. */
  slow?(context: HoldContext): void;
  stop(context: HoldContext): void;
}

export interface DispatcherOptions {
  readonly registry: ToolRegistry;
  readonly log: Logger;
  readonly holding?: HoldingSpeech;
  readonly now?: () => number;
  readonly softTimeoutMs?: number;
  readonly hardTimeoutMs?: number;
  readonly confirmationTtlMs?: number;
}

export interface ToolDispatcher {
  dispatch(call: ToolCall): Promise<DispatchOutcome>;
}

const FAILURE_SPEECH: Readonly<Record<FailureReason, string>> = {
  "unknown-tool": "Sorry, that's not something I can do on this line.",
  // R5.4.1: on a hard timeout the agent says so and offers an alternative. It does not
  // pretend the call is still in flight and it does not go quiet.
  timeout: "Sorry, that's taking longer than it should. Let me take your details and follow up.",
  "adapter-error": "Sorry, I couldn't get that just now.",
  "stale-confirmation": "Sorry, let me go over that once more before I change anything.",
  "confirmation-mismatch": "Sorry, let me go over that once more before I change anything.",
};

const TRANSFER_SPEECH =
  "That's not something I can do myself. Let me put you through to a colleague who can.";

type Settled =
  | { readonly state: "value"; readonly value: unknown }
  | { readonly state: "error"; readonly error: unknown }
  | { readonly state: "timeout" };

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The last gate before TTS. `summarise` is a tenant-supplied function and the failure
 * this catches — returning the raw object, which stringifies to JSON — is the exact thing
 * R5.4.3 forbids, so it is checked rather than trusted.
 */
const usableSummary = (summary: unknown): string | null => {
  if (typeof summary !== "string") return null;
  const trimmed = summary.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return null;
  return trimmed;
};

/**
 * What goes into the model's context after a tool call.
 *
 * Separate from `speech` on purpose. The caller hears an apology; the model has to be
 * told, in words it cannot round off, that nothing happened — otherwise the next turn
 * reports a success it never got.
 */
export const modelMessage = (outcome: DispatchOutcome): string => {
  switch (outcome.kind) {
    case "ok":
      return `${outcome.name} returned: ${outcome.speech}`;
    case "confirm":
      return `${outcome.name} has NOT run. The caller has been read the details and must say yes first. Do not describe it as done.`;
    case "transfer":
      return `${outcome.name} has NOT run and will not run — it needs a human (${outcome.reason}). Hand over. Do not tell the caller it is done.`;
    case "failed":
      return `${outcome.name} FAILED (${outcome.reason}) and had no effect. Do not tell the caller it worked.`;
  }
};

export const createToolDispatcher = (options: DispatcherOptions): ToolDispatcher => {
  const { registry, log, holding } = options;
  const now = options.now ?? Date.now;
  const softMs = options.softTimeoutMs ?? SOFT_TIMEOUT_MS;
  const hardMs = options.hardTimeoutMs ?? HARD_TIMEOUT_MS;
  const confirmations = createConfirmationStore(options.confirmationTtlMs ?? CONFIRMATION_TTL_MS);

  /**
   * Runs the adapter under both ceilings. The only place in the codebase that calls
   * `adapter.execute` — a second call site here would be the second dispatch path
   * R5.2.0 exists to prevent.
   */
  const run = async (registration: Registration, call: ToolCall, context: HoldContext): Promise<Settled> => {
    const controller = new AbortController();
    let softTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;

    // Before the await, before execute. This ordering is the requirement.
    holding?.start(context);

    try {
      const work = registration.adapter.execute({
        tenantId: call.tenantId,
        callId: call.callId,
        name: call.name,
        args: call.args,
        signal: controller.signal,
      });

      return await Promise.race<Settled>([
        work.then(
          (value) => ({ state: "value" as const, value }),
          (error: unknown) => ({ state: "error" as const, error }),
        ),
        new Promise<Settled>((resolve) => {
          softTimer = setTimeout(() => holding?.slow?.(context), Math.min(softMs, hardMs));
          hardTimer = setTimeout(() => {
            controller.abort();
            resolve({ state: "timeout" });
          }, hardMs);
        }),
      ]);
    } catch (error) {
      // execute() threw synchronously rather than rejecting. Same outcome either way.
      return { state: "error", error };
    } finally {
      if (softTimer !== null) clearTimeout(softTimer);
      if (hardTimer !== null) clearTimeout(hardTimer);
      holding?.stop(context);
    }
  };

  return {
    async dispatch(call) {
      const started = now();
      const scoped = log.child({ tenantId: call.tenantId, callId: call.callId, tool: call.name });
      const args = redactArgs(call.args);

      const fail = (reason: FailureReason, tier: RiskTier | null, detail?: string): DispatchOutcome => {
        const outcome: DispatchOutcome = {
          kind: "failed",
          name: call.name,
          tier,
          latencyMs: now() - started,
          speech: FAILURE_SPEECH[reason],
          reason,
        };
        scoped.warn("tool call failed", { tier, reason, detail, args, latencyMs: outcome.latencyMs });
        return outcome;
      };

      const registration = registry.resolve(call.tenantId, call.name);
      // A tool belonging to another tenant is reported exactly as one that does not
      // exist. Anything else tells a caller what another tenant has configured.
      if (registration === null) return fail("unknown-tool", null);

      const { definition } = registration;
      const tier = definition.riskTier;
      const context: HoldContext = {
        tenantId: call.tenantId,
        callId: call.callId,
        name: call.name,
        tier,
      };

      // First, and before confirmations are even looked at: no confirmation id, however
      // well formed, can talk an irreversible tool into running.
      if (tier === "irreversible") {
        const outcome: DispatchOutcome = {
          kind: "transfer",
          name: call.name,
          tier,
          latencyMs: now() - started,
          speech: TRANSFER_SPEECH,
          reason: definition.transferReason,
        };
        scoped.info("tool call transferred, not executed", {
          tier,
          reason: definition.transferReason,
          args,
        });
        return outcome;
      }

      if (tier === "write") {
        const subject = {
          tenantId: call.tenantId,
          callId: call.callId,
          name: call.name,
          fingerprint: fingerprintArgs(call.args),
        };

        if (call.confirmationId === undefined) {
          let readback: string;
          try {
            readback = definition.readback(call.args);
          } catch (error) {
            return fail("adapter-error", tier, `readback threw: ${describe(error)}`);
          }
          const spoken = usableSummary(readback);
          if (spoken === null) return fail("adapter-error", tier, "readback produced nothing sayable");

          const confirmationId = confirmations.issue(subject, now());
          scoped.info("tool call awaiting spoken confirmation", { tier, args, confirmationId });
          return {
            kind: "confirm",
            name: call.name,
            tier,
            latencyMs: now() - started,
            speech: spoken,
            confirmationId,
          };
        }

        const redeemed = confirmations.redeem(call.confirmationId, subject, now());
        if (redeemed === "stale") return fail("stale-confirmation", tier);
        if (redeemed === "mismatch") return fail("confirmation-mismatch", tier);
      }

      const settled = await run(registration, call, context);

      if (settled.state === "timeout") return fail("timeout", tier, `over ${hardMs}ms`);
      if (settled.state === "error") return fail("adapter-error", tier, describe(settled.error));

      let summary: unknown;
      try {
        summary = definition.summarise(settled.value);
      } catch (error) {
        return fail("adapter-error", tier, `summarise threw: ${describe(error)}`);
      }

      const spoken = usableSummary(summary);
      if (spoken === null) {
        return fail("adapter-error", tier, "summarise produced raw or empty output (R5.4.3)");
      }

      const latencyMs = now() - started;
      scoped.info("tool call ok", { tier, route: registration.adapter.route, args, summary: spoken, latencyMs });
      return { kind: "ok", name: call.name, tier, latencyMs, speech: spoken, route: registration.adapter.route };
    },
  };
};
