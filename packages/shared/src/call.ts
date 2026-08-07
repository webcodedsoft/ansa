/**
 * Identifier for one inbound call, stable for that call's lifetime and stamped on
 * every log line, event and metric it produces.
 *
 * Branded so a raw string cannot be passed where a call id is expected.
 */
export type CallId = string & { readonly __brand: "CallId" };

export const asCallId = (raw: string): CallId => raw as CallId;
