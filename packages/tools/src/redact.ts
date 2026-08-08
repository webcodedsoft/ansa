import type { ToolArgs } from "./types";

/**
 * R5.2.1 and R5.2.4: every invocation is logged with its arguments, and credentials are
 * never in logs. Both are true at once only if redaction happens on the way to the log
 * line rather than being left to whoever calls the logger.
 *
 * Key-name matching, not value sniffing. A value-based heuristic passes anything it has
 * not seen before, and the first thing it will not have seen is the tenant's own scheme.
 */
const SECRET_KEY = /(token|secret|password|passwd|auth|api[-_]?key|apikey|credential|bearer|pin|otp|cvv|ssn)/i;

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
