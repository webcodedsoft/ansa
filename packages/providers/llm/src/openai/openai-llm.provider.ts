import type {
  CompletionRequest,
  CompletionStream,
  LlmProvider,
  ToolInvocation,
} from "../types";

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
  readonly toolCall: ((calls: readonly ToolInvocation[]) => void)[];
  readonly error: ((error: Error) => void)[];
}

/**
 * Reassembles the streamed fragments into calls the dispatcher can run.
 *
 * A call whose arguments do not parse is dropped rather than run with `{}`: a tool invoked
 * with arguments the model did not choose is worse than a tool not invoked, and the caller
 * still gets speech either way — an empty result here reaches `onError`, which the
 * orchestrator turns into a recovery line rather than silence.
 */
const assemble = (
  fragments: ReadonlyMap<number, { name: string | null; args: string }>,
): { readonly calls: ToolInvocation[]; readonly malformed: string[] } => {
  const calls: ToolInvocation[] = [];
  const malformed: string[] = [];

  for (const { name, args } of fragments.values()) {
    if (name === null) continue;
    const text = args.trim();
    let parsed: unknown;
    try {
      // A tool with no parameters streams no arguments at all, which is not malformed.
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {
      malformed.push(name);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      malformed.push(name);
      continue;
    }
    calls.push({ name, args: parsed as Record<string, unknown> });
  }
  return { calls, malformed };
};

/**
 * One tool call, as it arrives: in pieces.
 *
 * The vendor streams a call the same way it streams text — the name once, then the
 * arguments a few characters at a time across many frames — and `index` is the only thing
 * tying the pieces together when the model asks for two tools at once.
 */
export interface ToolCallFragment {
  readonly index: number;
  /** Present on the first fragment of a call and absent on the rest. */
  readonly name: string | null;
  readonly argsFragment: string;
}

/** Everything one SSE frame carries that the orchestrator could act on. */
export interface SseDelta {
  readonly content: string | null;
  readonly toolCalls: readonly ToolCallFragment[];
}

const NOTHING: SseDelta = { content: null, toolCalls: [] };

const fragmentsFrom = (delta: Record<string, unknown>): readonly ToolCallFragment[] => {
  const raw = delta["tool_calls"];
  if (!Array.isArray(raw)) return [];

  const fragments: ToolCallFragment[] = [];
  for (const [position, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null) continue;
    const call = entry as { index?: unknown; function?: unknown };
    const fn = typeof call.function === "object" && call.function !== null ? call.function : {};
    const { name, arguments: args } = fn as { name?: unknown; arguments?: unknown };
    fragments.push({
      // Falling back to the array position rather than dropping the fragment: an index
      // the vendor omitted is still a call the model asked for.
      index: typeof call.index === "number" ? call.index : position,
      name: typeof name === "string" && name.length > 0 ? name : null,
      argsFragment: typeof args === "string" ? args : "",
    });
  }
  return fragments;
};

/**
 * Decodes one server-sent-event frame. Returns null for anything that carries neither —
 * keepalives, role announcements, the terminating [DONE].
 */
export const parseSseDelta = (line: string): SseDelta | null => {
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
  const fragments = fragmentsFrom(delta as Record<string, unknown>);
  if (typeof content !== "string" || content.length === 0) {
    return fragments.length === 0 ? NOTHING : { content: null, toolCalls: fragments };
  }
  return { content, toolCalls: fragments };
};

/**
 * Pulls text out of one server-sent-event line. Returns null for anything that is not
 * a content delta.
 */
export const parseSseLine = (line: string): string | null => parseSseDelta(line)?.content ?? null;

export const createOpenAiLlm = (options: OpenAiLlmOptions): LlmProvider => {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_MODEL;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: "openai",

    complete(request: CompletionRequest): CompletionStream {
      const listeners: Emitters = { delta: [], done: [], toolCall: [], error: [] };
      const controller = new AbortController();
      let settled = false;
      let cancelled = false;

      const stream: CompletionStream = {
        onDelta: (l) => listeners.delta.push(l),
        onDone: (l) => listeners.done.push(l),
        onToolCall: (l) => listeners.toolCall.push(l),
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
              // Offered, never assumed. An empty list is omitted rather than sent: some
              // deployments reject `tools: []`, and a call with no tools registered must
              // behave exactly as it did before tools existed.
              ...(request.tools === undefined || request.tools.length === 0
                ? {}
                : {
                    tools: request.tools.map((tool) => ({
                      type: "function",
                      function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters,
                      },
                    })),
                  }),
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
          /** Keyed by the vendor's own call index, which is what pairs the fragments. */
          const pendingCalls = new Map<number, { name: string | null; args: string }>();

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
              const frame = parseSseDelta(line);
              if (frame === null) continue;

              for (const fragment of frame.toolCalls) {
                const held = pendingCalls.get(fragment.index) ?? { name: null, args: "" };
                pendingCalls.set(fragment.index, {
                  name: fragment.name ?? held.name,
                  args: held.args + fragment.argsFragment,
                });
              }

              const text = frame.content;
              if (text === null) continue;
              full += text;
              if (!cancelled) for (const l of listeners.delta) l(text);
            }
          }

          if (cancelled) return;
          settled = true;

          // A turn either answers or calls. Firing both would put an empty assistant turn
          // into the conversation beside the tool result.
          if (pendingCalls.size > 0) {
            const { calls, malformed } = assemble(pendingCalls);
            if (calls.length > 0) {
              for (const l of listeners.toolCall) l(calls);
              return;
            }
            const e = new Error(
              `OpenAI asked for ${malformed.length > 0 ? malformed.join(", ") : "a tool"} with arguments that were not usable JSON`,
            );
            for (const l of listeners.error) l(e);
            return;
          }

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
