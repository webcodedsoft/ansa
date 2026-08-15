import type { OrganizationId } from "@ansa/shared";

import type { Db } from "./data-source";
import { withOrganization } from "./organization-scope";

/**
 * The outbox behind event webhooks (Slice 6a).
 *
 * The whole reason this table exists rather than an in-memory queue is the sentence "a
 * delivery failing must never affect a call". An in-memory queue satisfies that until the
 * process restarts, at which point every undelivered event is gone and the organisation
 * has a hole in their CRM that nothing in the system can explain. At-least-once means
 * surviving a deploy.
 *
 * The split of responsibilities is deliberate and worth keeping:
 *
 *   the call path   writes one row and forgets it. It never makes a request, never waits,
 *                   never learns whether anything worked.
 *   the sweeper     claims due rows on a timer, posts them, writes down what happened.
 *
 * There is no code path from a receiver's outage back to a conversation, which is a
 * stronger guarantee than any amount of care in an async function.
 */

export interface QueuedEvent {
  readonly organizationId: OrganizationId;
  readonly eventType: string;
  /** The organization's own name for the receiver. */
  readonly subscription: string;
  readonly carrierCallId?: string | null;
  readonly configVersion?: number | null;
  /**
   * The payload, already redacted under the organization's rules and already serialised.
   *
   * Built here rather than at delivery time on purpose. The lifecycle point is the only
   * moment the whole truth is in one place — the handoff summary is reduced from an
   * in-memory journal that will not exist a second later — and fixing the bytes now is
   * what makes every retry byte-identical and therefore safe to deduplicate.
   */
  readonly body: string;
}

export const enqueueEventDelivery = async (
  dataSource: Db,
  event: QueuedEvent,
): Promise<string | null> =>
  withOrganization(dataSource, event.organizationId, async (scope) => {
    const rows = await scope.query<{ id: string }>(
      `insert into event_deliveries
         (organization_id, event_type, subscription, carrier_call_id, config_version, body)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [
        event.organizationId,
        event.eventType,
        event.subscription,
        event.carrierCallId ?? null,
        event.configVersion ?? null,
        event.body,
      ],
    );
    return rows[0]?.id ?? null;
  });

export interface ClaimedDelivery {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly eventType: string;
  readonly subscription: string;
  readonly carrierCallId: string | null;
  readonly configVersion: number | null;
  /** The bytes fixed when the event happened. Identical on every attempt. */
  readonly body: string;
  /** Including this one. 1 on the first attempt. */
  readonly attempts: number;
}

/**
 * Take the next due deliveries, across every organization.
 *
 * Runs outside any organization scope, through the SECURITY DEFINER function in migration 0014 —
 * see the comment there for why that is narrow rather than a hole. Everything downstream of
 * this is scoped again by the organization id the row carries.
 */
export const claimDueEventDeliveries = async (
  dataSource: Db,
  batch: number,
): Promise<readonly ClaimedDelivery[]> => {
  const rows = (await dataSource.query("select * from app.claim_due_event_deliveries($1)", [
    batch,
  ])) as Record<string, unknown>[];

  return rows.map((r) => ({
    id: String(r["id"]),
    organizationId: String(r["organization_id"]) as OrganizationId,
    eventType: String(r["event_type"]),
    subscription: String(r["subscription"]),
    carrierCallId: r["carrier_call_id"] === null ? null : String(r["carrier_call_id"]),
    configVersion: r["config_version"] === null ? null : Number(r["config_version"]),
    body: String(r["body"]),
    attempts: Number(r["attempts"] ?? 1),
  }));
};

export interface DeliveryResult {
  readonly id: string;
  readonly status: "pending" | "delivered" | "failed";
  readonly httpStatus?: number | null;
  readonly error?: string | null;
  /** Only read when the status is `pending`. */
  readonly retryInMs?: number;
}

export const recordEventDeliveryResult = async (
  dataSource: Db,
  result: DeliveryResult,
): Promise<void> => {
  await dataSource.query("select app.record_event_delivery_result($1, $2, $3, $4, $5)", [
    result.id,
    result.status,
    result.httpStatus ?? null,
    result.error ?? null,
    result.retryInMs ?? 0,
  ]);
};

export interface DeliveryRecord {
  readonly id: string;
  readonly eventType: string;
  readonly subscription: string;
  readonly carrierCallId: string | null;
  readonly configVersion: number | null;
  readonly status: string;
  readonly attempts: number;
  readonly lastStatus: number | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
  readonly nextAttemptAt: Date | null;
  /** The exact bytes sent, so "you never sent it" has an answer rather than an opinion. */
  readonly body: string | null;
}

/**
 * A organization's delivery history, newest first, inside their own scope.
 *
 * `body` is included on purpose. The question this table exists to answer is not "did a
 * request happen" but "what did you send me", and a row that records only a status code
 * answers the first and not the second.
 */
export const listEventDeliveries = async (
  dataSource: Db,
  organizationId: OrganizationId,
  limit = 50,
): Promise<readonly DeliveryRecord[]> =>
  withOrganization(dataSource, organizationId, async (scope) => {
    const rows = await scope.query<Record<string, unknown>>(
      `select id, event_type, subscription, carrier_call_id, config_version, status,
              attempts, last_status, last_error, created_at, delivered_at, next_attempt_at, body
         from event_deliveries
        order by created_at desc
        limit $1`,
      [Math.min(limit, 200)],
    );
    return rows.map((r) => ({
      id: String(r["id"]),
      eventType: String(r["event_type"]),
      subscription: String(r["subscription"]),
      carrierCallId: r["carrier_call_id"] === null ? null : String(r["carrier_call_id"]),
      configVersion: r["config_version"] === null ? null : Number(r["config_version"]),
      status: String(r["status"]),
      attempts: Number(r["attempts"] ?? 0),
      lastStatus: r["last_status"] === null ? null : Number(r["last_status"]),
      lastError: r["last_error"] === null ? null : String(r["last_error"]),
      createdAt: r["created_at"] as Date,
      deliveredAt: (r["delivered_at"] as Date | null) ?? null,
      nextAttemptAt: (r["next_attempt_at"] as Date | null) ?? null,
      body: r["body"] === null ? null : String(r["body"]),
    }));
  });

/**
 * Housekeeping, owned by the thing that writes the rows.
 *
 * A delivered payload is a copy of a transcript, so it is subject to the same instinct
 * that drives audio retention: keep it long enough to answer the question it exists for
 * and no longer. Rows that are still pending are never touched however old — a delivery
 * that has been retrying for a day is exactly the one somebody will ask about.
 */
export const purgeSettledEventDeliveries = async (
  dataSource: Db,
  olderThanDays: number,
): Promise<number> => {
  // Through the definer function in 0014: the sweep runs with no organization scope, and RLS
  // would correctly show a connection without one nothing to delete.
  const rows = (await dataSource.query("select app.purge_settled_event_deliveries($1) as removed", [
    Math.max(1, Math.floor(olderThanDays)),
  ])) as { removed: number }[];
  return Number(rows[0]?.removed ?? 0);
};
