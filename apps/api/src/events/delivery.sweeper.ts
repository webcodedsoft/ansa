import {
  claimDueEventDeliveries,
  purgeSettledEventDeliveries,
  recordEventDeliveryResult,
  type ClaimedDelivery,
  type Db,
} from "@ansa/db";
import type { Logger } from "@ansa/shared";
import {
  breakerKey,
  createCircuitBreaker,
  deliverOnce,
  nextAttemptDelayMs,
  type CircuitBreaker,
  type EventType,
  type PreparedSubscription,
  type Transport,
} from "@ansa/tools";
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";

import type { AgentRegistry } from "../tenancy/agent-registry";
import { DATA_SOURCE, LOGGER, ORGANIZATION_REGISTRY } from "../telephony/tokens";

/**
 * The delivery worker.
 *
 * Everything about this file is downstream of one requirement: **a delivery must never
 * touch a call.** It runs on a timer, it has no call in sight, and the only thing it shares
 * with the conversation path is a database and a connection pool. A receiver that hangs for
 * its full timeout costs this sweep a slot and costs no caller anything.
 *
 * The circuit breaker is the Slice 6 one, keyed on `(organizationId, subject)` where the subject
 * is the subscription name rather than a tool. That was written for this: an organisation
 * whose receiver has been down since lunchtime should stop being posted to every fifteen
 * seconds, and it should stop for that receiver rather than for their other one.
 */

/** Often enough that an event feels prompt, rarely enough to be invisible in the logs. */
const SWEEP_EVERY_MS = 15_000;
/** How many deliveries one pass will take. Bounded so a backlog drains steadily. */
const BATCH = 20;
/** How long a settled delivery is kept. It holds a copy of a transcript; see 0014. */
const KEEP_SETTLED_DAYS = 30;
/** Once a day, roughly: this is measured in days and the exact hour is not interesting. */
const PURGE_EVERY_SWEEPS = Math.round((24 * 60 * 60 * 1000) / SWEEP_EVERY_MS);

const isEventType = (value: string): value is EventType =>
  value === "call.ended" || value === "call.transferred";

