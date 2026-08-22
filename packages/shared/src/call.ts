/**
 * Identifier for one call, stable for that call's lifetime and stamped on
 * every log line, event and metric it produces.
 *
 * Branded so a raw string cannot be passed where a call id is expected.
 */
export type CallId = string & { readonly __brand: "CallId" };

export const asCallId = (raw: string): CallId => raw as CallId;

/**
 * Which way the call went.
 *
 * Present because the two lifecycles genuinely differ — an inbound call is answered by
 * definition, an outbound one can ring out, hit voicemail, or be rejected before any audio
 * exists. Not licence to enumerate further call kinds nobody has asked for.
 *
 * Here rather than in `@ansa/telephony`, where it started, because it stopped being a
 * telephony detail the moment anything above the carrier had to branch on it. `packages/tools`
 * refuses account changes on an outbound call, and a tool dispatcher that had to import a
 * telephony package to learn the difference between two strings would be paying for that
 * knowledge with a dependency on the whole carrier surface.
 */
export type CallDirection = "inbound" | "outbound";
