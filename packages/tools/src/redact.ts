import { NO_REDACTION, redactText, type RedactionContext, type RedactionPolicy } from "./redaction";
import type { ToolArgs } from "./types";

/**
 * R5.2.1 and R5.2.4: every invocation is logged with its arguments, and credentials are
 * never in logs. Both are true at once only if redaction happens on the way to the log
 * line rather than being left to whoever calls the logger.
 *
 * Key-name matching, not value sniffing. A value-based heuristic passes anything it has
 * not seen before, and the first thing it will not have seen is the tenant's own scheme.
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
 * Two rules, and the difference between them is the whole design.
 *
 * **Secret material never leaves, whatever anybody configured.** The key-name rule above
 * runs unconditionally here. An `authorization` value or a vault reference is not caller
 * PII and it is not the organisation's data to receive either — it is material we hold in
 * trust, and it appearing in an outbound body is a defect and not a setting.
 *
 * **Everything else is the tenant's own data and goes complete unless they said otherwise.**
 * `policy` is theirs, defaults to `NO_REDACTION`, and only then does free text get touched.
 *
 * No truncation, unlike `redactArgs`: this is a record of a conversation, and a transcript
 * cut off at two hundred characters is a broken payload rather than a tidy log line.
 */
export const redactPayload = (
  value: unknown,
  policy: RedactionPolicy = NO_REDACTION,
  context: RedactionContext = {},
): unknown => {
  const walk = (key: string, node: unknown, depth: number): unknown => {
    if (SECRET_KEY.test(key)) return "[redacted]";
    if (depth >= 12) return "[deep]";
    if (typeof node === "string") return redactText(node, policy, context).text;
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
