import type { CallId } from "./call";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  readonly callId?: CallId;
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /**
   * A logger that stamps `fields` onto every line it writes. Slice 1 uses this for
   * call_id; organization_id joins it the same way in Slice 2 (CLAUDE.md rule 3).
   */
  child(fields: LogFields): Logger;
}

const emit = (level: LogLevel, base: LogFields, message: string, fields?: LogFields): void => {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...base,
    ...fields,
  });
  process.stdout.write(`${line}\n`);
};

export const createLogger = (base: LogFields = {}): Logger => ({
  debug: (message, fields) => emit("debug", base, message, fields),
  info: (message, fields) => emit("info", base, message, fields),
  warn: (message, fields) => emit("warn", base, message, fields),
  error: (message, fields) => emit("error", base, message, fields),
  child: (fields) => createLogger({ ...base, ...fields }),
});