@Injectable()
export class EventDeliverySweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private sweeps = 0;
  private readonly breaker: CircuitBreaker = createCircuitBreaker();

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: Db | null,
    @Inject(ORGANIZATION_REGISTRY) private readonly organizations: AgentRegistry,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.dataSource === null) {
      // No database means no outbox, so there is nothing to deliver and nothing to say
      // beyond this. Event webhooks are unavailable rather than silently broken.
      this.log.warn("no database: event webhooks cannot be delivered");
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, SWEEP_EVERY_MS);
    // Never a reason to hold the process open for this.
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. Returns what it did so a test can assert on it rather than on a log line.
   *
   * Never throws and never lets one delivery's problem become another's: this runs beside
   * live calls and a failure at 4am is not worth a restart.
   */
  async sweep(): Promise<{ readonly delivered: number; readonly failed: number; readonly retrying: number }> {
    const db = this.dataSource;
    if (db === null || this.running) return { delivered: 0, failed: 0, retrying: 0 };
    this.running = true;
    this.sweeps += 1;

    let delivered = 0;
    let failed = 0;
    let retrying = 0;

    try {
      const due = await claimDueEventDeliveries(db, BATCH);
      // Sequential rather than parallel. A backlog is usually one receiver having a bad
      // afternoon, and twenty simultaneous requests at a struggling endpoint is how a
      // recovering service gets knocked back over.
      for (const delivery of due) {
        const outcome = await this.attempt(db, delivery);
        if (outcome === "delivered") delivered += 1;
        else if (outcome === "failed") failed += 1;
        else retrying += 1;
      }

      if (this.sweeps % PURGE_EVERY_SWEEPS === 0) {
        const removed = await purgeSettledEventDeliveries(db, KEEP_SETTLED_DAYS);
        if (removed > 0) this.log.info("purged settled event deliveries", { removed });
      }
    } catch (error) {
      this.log.error("event delivery sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }

    return { delivered, failed, retrying };
  }

  /**
   * Finds the receiver this row was queued for, as it is configured now.
   *
   * The payload is fixed and the routing is not, which is the right way round. If a organization
   * removed a receiver between the event and the retry, they no longer want it delivered;
   * if they corrected its URL, the retry should go to the corrected one.
   */
  private async receiverFor(
    delivery: ClaimedDelivery,
    type: EventType,
  ): Promise<{ readonly prepared: PreparedSubscription; readonly transport: Transport } | null> {
    const organization = await this.organizations.load(delivery.organizationId);
    if (organization === null || organization.events.empty) return null;
    const prepared = organization.events
      .subscribersTo(type)
      .find((entry) => entry.subscription.name === delivery.subscription);
    if (prepared === undefined) return null;
    return { prepared, transport: organization.events.transport };
  }

  private async attempt(
    db: Db,
    delivery: ClaimedDelivery,
  ): Promise<"delivered" | "failed" | "retrying"> {
    const log = this.log.child({ organizationId: delivery.organizationId });

    // A row written by a newer version of this process than the one draining the queue.
    // Refused rather than guessed at: an event type we cannot name is one we cannot route.
    const type = isEventType(delivery.eventType) ? delivery.eventType : null;

    let found: { prepared: PreparedSubscription; transport: Transport } | null = null;
    if (type !== null) {
      try {
        found = await this.receiverFor(delivery, type);
      } catch (error) {
        log.error("could not load configuration for a queued delivery", {
          delivery: delivery.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (type === null || found === null) {
      // The receiver is gone, renamed, or was never valid. Recorded as failed with a
      // reason rather than retried forever against configuration that no longer exists.
      await this.settle(db, delivery, {
        status: "failed",
        error: "no receiver configured under that name any more",
      });
      return "failed";
    }

    const key = breakerKey(delivery.organizationId, delivery.subscription);
    if (!this.breaker.allows(key)) {
      // Not a failure and not an attempt. Put it back with a short delay: the circuit will
      // half-open shortly and this row should be there when it does.
      await this.settle(db, delivery, {
        status: "pending",
        error: "receiver circuit open",
        retryInMs: nextAttemptDelayMs(1),
      });
      return "retrying";
    }

    const outcome = await deliverOnce(
      {
        // The organization's own prepared transport: one egress guard, one allowlist, one
        // address-pinned socket. There is no second HTTP client in this product.
        transport: found.transport,
        subscription: found.prepared.subscription,
        signer: found.prepared.signer,
        credential: found.prepared.credential,
      },
      {
        id: delivery.id,
        type,
        organizationId: delivery.organizationId,
        attempt: delivery.attempts,
        body: delivery.body,
      },
    );

    if (outcome.ok) {
      this.breaker.succeeded(key);
      await this.settle(db, delivery, { status: "delivered", httpStatus: outcome.status });
      log.info("event delivered", {
        delivery: delivery.id,
        event: delivery.eventType,
        subscription: delivery.subscription,
        attempt: delivery.attempts,
        latencyMs: outcome.latencyMs,
      });
      return "delivered";
    }

    this.breaker.failed(key);
    const exhausted = delivery.attempts >= found.prepared.subscription.maxAttempts;
    if (!outcome.retryable || exhausted) {
      await this.settle(db, delivery, {
        status: "failed",
        httpStatus: outcome.status,
        error: outcome.error,
      });
      log.error("event delivery given up on", {
        delivery: delivery.id,
        event: delivery.eventType,
        subscription: delivery.subscription,
        attempts: delivery.attempts,
        status: outcome.status,
        // The receiver's answer, not the payload. What was sent is on the row.
        detail: outcome.error,
      });
      return "failed";
    }

    await this.settle(db, delivery, {
      status: "pending",
      httpStatus: outcome.status,
      error: outcome.error,
      retryInMs: nextAttemptDelayMs(delivery.attempts),
    });
    return "retrying";
  }

  private async settle(
    db: Db,
    delivery: ClaimedDelivery,
    result: {
      status: "pending" | "delivered" | "failed";
      httpStatus?: number | null;
      error?: string | null;
      retryInMs?: number;
    },
  ): Promise<void> {
    try {
      await recordEventDeliveryResult(db, { id: delivery.id, ...result });
    } catch (error) {
      // The row keeps the two-minute claim window from 0014 and will be picked up again.
      // At-least-once survives this; losing the delivery would not.
      this.log.error("could not record the outcome of an event delivery", {
        delivery: delivery.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
