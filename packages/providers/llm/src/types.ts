export type Role = "user" | "assistant";

export interface Message {
  readonly role: Role;
  readonly content: string;
}

/**
 * A tool the model may ask for, as the model is shown it.
 *
 * Deliberately structurally identical to the `name` / `description` / `parameters` fields
 * of `@ansa/tools`' `ToolDefinition`, so a registry listing can be handed straight to
 * `complete()` with no mapping layer — and without a provider package importing
 * `@ansa/tools`, which would point the dependency the wrong way.
 *
 * `parameters` is JSON Schema and is opaque here: passed through to the vendor, never
 * interpreted. The registry validates it at registration and the adapter validates what it
 * actually needs; a third check in a provider would be a third source of truth.
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** The model asking for one tool, with the arguments it chose. */
export interface ToolInvocation {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface CompletionRequest {
  /** Resolved system prompt. Logged with the call so a turn can be explained later (R8). */
  readonly system: string;
  readonly messages: readonly Message[];
  /**
   * Voice turns are two sentences (R6.3). A low ceiling is a cheap second line of
   * defence behind the prompt, which the model will otherwise drift past.
   */
  readonly maxTokens?: number;
  /**
   * What the model may ask for. Absent or empty means it may only speak, which is how
   * every call behaved before tools existed.
   *
   * Offering a tool is not permission to run it: the risk tier is enforced in the
   * dispatch path, and a tool listed here can still be refused, confirmed or transferred
   * (R5.3). The list exists so the model can ask, not so it can act.
   */
  readonly tools?: readonly ToolSpec[];
}

export interface CompletionStream {
  /** Fires per token group. The orchestrator forwards these to TTS as they arrive. */
  onDelta(listener: (text: string) => void): void;
  onDone(listener: (full: string) => void): void;
  /**
   * The model asked for tools instead of speaking.
   *
   * Mutually exclusive with `onDone` for a turn: a turn either answers or calls, and
   * firing both would put an empty assistant turn into the conversation beside the tool
   * result. All the calls of one turn arrive together, once, so independent lookups can
   * be run concurrently (R5.4.4).
   */
  onToolCall(listener: (calls: readonly ToolInvocation[]) => void): void;
  onError(listener: (error: Error) => void): void;
  /**
   * Barge-in, or a turn that resumed after an eager end-of-turn. Must stop delta
   * delivery immediately: text produced after the caller interrupted describes a reply
   * they never heard, and must not enter the conversation history (R4.1.8, R6.1).
   */
  cancel(): void;
}

export interface LlmProvider {
  readonly name: string;
  /** Must stream. A voice turn cannot wait for a complete response. */
  complete(request: CompletionRequest): CompletionStream;
}
