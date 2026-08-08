import type { CallId, TenantId } from "@ansa/shared";

/**
 * R5.3. The tier is a required field on every registered tool and the only thing the
 * dispatcher consults before deciding whether a tool may run at all.
 *
 * It is deliberately not a prompt instruction. A prompt can be talked out of things.
 */
export type RiskTier = "read" | "write" | "irreversible";

export type ToolArgs = Readonly<Record<string, unknown>>;

/**
 * What an adapter is handed. Note `tenantId` — every adapter receives it and is expected
 * to scope its lookup by it (CLAUDE.md rule 3). It is not decoration.
 */
export interface AdapterCall {
  readonly tenantId: TenantId;
  readonly callId: CallId;
  readonly name: string;
  readonly args: ToolArgs;
  /** Aborted on the hard ceiling. An adapter that ignores it leaks a connection. */
  readonly signal: AbortSignal;
}

/**
 * The one seam that new tool routes are allowed to widen.
 *
 * Internal tools, HTTP connectors and MCP servers are all adapters (R5.2.0). If adding a
 * route means touching the dispatcher rather than writing one of these, the abstraction
 * is wrong.
 */
export interface ToolAdapter {
  /** "internal", "http", "mcp". Logged so a slow route can be found; never branched on. */
  readonly route: string;
  execute(call: AdapterCall): Promise<unknown>;
}

interface DefinitionBase {
  /** Lower snake case. This is what the model asks for by name. */
  readonly name: string;
  readonly description: string;
  /**
   * JSON Schema for the arguments, as the model is shown them.
   *
   * Opaque here on purpose: this package does not validate against it, because a schema
   * check that the adapter then repeats is two sources of truth. The handler validates
   * what it actually needs and throws, which the dispatcher turns into speech.
   */
  readonly parameters: Readonly<Record<string, unknown>>;
  /**
   * Null or absent means a platform tool, available to every tenant. Set means the tool
   * belongs to that tenant and is invisible — not merely forbidden — to every other one.
   */
  readonly tenantId?: TenantId | null;
  /** Capped at HARD_TIMEOUT_MS at registration time. */
  readonly timeoutMs?: number;
}

/**
 * R5.4.3: raw JSON is never spoken, so a tool that can return data must say how its
 * result becomes a sentence. Required by the type, and again at runtime because a
 * tenant-configured tool arrives as data rather than as a literal.
 */
export type Summarise = (result: unknown) => string;

/**
 * The tier is not an optional annotation on a definition — it selects which shape the
 * definition has, so "write with no readback" and "tool with no tier" are compile errors
 * before they are registration errors.
 */
export type ToolDefinition =
  | (DefinitionBase & { readonly riskTier: "read"; readonly summarise: Summarise })
  | (DefinitionBase & {
      readonly riskTier: "write";
      readonly summarise: Summarise;
      /**
       * R4.3.1. What the caller hears before anything is written, in their own values.
       * There is no confidence threshold that skips this.
       */
      readonly readback: (args: ToolArgs) => string;
    })
  | (DefinitionBase & {
      readonly riskTier: "irreversible";
      /** Spoken to the human who picks up, not to the caller. */
      readonly transferReason: string;
    });

/** One request to run one tool, always on behalf of one tenant on one call. */
export interface ToolCall {
  readonly tenantId: TenantId;
  readonly callId: CallId;
  readonly name: string;
  readonly args: ToolArgs;
  /**
   * Issued by a previous `confirm` outcome and quoted back once the caller has said yes.
   * Absent on a write tool means the write has not been agreed to and will not fire.
   */
  readonly confirmationId?: string;
}

export type FailureReason =
  /** No such tool for this tenant. Another tenant's tool reports as this, on purpose. */
  | "unknown-tool"
  | "timeout"
  | "adapter-error"
  /** R5.2.3. This tool has failed repeatedly for this tenant and is being left alone. */
  | "circuit-open"
  /** The confirmation id is unknown, expired, or already spent. */
  | "stale-confirmation"
  /** The id is good but the arguments moved since the caller heard them. */
  | "confirmation-mismatch";

interface OutcomeBase {
  readonly name: string;
  /** Null only when the tool could not be resolved. */
  readonly tier: RiskTier | null;
  readonly latencyMs: number;
  /**
   * What the agent says. Always populated: every branch of the dispatcher produces
   * speech, because the failure mode this product cannot have is silence.
   */
  readonly speech: string;
}

export type DispatchOutcome =
  | (OutcomeBase & { readonly kind: "ok"; readonly route: string })
  | (OutcomeBase & { readonly kind: "confirm"; readonly confirmationId: string })
  | (OutcomeBase & { readonly kind: "transfer"; readonly reason: string })
  | (OutcomeBase & { readonly kind: "failed"; readonly reason: FailureReason });
