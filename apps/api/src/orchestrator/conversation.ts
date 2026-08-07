import type { Message } from "@ansa/llm";

export interface Conversation {
  readonly messages: readonly Message[];
  addCaller(text: string): void;
  /**
   * Records what the caller actually heard of agent turn `seq`.
   *
   * Called repeatedly as playback progresses, and again on interruption — each call
   * replaces the previous record for the same turn rather than appending. Passing an
   * empty string removes the turn entirely: it was cut off before a word reached the
   * caller, so as far as the conversation is concerned it never happened.
   *
   * This is what barge-in cannot be bolted on later without. If speech the caller never
   * heard stays in the history, the agent refers back to it — "as I mentioned, your
   * renewal is in May" — and the caller has no idea what it means. The inverse is just
   * as bad and is what happened on a live call: speech they *did* hear being dropped, so
   * the agent repeated itself.
   *
   * Keyed on `seq` because two agent turns can follow each other with no caller turn
   * between them (a greeting, then a recovery line), and they must not overwrite.
   */
  recordAgentTurn(seq: number, text: string): void;
}

export const createConversation = (): Conversation => {
  const messages: Message[] = [];
  let lastAgentSeq: number | null = null;

  return {
    get messages(): readonly Message[] {
      return messages;
    },

    addCaller(text: string): void {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      messages.push({ role: "user", content: trimmed });
      lastAgentSeq = null;
    },

    recordAgentTurn(seq: number, text: string): void {
      const trimmed = text.trim();
      const last = messages[messages.length - 1];
      const isUpdate = lastAgentSeq === seq && last !== undefined && last.role === "assistant";

      if (isUpdate) {
        if (trimmed.length === 0) {
          messages.pop();
          lastAgentSeq = null;
          return;
        }
        messages[messages.length - 1] = { role: "assistant", content: trimmed };
        return;
      }

      if (trimmed.length === 0) return;
      messages.push({ role: "assistant", content: trimmed });
      lastAgentSeq = seq;
    },
  };
};
