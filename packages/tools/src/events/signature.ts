import { createHmac, timingSafeEqual } from "node:crypto";

import type { Signer } from "../connector/vault";

import type { EventType } from "./config";

/**
 * Proving a delivery came from us.
 *
 * A webhook receiver is a public URL that accepts a POST. Without a signature the only
 * thing standing between an organisation's CRM and a forged "this caller confirmed their
 * policy number" is whether anybody ever learned the URL, and URLs leak — into logs, into
 * proxies, into a screenshot in a support ticket.
 *
 * The scheme is deliberately dull, because a receiver has to be able to implement it in
 * whatever they have, in ten minutes, from the paragraph in `docs/EVENT_WEBHOOKS.md`:
 *
 *   signature = HMAC-SHA256(secret, "v1.<timestamp>.<event id>.<body>")
 *
 * Three things are inside the signed string rather than merely beside it, and each closes
 * something:
 *
 *   - the **timestamp**, so a captured delivery cannot be replayed a week later; the
 *     receiver rejects one that is too old, which it cannot do if the timestamp is
 *     unsigned and therefore editable;
 *   - the **event id**, so a body cannot be moved onto a different delivery;
 *   - the **version prefix**, so the day this scheme changes, old and new are distinguishable
 *     rather than silently interchangeable.
 *
 * The attempt number is deliberately NOT signed. Retries of the same delivery send the
 * identical body and the identical signature, which is what makes at-least-once safe to
 * deduplicate on the event id.
 */

export const SIGNATURE_VERSION = "v1";

export const SIGNATURE_HEADER = "ansa-signature";
export const TIMESTAMP_HEADER = "ansa-timestamp";
export const EVENT_ID_HEADER = "ansa-event-id";
export const EVENT_TYPE_HEADER = "ansa-event-type";
export const TENANT_HEADER = "ansa-tenant-id";
export const ATTEMPT_HEADER = "ansa-delivery-attempt";

export const signingString = (timestampSeconds: number, eventId: string, body: string): string =>
  `${SIGNATURE_VERSION}.${timestampSeconds}.${eventId}.${body}`;

export interface SignedRequest {
  readonly eventId: string;
  readonly eventType: EventType;
  readonly tenantId: string;
  readonly attempt: number;
  readonly timestampSeconds: number;
  readonly body: string;
  readonly signer: Signer;
}

/**
 * The headers a delivery carries.
 *
 * `content-type` is here rather than at the call site so that the bytes signed and the
 * bytes declared cannot drift apart in two files.
 */
export const signedHeaders = (request: SignedRequest): Record<string, string> => ({
  "content-type": "application/json; charset=utf-8",
  "user-agent": "ansa-events/1",
  [EVENT_ID_HEADER]: request.eventId,
  [EVENT_TYPE_HEADER]: request.eventType,
  [TENANT_HEADER]: request.tenantId,
  [TIMESTAMP_HEADER]: String(request.timestampSeconds),
  [ATTEMPT_HEADER]: String(request.attempt),
  [SIGNATURE_HEADER]: `${SIGNATURE_VERSION}=${request.signer.sign(
    signingString(request.timestampSeconds, request.eventId, request.body),
  )}`,
});

/**
 * The receiver's side of the scheme, written here so it is tested against the sender.
 *
 * We do not run this in production — the organisation does, in whatever language they have.
 * It exists so that "a receiver can verify this" is proved by a test rather than asserted
 * in a document, and so the documented pseudocode has something to be checked against.
 */
export const verifySignature = (options: {
  readonly secret: string;
  readonly header: string;
  readonly timestampSeconds: number;
  readonly eventId: string;
  readonly body: string;
  /** Reject anything older than this. The replay window, and it should be minutes. */
  readonly toleranceSeconds?: number;
  readonly nowSeconds?: number;
}): boolean => {
  const [version, offered] = options.header.split("=");
  if (version !== SIGNATURE_VERSION || offered === undefined) return false;

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (Math.abs(now - options.timestampSeconds) > tolerance) return false;

  const expected = createHmac("sha256", options.secret)
    .update(signingString(options.timestampSeconds, options.eventId, options.body), "utf8")
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(offered, "utf8");
  // Length has to match before timingSafeEqual will look at the contents, and comparing
  // lengths first leaks only the length, which the scheme fixes anyway.
  return a.length === b.length && timingSafeEqual(a, b);
};
