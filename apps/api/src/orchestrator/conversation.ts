import type { Message } from "@ansa/llm";

export interface Conversation {
  readonly messages: readonly Message[];
  addCaller(text: string): void;
  addAgent(text: string): void;
  /**
   * Barge-in. Keeps only the part of the last agent turn the caller actually heard.
   *
   * This is the whole reason barge-in cannot be bolted on later. If the unheard
   * remainder stays in the history, the agent will refer back to things it never
   * successfully said — "as I mentioned, your renewal is in May" — and the caller has
   * no idea what it means.
   */
  truncateLastAgent(heardChars: number): void;
}

export const createConversation = (): Conversation => {
  const messages: Message[] = [];

  return {
    get messages(): readonly Message[] {
      return messages;
    },

    addCaller(text: string): void {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      messages.push({ role: "user", content: trimmed });
    },

    addAgent(text: string): void {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      messages.push({ role: "assistant", content: trimmed });
    },

    truncateLastAgent(heardChars: number): void {
      const last = messages[messages.length - 1];
      if (last === undefined || last.role !== "assistant") return;

      const heard = last.content.slice(0, Math.max(0, heardChars)).trim();
      if (heard.length === 0) {
        // Interrupted before anything was heard: the turn never happened.
        messages.pop();
        return;
      }
      messages[messages.length - 1] = { role: "assistant", content: heard };
    },
  };
};
