import type { Credential, Signer } from "../connector/vault";
import { EgressRefusedError, type Transport } from "../connector/transport";

import type { EventSubscription, EventType } from "./config";
import { signedHeaders } from "./signature";

/**
 * One attempt at one delivery, and the rules for whether there should be another.
 *
 * Nothing in this file is aware of a call. That is the requirement, not an accident of
 * layering: a delivery failing must never affect a conversation, and the surest way to
 * guarantee that is for the delivery path to have no way to reach one. The call path's
 * entire involvement is writing a row.
 */

/** Exactly what goes on the wire, fixed at the moment the payload was built. */
export interface PendingDelivery {
  readonly id: string;
  readonly type: EventType;
  readonly tenantId: string;
  /** 1 for the first try. Reported to the receiver so they can spot a duplicate cheaply. */
  readonly attempt: number;
  /** Serialised once and stored, so every retry sends identical bytes and signature. */
  readonly body: string;
}

export interface DeliveryOutcome {
  readonly ok: boolean;
  readonly status: number | null;
  /** Null on success. Short: this is shown to a tenant, not to a debugger. */
  readonly error: string | null;
  /** False when trying again could only produce the same answer. */
  readonly retryable: boolean;
  readonly latencyMs: number;
}

export interface DeliveryDeps {
  readonly transport: Transport;
  readonly subscription: EventSubscription;
  readonly signer: Signer;
  /** Optional extra auth the receiver asked for, on top of the signature. */
  readonly credential?: Credential | null;
  readonly now?: () => number;
}

/**
 * Whether a failure is worth repeating.
 *
 * The split is about whose problem it is. A timeout, a refused connection or a 5xx is the
 * receiver having a bad minute and will very likely work later. A 400 or a 422 is us
 * sending something they will never accept, and hammering it for an hour turns our bug
 * into their incident. 408 and 429 are the two 4xx codes that explicitly mean "later".
 */
const retryableStatus = (status: number): boolean =>
  status >= 500 || status === 408 || status === 429;

const shortError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
};

export const deliverOnce = async (
  deps: DeliveryDeps,
  delivery: PendingDelivery,
): Promise<DeliveryOutcome> => {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const timestampSeconds = Math.floor(startedAt / 1000);

  const headers = signedHeaders({
    eventId: delivery.id,
    eventType: delivery.type,
    tenantId: delivery.tenantId,
    attempt: delivery.attempt,
    timestampSeconds,
    body: delivery.body,
    signer: deps.signer,
  });
  // Last possible moment, and into an object rather than through a value anybody holds.
  deps.credential?.applyTo(headers);

  // Our own deadline rather than the transport's: the transport takes the caller's signal
  // precisely so that the voice budget is not baked into it (see connector/transport.ts).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.subscription.timeoutMs);
  timer.unref();

  try {
    const response = await deps.transport.send({
      url: deps.subscription.url,
      method: "POST",
      headers,
      body: delivery.body,
      signal: controller.signal,
    });

    const ok = response.status >= 200 && response.status < 300;
    return {
      ok,
      status: response.status,
      error: ok ? null : `receiver answered ${response.status}`,
      retryable: !ok && retryableStatus(response.status),
      latencyMs: now() - startedAt,
    };
  } catch (error) {
    // A refusal is configuration, not weather: the host is not on the tenant's allowlist,
    // or resolves somewhere it may not reach. Retrying cannot change either.
    const refused = error instanceof EgressRefusedError;
    return {
      ok: false,
      status: null,
      error: shortError(error),
      retryable: !refused,
      latencyMs: now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * When to try again.
 *
 * Exponential from ten seconds, capped at fifteen minutes, with full jitter. The jitter is
 * not decoration: without it every delivery that failed during a receiver's two-minute
 * outage retries in the same millisecond when it comes back, which is how a recovering
 * endpoint gets knocked over by the thing that was waiting for it.
 */
export const nextAttemptDelayMs = (
  attempt: number,
  random: () => number = Math.random,
): number => {
  const base = 10_000 * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(base, 900_000);
  // Full jitter, floored so a retry never lands in the same second as its failure.
  return Math.max(1_000, Math.floor(capped * random()));
};
