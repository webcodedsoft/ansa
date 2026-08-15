import type { ToolArgs } from "./types";

/**
 * R5.2.1 and R5.2.4: every invocation is logged with its arguments, and credentials are
 * never in logs. Both are true at once only if redaction happens on the way to the log
 * line rather than being left to whoever calls the logger.
 *
 * Key-name matching, not value sniffing. A value-based heuristic passes anything it has
 * not seen before, and the first thing it will not have seen is the organization's own scheme.
 */
const SECRET_KEY =
  /(token|secret|password|passwd|passphrase|auth|api[-_]?key|apikey|private[-_]?key|credential|bearer|cookie|session[-_]?id|signature|pin|otp|cvv|ssn)/i;

const MAX_STRING = 200;

const redactValue = (key: string, value: unknown, depth: number): unknown => {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (depth >= 4) return "[deep]";

  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[${value.length}]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(k, v, depth + 1)]),
    );
  }
  return value;
};

export const redactArgs = (args: ToolArgs): Record<string, unknown> =>
  Object.fromEntries(Object.entries(args).map(([k, v]) => [k, redactValue(k, v, 0)]));

// ---------------------------------------------------------------------------
// Payloads leaving the process (Slice 6a)
// ---------------------------------------------------------------------------

/**
 * A whole payload, on its way to somebody else's server.
 *
 * **One rule, and it is about secret material only.** The key-name rule above runs
 * unconditionally. An `authorization` value or a vault reference is not caller PII and it
 * is not the organisation's data to receive either — it is material we hold in trust, and
 * it appearing in an outbound body is a defect and not a setting (R5.2.1).
 *
 * **No caller value is ever masked.** This used to take a per-organisation policy and run
 * free text through a matcher; R5.2.4 was withdrawn on 2026-08-15 and the engine deleted.
 * The organisation is the data controller, the caller is their customer, and the payload is
 * a record of a conversation their own agent had. Deciding on their behalf which of their
 * own data they may receive was never ours to do, and it broke the obvious uses — a CRM
 * that needs the policy number cannot work with a masked one.
 *
 * No truncation, unlike `redactArgs`: this is a record of a conversation, and a transcript
 * cut off at two hundred characters is a broken payload rather than a tidy log line.
 */
export const redactPayload = (value: unknown): unknown => {
  const walk = (key: string, node: unknown, depth: number): unknown => {
    if (SECRET_KEY.test(key)) return "[redacted]";
    if (depth >= 12) return "[deep]";
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map((entry) => walk(key, entry, depth + 1));
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, walk(k, v, depth + 1)]),
      );
    }
    return node;
  };

  return walk("", value, 0);
};
