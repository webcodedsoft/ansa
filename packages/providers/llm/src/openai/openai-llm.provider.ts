import type { CompletionRequest, CompletionStream, LlmProvider } from "../types";

export interface OpenAiLlmOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /** Injected in tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.openai.com";
// Chosen for latency rather than capability: on a phone call the first token has to
// arrive inside a budget the caller can feel. Revisit against quality at Gate A.
const DEFAULT_MODEL = "gpt-4o-mini";

/**
 * A hung connection never rejects on its own, so without a deadline the orchestrator
 * waits forever and the caller hears silence — the one outcome CLAUDE.md rules out.
 * Generous enough that a slow-but-alive model still answers.
 */
const REQUEST_TIMEOUT_MS = 8_000;

interface Emitters {
  readonly delta: ((text: string) => void)[];
  readonly done: ((full: string) => void)[];
  readonly error: ((error: Error) => void)[];
}

/**
 * Pulls text out of one server-sent-event line. Returns null for anything that is not
 * a content delta — keepalives, role announcements, the terminating [DONE].
 */
export const parseSseLine = (line: string): string | null => {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (payload.length === 0 || payload === "[DONE]") return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null) return null;

  const choices = (decoded as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const delta = (choices[0] as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null) return null;

  const content = (delta as { content?: unknown }).content;
  return typeof content === "string" && content.length > 0 ? content : null;
};

export const createOpenAiLlm = (options: OpenAiLlmOptions): LlmProvider => {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_MODEL;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: "openai",

    complete(request: CompletionRequest): CompletionStream {
      const listeners: Emitters = { delta: [], done: [], error: [] };
      const controller = new AbortController();
      let settled = false;
      let cancelled = false;

      const stream: CompletionStream = {
        onDelta: (l) => listeners.delta.push(l),
        onDone: (l) => listeners.done.push(l),
        onError: (l) => listeners.error.push(l),
        cancel: () => {
          if (settled) return;
          cancelled = true;
          settled = true;
          // Stops the vendor generating tokens nobody will hear, and stops us paying
          // for them.
          controller.abort();
        },
      };

      const run = async (): Promise<void> => {
        try {
          const response = await doFetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            // Cancellation and deadline are distinct: `cancelled` distinguishes a
            // barge-in from a timeout below, so a timeout still reaches onError.
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              stream: true,
              max_tokens: request.maxTokens ?? 120,
              messages: [
                { role: "system", content: request.system },
                ...request.messages.map((m) => ({ role: m.role, content: m.content })),
              ],
            }),
          });

          if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error(
              `OpenAI returned ${response.status}${detail.length > 0 ? `: ${detail.slice(0, 200)}` : ""}`,
            );
          }
          if (response.body === null) throw new Error("OpenAI returned no response body");

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let full = "";

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (cancelled) {
              await reader.cancel().catch(() => undefined);
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            // SSE frames are newline-delimited; a chunk can split one mid-line, so the
            // trailing partial stays in the buffer until the rest arrives.
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const text = parseSseLine(line);
              if (text === null) continue;
              full += text;
              if (!cancelled) for (const l of listeners.delta) l(text);
            }
          }

          if (cancelled) return;
          settled = true;
          for (const l of listeners.done) l(full);
        } catch (error: unknown) {
          // An abort is a barge-in, not a fault.
          if (cancelled) return;
          settled = true;
          const e = error instanceof Error ? error : new Error(String(error));
          for (const l of listeners.error) l(e);
        }
      };

      // Deferred so listeners registered synchronously after this returns are attached
      // before anything is emitted. Without it an early failure reaches nobody and the
      // turn goes silent with no error anywhere.
      queueMicrotask(() => {
        void run();
      });

      return stream;
    },
  };
};
