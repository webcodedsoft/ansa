export type Role = "user" | "assistant";

export interface Message {
  readonly role: Role;
  readonly content: string;
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
}

export interface CompletionStream {
  /** Fires per token group. The orchestrator forwards these to TTS as they arrive. */
  onDelta(listener: (text: string) => void): void;
  onDone(listener: (full: string) => void): void;
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
